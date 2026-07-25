'use strict';
/**
 * Керуюче ядро панелі розвозчика.
 *
 * Володіє COM-портом і НІКОЛИ не залежить від інтерфейсу:
 * якщо браузер завис, закрився чи згорів Wi-Fi — мотор зупиняється сам.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { SerialPort } = require('serialport');
const { WebSocketServer } = require('ws');
const pn = require('./powernet');

// ---------------------------------------------------------------- налаштування
const PORT_NAME = process.env.PORT_NAME || 'COM3'; // Linux: /dev/ttyUSB0
const BAUD = 115200;
const HTTP_PORT = 8080;

const KEEPALIVE_MS = 300; // плата чекає регулярних повідомлень
const POLL_MS = 150; // опитування датчиків
const DEADMAN_MS = 1500; // немає сигналу від UI довше цього — стоп
const REPLY_TIMEOUT = 200;

// ---------------------------------------------------------------- стан
const state = {
  link: false,
  portName: PORT_NAME,
  motor: { running: false, speed: 0, direction: 0, motorId: 0, power: 60 },
  feedback: null,
  sensors: null,
  inputs: null,
  lastError: null,
  lastReplyAt: 0,
};

let port = null;
let lastUiPing = 0;
let rxBuffer = Buffer.alloc(0);

// ---------------------------------------------------------------- черга запису
// Порт один, тож кадри не можна змішувати — усе йде послідовно.
let chain = Promise.resolve();

function send(frame) {
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

    try {
      if (msg.register === pn.REG.MOTOR_STATUS && msg.data.length >= 8) {
        state.feedback = pn.decodeMotorStatus(msg.data);
      } else if (msg.register === pn.REG.SENSORS && msg.data.length >= 7) {
        state.sensors = pn.decodeSensors(msg.data);
      } else if (msg.register === pn.REG.DIGITAL_IN && msg.data.length >= 4) {
        state.inputs = pn.decodeDigitalInputs(msg.data);
        if (state.inputs.emergencyStop || state.inputs.stopButton) {
          stopMotor('аварійна кнопка на машині');
        }
      }
    } catch (e) {
      state.lastError = e.message;
    }
  }
}

// ---------------------------------------------------------------- мотор
function applyMotor() {
  const m = state.motor;
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

function stopMotor(reason) {
  if (state.motor.running) {
    state.motor.running = false;
    state.motor.speed = 0;
    state.lastError = reason ? `Зупинено: ${reason}` : null;
  }
  return applyMotor();
}

// ---------------------------------------------------------------- цикли
let pollIndex = 0;
const POLL_REGS = [pn.REG.MOTOR_STATUS, pn.REG.SENSORS, pn.REG.DIGITAL_IN];

function startLoops() {
  setInterval(() => {
    send(pn.readFrame(pn.REG.KEEPALIVE));

    // зв'язок вважаємо втраченим, якщо давно немає відповідей
    if (Date.now() - state.lastReplyAt > 2000) {
      if (state.link) state.lastError = 'Немає відповіді від плати';
      state.link = false;
      if (state.motor.running) stopMotor('втрачено зв’язок із платою');
    }
  }, KEEPALIVE_MS);

  setInterval(() => {
    send(pn.readFrame(POLL_REGS[pollIndex++ % POLL_REGS.length]));

    // мертвий вимикач: інтерфейс мовчить — глушимо мотор
    if (state.motor.running && Date.now() - lastUiPing > DEADMAN_MS) {
      stopMotor('панель не відповідає');
    }

    // мотор під напругою — підтверджуємо команду регулярно
    if (state.motor.running) applyMotor();
  }, POLL_MS);

  setInterval(broadcast, 200);
}

// ---------------------------------------------------------------- порт
function openPort() {
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
    setTimeout(openPort, 2000);
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

wss.on('connection', (ws) => {
  clients.add(ws);
  lastUiPing = Date.now();
  ws.send(JSON.stringify({ type: 'state', state }));

  ws.on('message', (raw) => {
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    lastUiPing = Date.now();

    if (m.cmd === 'ping') return;

    if (m.cmd === 'stop') return void stopMotor(null);

    if (m.cmd === 'run') {
      if (state.inputs && (state.inputs.emergencyStop || state.inputs.stopButton)) {
        state.lastError = 'Аварійна кнопка активна — пуск заблоковано';
        return;
      }
      if (!state.link) {
        state.lastError = 'Немає зв’язку з платою';
        return;
      }
      state.motor.running = true;
      state.motor.speed = Math.max(0, Math.min(255, m.speed | 0));
      state.motor.direction = m.direction ? 1 : 0;
      if (typeof m.power === 'number') state.motor.power = m.power | 0;
      return void applyMotor();
    }

    if (m.cmd === 'speed' && state.motor.running) {
      state.motor.speed = Math.max(0, Math.min(255, m.speed | 0));
      return void applyMotor();
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    if (clients.size === 0) stopMotor('панель відключилась');
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
  console.log('\nЗупиняю мотор і закриваю порт…');
  state.motor.running = false;
  const frame = pn.motorFrame({ motorId: state.motor.motorId, status: 0, speed: 0 });
  try {
    if (port && port.isOpen) {
      port.write(frame);
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
  console.log(`Порт:    ${PORT_NAME} @ ${BAUD} 8N1`);
});
