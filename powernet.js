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
  MOTOR_STATUS: 5, // R: статус "поточного" мотора; W: ResetErrorMask
  MOTOR_STATUS_BY_ID: 6,
  MOTOR_SETTINGS: 7,
  IR_STATE: 8,
  ALARM_STATE: 9,
  IMPULSE_OUT: 10,
  SENSORS: 11,
  FOOD_WEIGHT: 12,
  ACTUATORS: 13,
  ANALOG_IN: 14,
  DIGITAL_IN: 15,
  CHARGE_STATE: 16,
  MOTOR_STATE: 17, // силове реле моторів
  SPARE_OUT1: 18,
  WIRELESS_TABLE: 19,
  RESET_SWITCH_ZONE: 20,
  SWITCH_AMOUNT: 21,
  WIRELESS_ACK: 22,
  SWITCH_ZONE_STATE: 23,
  MOTOR_REQ_MASK: 25,
  WIRELESS_STATE: 26,
  WIRELESS_CMD: 28, // пряма адресна команда вузлу (стрілка/погрузчик)
  WIRELESS_EVENT: 29,
  // Регістр 2 (ForceToBootloaderMode) навмисно відсутній — не чіпати.
};

// Бітові маски MotorID (register 7/25) — не послідовні номери!
// Підтверджено дизасемблюванням Drive/DischargeFeed ctor у v2.2.311.
const MOTOR_IDS = {
  Drive1: 1,
  Drive2: 2,
  Extra: 4,
  Shredder: 8,
  Conveyor: 16,
  RightPlate: 32,
  LeftPlate: 64,
};

// Прямі адресні команди вузла (регістр 28). 1/2 = положення A/B, 0 = стоп
// (недокументоване значення, виведене з коду StateHopper — не перевірено
// на залізі). Решта — зі словника EWirelessState.
const WIRELESS_CMD = {
  STOP: 0,
  POSITION_A: 1,
  POSITION_B: 2,
  CHECK_IN: 1,
  SET_WAY: 2,
  CHECK_OUT: 3,
  RESET: 4,
  SET_SW_AMOUNT: 5,
  GET_CARD_ID: 6,
  PING: 7,
  SEND_DIRECTION: 8,
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
  if (b.length < 6) return null;

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

/** Запит статусу конкретного мотора за MotorID (регістр 6). */
function motorStatusByIdFrame(motorId) {
  return buildFrame([motorId & 0xff], REG.MOTOR_STATUS_BY_ID, { rw: RW.READ });
}

/** Скид масок помилок (регістр 5, запис). */
function resetErrorMaskFrame({
  resetIntError = false,
  resetSafetyStop = false,
  resetMotorLostComm = false,
  resetMotorProtect = false,
} = {}) {
  const data = [resetIntError, resetSafetyStop, resetMotorLostComm, resetMotorProtect].map((b) =>
    b ? 1 : 0
  );
  return buildFrame(data, REG.MOTOR_STATUS, { rw: RW.WRITE });
}

/** ІЧ-канал (регістр 8): enable + час (мс, 16 біт). */
function irFrame({ enable = false, time = 0 }) {
  return buildFrame([enable ? 1 : 0, time & 0xff, (time >>> 8) & 0xff], REG.IR_STATE);
}

/** Сирена (регістр 9). */
function alarmFrame(on) {
  return buildFrame([on ? 1 : 0], REG.ALARM_STATE);
}

/** Два імпульсні виходи (регістр 10). */
function impulseOutFrame(out1, out2) {
  return buildFrame([out1 ? 1 : 0, out2 ? 1 : 0], REG.IMPULSE_OUT);
}

/** Два актуатори на візку (регістр 13). */
function actuatorsFrame(a1, a2) {
  return buildFrame([a1 ? 1 : 0, a2 ? 1 : 0], REG.ACTUATORS);
}

/** Реле заряду (регістр 16). */
function chargeFrame(on) {
  return buildFrame([on ? 1 : 0], REG.CHARGE_STATE);
}

/** Силове реле моторів (регістр 17) — маст-тумблер, без нього мотори не рухаються. */
function motorPowerFrame(on) {
  return buildFrame([on ? 1 : 0], REG.MOTOR_STATE);
}

/** Запасний вихід (регістр 18). */
function spareOutFrame(on) {
  return buildFrame([on ? 1 : 0], REG.SPARE_OUT1);
}

/** Скид зони стрілок (регістр 20, 3 байти — семантика полів не з'ясована). */
function resetSwitchZoneFrame(bytes = [0, 0, 0]) {
  return buildFrame([bytes[0] & 0xff, bytes[1] & 0xff, bytes[2] & 0xff], REG.RESET_SWITCH_ZONE);
}

/** Кількість стрілок (регістр 21, запис, 2 байти). */
function switchAmountFrame(count) {
  return buildFrame([count & 0xff, (count >>> 8) & 0xff], REG.SWITCH_AMOUNT);
}

/** Маска задіяних моторів (регістр 25, бітова, як MOTOR_IDS). */
function motorReqMaskFrame(mask) {
  return buildFrame([mask & 0xff, (mask >>> 8) & 0xff], REG.MOTOR_REQ_MASK);
}

/**
 * Пряма адресна команда вузлу (регістр 28) — стрілка або погрузчик.
 * command: 1/2 = положення A/B (RailSwitcher/StandaloneSwitch/Hopper),
 * 0 = стоп (неперевірено на залізі), 6 = GetCardId, 7 = Ping, і т.д.
 */
function wirelessCommandFrame(address, command) {
  return buildFrame([address & 0xff, command & 0xff], REG.WIRELESS_CMD);
}

/**
 * Таблиця зони стрілок (регістр 19). switches — масив об'єктів
 * {index (1-based, 1..20), position (0/1), update (bool), block (bool)}.
 * Тільки стрілки з update=true будуть змінені вузлом; решта лишаються як є.
 * cmd: 1=CheckIn, 2=SetWay, 3=CheckOut (WIRELESS_CMD.CHECK_IN/SET_WAY/CHECK_OUT).
 */
function wirelessTableFrame(cmd, switches = [], timeout = 20) {
  const table = new Array(10).fill(0);
  for (const sw of switches) {
    if (!sw || !sw.index || sw.index < 1 || sw.index > 20) continue;
    const byteIndex = Math.floor((sw.index - 1) / 2);
    const shift = (sw.index - 1) % 2 === 0 ? 0 : 4;
    let bits = 0;
    if (sw.position) bits |= 0x01;
    if (sw.update) bits |= 0x02;
    if (sw.block) bits |= 0x04;
    table[byteIndex] |= bits << shift;
  }
  return buildFrame([cmd & 0xff, ...table, timeout & 0xff], REG.WIRELESS_TABLE);
}

// ---------------------------------------------------------------- декодери
/** Регістр 6, відповідь: 7 байт, БЕЗ ехо MotorID (плата знає, ти й так питав
 * конкретний ID) — підтверджено живим кадром, не 8 байт, як гадали раніше. */
function decodeMotorStatus(d) {
  return {
    status: d[0],
    power: d[1],
    powerDelay: d[2],
    speed: d[3],
    rampUp: d[4],
    rampDown: d[5],
    direction: d[6],
  };
}

// Регістр 11, відповідь: РІВНО 2 байти (не 7, як гадали раніше за назвами
// полів у CLAUDE.md §7). Підтверджено з IL (BoardProtocolProvider,
// MessageInductiveOpticalSensor) — п'ять булевих прапорців упаковані в один
// байт-бітове поле, PositionMarkerCounter — uint8 (не uint16):
//   d[0]: біт0=IsInHomeMarker, біт1=IsInPosMarker, біт2=IsFullSensorOpen,
//         біт3=IsEmptySensorOpen, біт4=IsFrontSensorOpen
//   d[1]: PositionMarkerCounter (0-255, з переповненням)
// Звірено з живим кадром із плати: data=[12,16] -> fullSensorOpen+
// emptySensorOpen=true, лічильник=16.
function decodeSensors(d) {
  const b = d[0];
  return {
    inHomeMarker: !!(b & 0x01),
    inPosMarker: !!(b & 0x02),
    fullSensorOpen: !!(b & 0x04),
    emptySensorOpen: !!(b & 0x08),
    frontSensorOpen: !!(b & 0x10),
    positionCounter: d[1],
  };
}

// Регістр 15, відповідь: РІВНО 1 байт (не 6, як гадали раніше) — бітове поле,
// підтверджено з IL (BoardProtocolProvider, MessageDigitalInputs):
//   біт0=StopButton, біт1=ResetButton, біт2=EmergencyStopButton,
//   біт3=WeightingInput, біт4=SpareInput1, біт5=SpareInput2
function decodeDigitalInputs(d) {
  const b = d[0];
  return {
    stopButton: !!(b & 0x01),
    resetButton: !!(b & 0x02),
    emergencyStop: !!(b & 0x04),
    weightingInput: !!(b & 0x08),
    spareInput1: !!(b & 0x10),
    spareInput2: !!(b & 0x20),
  };
}

/** Регістр 4 — маски помилок. Побітова розшифровка не з'ясована (CLAUDE.md §12.3). */
function decodeBoardError(d) {
  const u16 = (i) => d[i] | (d[i + 1] << 8);
  return {
    internalErrorMask: d.length >= 2 ? u16(0) : null,
    motorLostCommunMask: d.length >= 4 ? u16(2) : null,
    motorProtectionTriggeringMask: d.length >= 6 ? u16(4) : null,
    raw: [...d],
  };
}

/**
 * Регістр 14 — аналогові входи. Байтова ширина полів не підтверджена в IL;
 * якщо прийшло >=12 байт, читаємо як 6 uint16 LE, інакше віддаємо сирі байти.
 * Значення потребують звірки на залізі.
 */
function decodeAnalogIn(d) {
  if (d.length >= 12) {
    const u16 = (i) => d[i] | (d[i + 1] << 8);
    return {
      voltageInput1: u16(0),
      voltageInput2: u16(2),
      voltageInput3: u16(4),
      voltageCharge: u16(6),
      currentInput1: u16(8),
      currentInput2: u16(10),
      raw: [...d],
    };
  }
  return { raw: [...d] };
}

/** Регістр 3 — версії SW/HW. Точний формат не підтверджений, віддаємо сирі байти. */
function decodeVersions(d) {
  return { raw: [...d] };
}

/** Регістр 22 — підтвердження від вузла (WirelessACK). */
function decodeWirelessAck(d) {
  return {
    status: d[0],
    nodeId: d[1],
    relayStatus: d[2],
    switchPosition: d[3],
  };
}

/** Регістр 26 — стан радіомодуля. */
function decodeWirelessState(d) {
  return { state: d[0], lastCommand: d[1] };
}

/** Регістр 29 — подія від радіо (GetEventWirelessCommand). */
function decodeWirelessEvent(d) {
  return { lastAddr: d[0], state: d[1] };
}

/** Регістр 23 — стан поточної зони стрілок. Формат не з'ясований, сирі байти. */
function decodeSwitchZoneState(d) {
  return { raw: [...d] };
}

/**
 * Регістр 1 — keepalive: 2 байти, "звʼязок + напруга АКБ".
 * Формат підтверджено на живій платі: big-endian, мілівольти.
 * [97,34] -> 24.866В, [96,108] -> 24.684В — узгоджено з 24В системою.
 */
function decodeKeepAlive(d) {
  if (d.length >= 2) {
    return { voltage: ((d[0] << 8) | d[1]) / 1000, raw: [...d] };
  }
  return { raw: [...d] };
}

/** Регістр 12 — вага корму. Формат байтів не підтверджений в IL (float32 LE — припущення). */
function decodeFoodWeight(d) {
  if (d.length >= 4) {
    return { weight: Buffer.from(d).readFloatLE(0), raw: [...d] };
  }
  return { raw: [...d] };
}

module.exports = {
  FLAG, ESC, MSG, RW, REG, LOCAL_ADDR, REMOTE_ADDR, MOTOR_IDS, WIRELESS_CMD,
  crc16, buildFrame, unstuff, parseFrame, extractFrames,
  motorFrame, readFrame, motorStatusByIdFrame, resetErrorMaskFrame,
  irFrame, alarmFrame, impulseOutFrame, actuatorsFrame, chargeFrame,
  motorPowerFrame, spareOutFrame, resetSwitchZoneFrame, switchAmountFrame,
  motorReqMaskFrame, wirelessCommandFrame, wirelessTableFrame,
  decodeMotorStatus, decodeSensors, decodeDigitalInputs, decodeBoardError,
  decodeAnalogIn, decodeVersions, decodeWirelessAck, decodeWirelessState,
  decodeWirelessEvent, decodeSwitchZoneState, decodeFoodWeight, decodeKeepAlive,
};
