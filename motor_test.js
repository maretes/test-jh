'use strict';
/**
 * Тестовий прогін усіх моторів наживо: мала швидкість, по черзі, вперед/назад.
 * Drive1+Drive2 (по CLAUDE.md — тягнуть візок по рейці на роликах) ЗАВЖДИ
 * вмикаються й вимикаються РАЗОМ — окремо рватиме візок.
 *
 * ПЕРЕД ЗАПУСКОМ: колеса підняті або трансмісія розчеплена, фізичний
 * аварійний стоп під рукою, заводський застосунок закритий.
 *
 * Використання:
 *   PORT_NAME=COM1 node motor_test.js
 *   PORT_NAME=COM1 SPEED=20 RUN_MS=2000 node motor_test.js
 *
 * Ctrl+C у будь-який момент -> негайний стоп усіх моторів.
 */

const { SerialPort } = require('serialport');
const pn = require('./powernet');

const PORT_NAME = process.env.PORT_NAME || 'COM3';
const BAUD = Number(process.env.BAUD) || 115200;
const SPEED = Number(process.env.SPEED) || 15; // 10-20 — безпечно для першого тесту
const RUN_MS = Number(process.env.RUN_MS) || 3000;
const PAUSE_MS = 1000; // пауза між кроками — встигнути побачити результат / зупинити руками

const ALL_MASK = Object.values(pn.MOTOR_IDS).reduce((m, id) => m | id, 0);

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log('=== Тест моторів PowerNet ===');
  console.log(`Порт: ${PORT_NAME} @ ${BAUD} 8N1, швидкість=${SPEED}, тривалість кроку=${RUN_MS}мс`);
  console.log('Колеса підняті / трансмісія розчеплена? Аварійний стоп під рукою?');
  console.log('Старт через 3с... (Ctrl+C щоб перервати)');
  await delay(3000);

  const port = new SerialPort({ path: PORT_NAME, baudRate: BAUD, dataBits: 8, parity: 'none', stopBits: 1 });
  await new Promise((resolve, reject) => {
    port.on('open', resolve);
    port.on('error', reject);
  });
  console.log('Порт відкрито.\n');

  function write(frame) {
    return new Promise((resolve) => {
      port.write(frame, () => port.drain(() => setTimeout(resolve, 20)));
    });
  }

  async function stopAll() {
    for (const id of Object.values(pn.MOTOR_IDS)) {
      await write(pn.motorFrame({ motorId: id, status: 0, speed: 0 }));
    }
  }

  let stopping = false;
  async function emergencyStop(reason) {
    if (stopping) return;
    stopping = true;
    console.log(`\nАварійна зупинка: ${reason}`);
    try {
      await stopAll();
      await write(pn.motorPowerFrame(false));
    } catch {}
    port.close(() => process.exit(0));
  }
  process.on('SIGINT', () => emergencyStop('SIGINT (Ctrl+C)'));
  process.on('uncaughtException', (e) => emergencyStop(`помилка: ${e.message}`));

  console.log('Ініціалізація: скид помилок + маска задіяних моторів (рег.25)...');
  await write(pn.resetErrorMaskFrame({
    resetIntError: true, resetSafetyStop: true, resetMotorLostComm: true, resetMotorProtect: true,
  }));
  await write(pn.motorReqMaskFrame(ALL_MASK));
  await delay(200);

  console.log('Силове реле моторів (рег.17) — увімкнення...');
  await write(pn.motorPowerFrame(true));
  await delay(300);

  async function runMotors(ids, direction, label) {
    if (stopping) return;
    console.log(`-> ${label} (motorId=[${ids}], напрямок=${direction})`);
    for (const id of ids) {
      await write(pn.motorFrame({ motorId: id, status: 1, speed: SPEED, direction, power: 60 }));
    }
    await delay(RUN_MS);
    for (const id of ids) {
      await write(pn.motorFrame({ motorId: id, status: 0, speed: 0, direction }));
    }
    console.log('   стоп.');
    await delay(PAUSE_MS);
  }

  // Drive1+Drive2 рухають візок по рейці — тільки разом
  const driveIds = [pn.MOTOR_IDS.Drive1, pn.MOTOR_IDS.Drive2];
  await runMotors(driveIds, 0, 'Drive1+Drive2 вперед');
  await runMotors(driveIds, 1, 'Drive1+Drive2 назад');

  // решта моторів — по черзі, кожен окремо, в обидва боки
  for (const name of ['Extra', 'Shredder', 'Conveyor', 'RightPlate', 'LeftPlate']) {
    if (stopping) break;
    const id = pn.MOTOR_IDS[name];
    await runMotors([id], 0, `${name} напрямок 0`);
    await runMotors([id], 1, `${name} напрямок 1`);
  }

  if (!stopping) {
    console.log('\nВимикаю силове реле моторів...');
    await write(pn.motorPowerFrame(false));
    console.log('Готово. Закриваю порт.');
    port.close(() => process.exit(0));
  }
}

main().catch((e) => {
  console.error('Помилка:', e);
  process.exit(1);
});
