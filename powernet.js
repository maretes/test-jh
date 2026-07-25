'use strict';
/**
 * PowerNet — протокол плати розвозчика сіна.
 * Порт з PowerNetDriver.dll (JHAgroPanelApp v2.2.294).
 * CRC-таблиця звірена з таблицею всередині DLL: збіг 256/256.
 */

const FLAG = 0x7e; // прапорець кадру
const ESC = 0x7d; // escape

const MSG = { REQUEST: 0, REPLY: 1, BROADCAST: 3 };
const RW = { READ: 0, WRITE: 1 };

const REG = {
  KEEPALIVE: 1,
  VERSIONS: 3,
  BOARD_ERROR: 4,
  MOTOR_STATUS: 5,
  MOTOR_SETTINGS: 7,
  SENSORS: 11,
  FOOD_WEIGHT: 12,
  ANALOG_IN: 14,
  DIGITAL_IN: 15,
};

const LOCAL_ADDR = 0;
const REMOTE_ADDR = 1;

// ---------------------------------------------------------------- CRC-16
const FCS_TABLE = (() => {
  const t = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let v = i;
    for (let b = 0; b < 8; b++) v = v & 1 ? (v >>> 1) ^ 0x8408 : v >>> 1;
    t[i] = v & 0xffff;
  }
  return t;
})();

function crc16(buf, start, end) {
  let crc = 0xffff;
  for (let i = start; i < end; i++) {
    crc = ((crc >>> 8) ^ FCS_TABLE[(crc ^ buf[i]) & 0xff]) & 0xffff;
  }
  return crc;
}

// ---------------------------------------------------------------- кадр
function buildFrame(data, register, opts = {}) {
  const {
    local = LOCAL_ADDR,
    remote = REMOTE_ADDR,
    msgType = MSG.REQUEST,
    rw = RW.WRITE,
  } = opts;

  const n = data.length;
  const buf = new Uint8Array(n + 8);
  buf[0] = FLAG;
  buf[1] = ((local << 3) | (remote >> 2)) & 0xff;
  buf[2] = (((remote << 6) & 0xff) | register) & 0xff;
  buf[3] = ((msgType << 6) | (rw === RW.WRITE ? 0x20 : 0)) & 0xff;
  buf[4] = n;
  buf.set(data, 5);

  const crc = crc16(buf, 1, buf.length - 3);
  buf[buf.length - 3] = crc & 0xff; // LSB перший
  buf[buf.length - 2] = (crc >>> 8) & 0xff; // MSB
  buf[buf.length - 1] = FLAG;

  // байт-стаффінг усього між прапорцями
  const out = [buf[0]];
  for (let i = 1; i < buf.length - 1; i++) {
    const b = buf[i];
    if (b === FLAG) out.push(ESC, 0x5e);
    else if (b === ESC) out.push(ESC, 0x5d);
    else out.push(b);
  }
  out.push(buf[buf.length - 1]);
  return Buffer.from(out);
}

function unstuff(frame) {
  const body = frame.slice(1, -1);
  const out = [];
  for (let i = 0; i < body.length; i++) {
    if (body[i] === ESC && i + 1 < body.length) {
      out.push(body[i + 1] === 0x5e ? FLAG : ESC);
      i++;
    } else out.push(body[i]);
  }
  return Buffer.from(out);
}

/** Розібрати отриманий кадр. Повертає null, якщо CRC не збігся. */
function parseFrame(frame) {
  if (frame.length < 8) return null;
  const b = unstuff(frame);
  if (b.length < 7) return null;

  const got = b[b.length - 2] | (b[b.length - 1] << 8);
  const check = Buffer.concat([Buffer.from([0]), b.slice(0, -2)]);
  if (crc16(check, 1, check.length) !== got) return null;

  return {
    localAddress: b[0] >> 3,
    remoteAddress: ((b[0] & 0x07) << 2) | (b[1] >> 6),
    register: b[1] & 0x3f,
    messageType: b[2] >> 6,
    isWrite: (b[2] & 0x20) !== 0,
    data: b.slice(4, 4 + b[3]),
  };
}

/** Витягти повні кадри з потоку. Повертає {frames, rest}. */
function extractFrames(stream) {
  const frames = [];
  let start = -1;
  let last = 0;
  for (let i = 0; i < stream.length; i++) {
    if (stream[i] !== FLAG) continue;
    if (start === -1) {
      start = i;
    } else if (i - start >= 7) {
      frames.push(stream.slice(start, i + 1));
      last = i + 1;
      start = -1;
    } else {
      start = i; // надто коротко — це був початок нового кадру
    }
  }
  const rest = start !== -1 ? stream.slice(start) : stream.slice(last);
  return { frames, rest };
}

// ---------------------------------------------------------------- команди
/**
 * status    1 = рух, 0 = стоп
 * direction 0 / 1  (звірити на своїй машині!)
 */
function motorFrame({
  motorId = 0,
  status = 0,
  speed = 0,
  direction = 0,
  power = 0,
  powerDelay = 0,
  rampUp = 0,
  rampDown = 0,
  ev = null,
}) {
  const data = [
    motorId & 0xff,
    (ev === null ? status : ev) & 0xff,
    status & 0xff,
    power & 0xff,
    powerDelay & 0xff,
    speed & 0xff,
    rampUp & 0xff,
    rampDown & 0xff,
    direction & 0xff,
  ];
  return buildFrame(data, REG.MOTOR_SETTINGS);
}

function readFrame(register) {
  return buildFrame([], register, { rw: RW.READ });
}

// ---------------------------------------------------------------- декодери
function decodeMotorStatus(d) {
  return {
    motorId: d[0],
    status: d[1],
    power: d[2],
    powerDelay: d[3],
    speed: d[4],
    rampUp: d[5],
    rampDown: d[6],
    direction: d[7],
  };
}

function decodeSensors(d) {
  return {
    inHomeMarker: !!d[0],
    inPosMarker: !!d[1],
    fullSensorOpen: !!d[2],
    emptySensorOpen: !!d[3],
    frontSensorOpen: !!d[4],
    positionCounter: d[5] | (d[6] << 8),
  };
}

function decodeDigitalInputs(d) {
  return {
    stopButton: !!d[0],
    resetButton: !!d[1],
    emergencyStop: !!d[2],
    weightingInput: !!d[3],
  };
}

module.exports = {
  FLAG, ESC, MSG, RW, REG, LOCAL_ADDR, REMOTE_ADDR,
  crc16, buildFrame, unstuff, parseFrame, extractFrames,
  motorFrame, readFrame,
  decodeMotorStatus, decodeSensors, decodeDigitalInputs,
};
