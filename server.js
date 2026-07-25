'use strict';
/**
 * Керуюче ядро тестової панелі розвозчика.
 *
 * Володіє COM-портом і НІКОЛИ не залежить від інтерфейсу:
 * якщо браузер завис, закрився чи згорів Wi-Fi — усе, що рухається, зупиняється саме.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const pn = require('./powernet');

// ---------------------------------------------------------------- налаштування
const PORT_NAME = process.env.PORT_NAME || 'COM3'; // Linux: /dev/ttyUSB0
// Підтверджено скануванням на живій платі (COM1 @ 115200 дав валідну
// відповідь на keepalive). Раніша "тиша" на 115200 була через те, що
// заводський застосунок тримав порт одночасно (два майстри на лінії).
const BAUD = Number(process.env.BAUD) || 115200;
const HTTP_PORT = Number(process.env.HTTP_PORT) || 8080;
const MOCK = process.env.MOCK === '1' || process.argv.includes('--mock');

const KEEPALIVE_MS = 300; // плата чекає регулярних повідомлень
const POLL_MS = 150; // опитування датчиків/моторів по черзі
const DEADMAN_MS = 1500; // немає сигналу від UI довше цього — стоп
const REPLY_TIMEOUT = 200;

// Реальний калібрувальний ліміт струму (MotorDriveMaxPower) з живого
// Settings.xml цієї машини (%APPDATA%\JHAgroPanelApp\Settings\Settings.xml),
// звірено з масивом Motors[] у JHAgroPanelApp.il (MotorMaskDrive/PowerDelay/
// RampUp/RampDown в тому ж порядку індексів). Раніше тут був один спільний
// power=60 за замовчуванням для всіх моторів — ВИЩЕ за реальний ліміт
// Extra/RightPlate/LeftPlate (15), тобто дефолт фактично вимикав захист по
// струму саме для найслабших моторів, поки оператор не встигав його опустити.
const MOTOR_POWER_DEFAULT = {
  Drive1: 44,
  Drive2: 44,
  Extra: 15,
  Conveyor: 36,
  Shredder: 44,
  RightPlate: 15,
  LeftPlate: 15,
};

// ---------------------------------------------------------------- стан
function initialMotors() {
  const motors = {};
  for (const [name, motorId] of Object.entries(pn.MOTOR_IDS)) {
    motors[motorId] = { motorId, name, running: false, speed: 0, direction: 0, power: MOTOR_POWER_DEFAULT[name] ?? 15 };
  }
  return motors;
}

const state = {
  link: false,
  portName: MOCK ? '(mock)' : PORT_NAME,
  mock: MOCK,
  motorPower: false, // рег.17 — силове реле моторів, маст-тумблер
  motors: initialMotors(), // motorId -> намір користувача
  feedback: {}, // motorId -> останній декодований статус з плати (рег.6)
  sensors: null, // рег.11
  inputs: null, // рег.15
  analog: null, // рег.14
  boardError: null, // рег.4
  foodWeight: null, // рег.12
  versions: null, // рег.3
  battery: null, // рег.1 keepalive — сирі байти + кандидати формул (не підтверджено)
  io: {
    actuator1: false, actuator2: false, // рег.13
    impulse1: false, impulse2: false, // рег.10
    alarm: false, // рег.9
    charge: false, // рег.16
    spareOut: false, // рег.18
    ir: false, irTime: 0, // рег.8
  },
  wireless: { ack: null, state: null, event: null, zoneState: null },
  frameLog: [], // останні кадри tx/rx для журналу налагодження
  lastError: null,
  lastReplyAt: 0,
};

let port = null;
let lastUiPing = 0;
let rxBuffer = Buffer.alloc(0);

// ---------------------------------------------------------------- журнал кадрів
const FRAME_LOG_MAX = 80;
function logFrame(dir, frame, extra) {
  const hex = [...frame].map((b) => b.toString(16).padStart(2, '0')).join(' ');
  state.frameLog.push({ ts: Date.now(), dir, hex, ...extra });
  if (state.frameLog.length > FRAME_LOG_MAX) state.frameLog.shift();
}

// ---------------------------------------------------------------- черга запису
// Порт один, тож кадри не можна змішувати — усе йде послідовно.
let chain = Promise.resolve();

function send(frame) {
  logFrame('tx', frame);
  chain = chain.then(
    () =>
      new Promise((resolve) => {
        if (!port || !port.isOpen) return resolve(null);
        const started = Date.now();
        port.write(frame, (err) => {
          if (err) {
            state.lastError = err.message;
            return resolve(null);
          }
          port.drain(() => setTimeout(resolve, 0));
        });
        void started;
      })
  );
  return chain;
}

// ---------------------------------------------------------------- прийом
function onData(chunk) {
  rxBuffer = Buffer.concat([rxBuffer, chunk]);
  if (rxBuffer.length > 4096) rxBuffer = rxBuffer.slice(-1024);

  const { frames, rest } = pn.extractFrames(rxBuffer);
  rxBuffer = rest;

  for (const raw of frames) {
    const msg = pn.parseFrame(raw);
    if (!msg) continue; // биті кадри просто ігноруємо

    state.link = true;
    state.lastReplyAt = Date.now();
    logFrame('rx', raw, { register: msg.register });

    try {
      switch (msg.register) {
        case pn.REG.KEEPALIVE:
          if (msg.data.length >= 2) state.battery = pn.decodeKeepAlive(msg.data);
          break;
        case pn.REG.MOTOR_STATUS_BY_ID:
          if (!msg.isWrite && msg.data.length >= 7 && pendingMotorStatusId !== null) {
            state.feedback[pendingMotorStatusId] = pn.decodeMotorStatus(msg.data);
            pendingMotorStatusId = null;
          }
          break;
        case pn.REG.SENSORS:
          // Рег.11 реально повертає 2 байти, не 7 — виправлено після
          // першого живого тесту (CLAUDE.md §7), decodeSensors тепер сам
          // читає з d[0]/d[1].
          if (msg.data.length >= 2) state.sensors = pn.decodeSensors(msg.data);
          break;
        case pn.REG.DIGITAL_IN:
          // Рег.15 реально повертає 1 байт, не 4+ — і StopButton
          // ІНВЕРТОВАНИЙ: 1 = контур цілий/ОК, 0 = реально зупинено.
          // Підтверджено з IL (FeedingSystem: EmergencystopState =
          // (StopButton==1) ? false : true). EmergencyStopButton/
          // ResetButton у застосунку ніде НЕ гейтують рух напряму.
          if (msg.data.length >= 1) {
            state.inputs = pn.decodeDigitalInputs(msg.data);
            if (!state.inputs.stopButton) {
              haltAllMotion('контур Stop/E-Stop розімкнено (StopButton=0)');
            }
          }
          break;
        case pn.REG.ANALOG_IN:
          state.analog = pn.decodeAnalogIn(msg.data);
          break;
        case pn.REG.BOARD_ERROR:
          state.boardError = pn.decodeBoardError(msg.data);
          break;
        case pn.REG.FOOD_WEIGHT:
          state.foodWeight = pn.decodeFoodWeight(msg.data);
          break;
        case pn.REG.VERSIONS:
          state.versions = pn.decodeVersions(msg.data);
          break;
        case pn.REG.WIRELESS_ACK:
          state.wireless.ack = pn.decodeWirelessAck(msg.data);
          break;
        case pn.REG.WIRELESS_STATE:
          state.wireless.state = pn.decodeWirelessState(msg.data);
          break;
        case pn.REG.WIRELESS_EVENT:
          state.wireless.event = pn.decodeWirelessEvent(msg.data);
          break;
        case pn.REG.SWITCH_ZONE_STATE:
          state.wireless.zoneState = pn.decodeSwitchZoneState(msg.data);
          break;
      }
    } catch (e) {
      state.lastError = e.message;
    }
  }
}

// ---------------------------------------------------------------- безпека
function canMove() {
  return state.link && !(state.inputs && !state.inputs.stopButton);
}

// ---------------------------------------------------------------- мотори
function applyMotor(motorId) {
  const m = state.motors[motorId];
  if (!m) return Promise.resolve();
  return send(
    pn.motorFrame({
      motorId: m.motorId,
      status: m.running ? 1 : 0,
      speed: m.running ? m.speed : 0,
      direction: m.direction,
      power: m.power,
    })
  );
}

function stopMotor(motorId, reason) {
  const m = state.motors[motorId];
  if (!m) return Promise.resolve();
  if (m.running) {
    m.running = false;
    m.speed = 0;
    if (reason) state.lastError = `Зупинено (${m.name}): ${reason}`;
  }
  return applyMotor(motorId);
}

function stopAllMotors(reason) {
  return Promise.all(Object.keys(state.motors).map((id) => stopMotor(Number(id), reason)));
}

/** Повна зупинка всього, що може рухатись: мотори + актуатори + імпульси + ІЧ. */
function haltAllMotion(reason) {
  stopAllMotors(reason);
  if (state.io.actuator1 || state.io.actuator2) {
    state.io.actuator1 = false;
    state.io.actuator2 = false;
    send(pn.actuatorsFrame(false, false));
  }
  if (state.io.impulse1 || state.io.impulse2) {
    state.io.impulse1 = false;
    state.io.impulse2 = false;
    send(pn.impulseOutFrame(false, false));
  }
  if (state.io.ir) {
    state.io.ir = false;
    send(pn.irFrame({ enable: false }));
  }
  if (reason) state.lastError = `Аварійна зупинка: ${reason}`;
}

// ---------------------------------------------------------------- цикли
const STATIC_POLL_REGS = [
  pn.REG.SENSORS,
  pn.REG.DIGITAL_IN,
  pn.REG.ANALOG_IN,
  pn.REG.BOARD_ERROR,
  pn.REG.FOOD_WEIGHT,
  pn.REG.WIRELESS_ACK,
  pn.REG.WIRELESS_STATE,
  pn.REG.WIRELESS_EVENT,
  pn.REG.SWITCH_ZONE_STATE,
];
const motorIds = Object.keys(state.motors).map(Number);
let pollIndex = 0;
// рег.6 не ехоїть MotorID у відповіді — трекаємо, якого мотора питали
// останнім (опитування послідовне, один запит за раз)
let pendingMotorStatusId = null;

function pollOnce() {
  const totalSlots = STATIC_POLL_REGS.length + motorIds.length;
  const slot = pollIndex++ % totalSlots;
  if (slot < STATIC_POLL_REGS.length) {
    send(pn.readFrame(STATIC_POLL_REGS[slot]));
  } else {
    const motorId = motorIds[slot - STATIC_POLL_REGS.length];
    pendingMotorStatusId = motorId;
    send(pn.motorStatusByIdFrame(motorId));
  }
}

// Реальний застосунок при старті шле цю маску (рег.25) ДО будь-яких команд
// руху — інакше плата, схоже, ігнорує SetMotorSettings для моторів, яких
// немає в масці. Значення нижче — НЕ "усі 7 біт", а точна маска з живого
// Settings.xml цієї машини (ManualControlViewModel.SetMotorRequirementsMask
// будує її з TechnicalMotorSettings[].MotorMaskDrive): для цієї машини
// MotorMaskDrive=true лише в Drive1, Drive2, Conveyor, Shredder — Extra/
// RightPlate/LeftPlate вимкнені в конфігурації (фізично не встановлені або
// не каліброван). Якщо колись реально задіяти ці мотори — треба спершу
// прописати їх у Settings.xml заводського застосунку (щоб отримати реальні
// Power/PowerDelay/RampUp/RampDown), а вже потім розширювати цю маску.
const REQUIRED_MOTORS_MASK = pn.MOTOR_IDS.Drive1 | pn.MOTOR_IDS.Drive2 | pn.MOTOR_IDS.Conveyor | pn.MOTOR_IDS.Shredder; // = 27 (0x1B)

function startLoops() {
  send(pn.readFrame(pn.REG.VERSIONS)); // раз на старті, версії не змінюються
  send(pn.resetErrorMaskFrame({
    resetIntError: true, resetSafetyStop: true, resetMotorLostComm: true, resetMotorProtect: true,
  }));
  send(pn.motorReqMaskFrame(REQUIRED_MOTORS_MASK));

  setInterval(() => {
    send(pn.readFrame(pn.REG.KEEPALIVE));

    // зв'язок вважаємо втраченим, якщо давно немає відповідей
    if (Date.now() - state.lastReplyAt > 2000) {
      if (state.link) state.lastError = 'Немає відповіді від плати';
      state.link = false;
      haltAllMotion('втрачено зв’язок із платою');
    }
  }, KEEPALIVE_MS);

  setInterval(() => {
    pollOnce();

    // мертвий вимикач: інтерфейс мовчить — глушимо все, що рухається
    const anyRunning = Object.values(state.motors).some((m) => m.running);
    if (anyRunning && Date.now() - lastUiPing > DEADMAN_MS) {
      haltAllMotion('панель не відповідає');
    }

    // мотори під напругою — підтверджуємо команду регулярно
    for (const id of motorIds) {
      if (state.motors[id].running) applyMotor(id);
    }
  }, POLL_MS);

  setInterval(broadcast, 200);
}

// ---------------------------------------------------------------- порт
function openPort() {
  if (MOCK) {
    const { createFakePort } = require('./fakeboard');
    port = createFakePort();
    port.on('data', onData);
    console.log('Mock-режим: плата імітується, реальний COM-порт не використовується.');
    return;
  }

  const { SerialPort } = require('serialport');
  port = new SerialPort(
    { path: PORT_NAME, baudRate: BAUD, dataBits: 8, parity: 'none', stopBits: 1 },
    (err) => {
      if (err) {
        state.lastError = `Порт ${PORT_NAME}: ${err.message}`;
        setTimeout(openPort, 2000);
      }
    }
  );
  port.on('data', onData);
  port.on('error', (e) => {
    state.lastError = e.message;
    state.link = false;
  });
  port.on('close', () => {
    state.link = false;
    if (!MOCK) setTimeout(openPort, 2000);
  });
}

// ---------------------------------------------------------------- веб
const server = http.createServer((req, res) => {
  const file = req.url === '/' ? 'index.html' : req.url.split('?')[0];
  const full = path.join(__dirname, 'public', path.normalize(file).replace(/^(\.\.[/\\])+/, ''));
  fs.readFile(full, (err, buf) => {
    if (err) {
      res.writeHead(404);
      return res.end('not found');
    }
    const ext = path.extname(full);
    const type =
      { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' }[ext] ||
      'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    res.end(buf);
  });
});

const wss = new WebSocketServer({ server });
const clients = new Set();

function clampByte(v) {
  return Math.max(0, Math.min(255, v | 0));
}

wss.on('connection', (ws) => {
  clients.add(ws);
  lastUiPing = Date.now();
  // старий "панель відключилась" не має висіти вічно — свіже підключення
  // означає, що оператор знову тут; реальна проблема (плата/E-Stop) все
  // одно перевиставиться в найближчому циклі опитування, якщо ще актуальна
  if (state.lastError === 'Аварійна зупинка: панель відключилась') state.lastError = null;
  ws.send(JSON.stringify({ type: 'state', state }));

  ws.on('message', (raw) => {
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    lastUiPing = Date.now();

    switch (m.cmd) {
      case 'ping':
        return;

      case 'stop': // велика червона кнопка — зупинити все, що рухається
        return void haltAllMotion(null);

      case 'motorPower': {
        if (m.on && !canMove()) {
          state.lastError = 'Немає зв’язку або активна аварійна кнопка — реле не вмикається';
          return;
        }
        state.motorPower = !!m.on;
        if (!state.motorPower) stopAllMotors('вимкнено силове реле');
        return void send(pn.motorPowerFrame(state.motorPower));
      }

      case 'run': {
        const motorId = m.motorId | 0;
        const mo = state.motors[motorId];
        if (!mo) return;
        if (!state.motorPower) {
          state.lastError = 'Спершу увімкни силове реле моторів';
          return;
        }
        if (!canMove()) {
          state.lastError = 'Немає зв’язку або активна аварійна кнопка — пуск заблоковано';
          return;
        }
        mo.running = true;
        mo.speed = clampByte(m.speed);
        mo.direction = m.direction ? 1 : 0;
        if (typeof m.power === 'number') mo.power = clampByte(m.power);
        return void applyMotor(motorId);
      }

      case 'motorStop':
        return void stopMotor(m.motorId | 0, null);

      case 'speed': {
        const mo = state.motors[m.motorId | 0];
        if (!mo || !mo.running) return;
        mo.speed = clampByte(m.speed);
        return void applyMotor(m.motorId | 0);
      }

      case 'actuator': {
        if (m.on && !canMove()) return;
        if (m.index === 1) state.io.actuator1 = !!m.on;
        else if (m.index === 2) state.io.actuator2 = !!m.on;
        return void send(pn.actuatorsFrame(state.io.actuator1, state.io.actuator2));
      }

      case 'impulse': {
        if (m.on && !canMove()) return;
        if (m.index === 1) state.io.impulse1 = !!m.on;
        else if (m.index === 2) state.io.impulse2 = !!m.on;
        return void send(pn.impulseOutFrame(state.io.impulse1, state.io.impulse2));
      }

      case 'alarm':
        state.io.alarm = !!m.on;
        return void send(pn.alarmFrame(state.io.alarm));

      case 'charge':
        state.io.charge = !!m.on;
        return void send(pn.chargeFrame(state.io.charge));

      case 'spareOut':
        if (m.on && !canMove()) return;
        state.io.spareOut = !!m.on;
        return void send(pn.spareOutFrame(state.io.spareOut));

      case 'ir': {
        if (m.enable && !canMove()) return;
        state.io.ir = !!m.enable;
        state.io.irTime = m.time | 0;
        return void send(pn.irFrame({ enable: state.io.ir, time: state.io.irTime }));
      }

      case 'wirelessCommand': {
        const address = m.address | 0;
        const command = m.command | 0;
        // положення A/B (1/2) — рух вузла, решта (0=стоп,3=CheckOut,4..8) завжди дозволені
        const isMotion = command === pn.WIRELESS_CMD.POSITION_A || command === pn.WIRELESS_CMD.POSITION_B;
        if (isMotion && !canMove()) {
          state.lastError = 'Немає зв’язку або активна аварійна кнопка — команду заблоковано';
          return;
        }
        return void send(pn.wirelessCommandFrame(address, command));
      }

      case 'wirelessTable': {
        const cmd = m.cmd2 | 0; // 1=CheckIn,2=SetWay,3=CheckOut
        const isMotion = cmd === pn.WIRELESS_CMD.CHECK_IN || cmd === pn.WIRELESS_CMD.SET_WAY;
        if (isMotion && !canMove()) {
          state.lastError = 'Немає зв’язку або активна аварійна кнопка — команду заблоковано';
          return;
        }
        return void send(pn.wirelessTableFrame(cmd, m.switches || [], m.timeout));
      }

      case 'resetErrorMask':
        return void send(pn.resetErrorMaskFrame(m.flags || {}));

      case 'switchAmount':
        return void send(pn.switchAmountFrame(m.count | 0));

      case 'motorReqMask':
        return void send(pn.motorReqMaskFrame(m.mask | 0));
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    if (clients.size === 0) haltAllMotion('панель відключилась');
  });
});

function broadcast() {
  const payload = JSON.stringify({ type: 'state', state });
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(payload);
  }
}

// ---------------------------------------------------------------- запуск/зупинка
function shutdown() {
  console.log('\nЗупиняю все і закриваю порт…');
  for (const id of motorIds) {
    const m = state.motors[id];
    m.running = false;
    if (port && port.isOpen) port.write(pn.motorFrame({ motorId: m.motorId, status: 0, speed: 0 }));
  }
  try {
    if (port && port.isOpen) {
      port.drain(() => port.close(() => process.exit(0)));
      setTimeout(() => process.exit(0), 500);
      return;
    }
  } catch {}
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (e) => {
  console.error('Аварія:', e);
  shutdown();
});

openPort();
startLoops();
server.listen(HTTP_PORT, () => {
  console.log(`Панель:  http://localhost:${HTTP_PORT}`);
  console.log(MOCK ? 'Порт:    mock (без реальної плати)' : `Порт:    ${PORT_NAME} @ ${BAUD} 8N1`);
});
