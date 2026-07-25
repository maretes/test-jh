'use strict';
/**
 * Повернення візка додому — спрощена копія логіки заводського застосунку
 * (StateGoToHome -> StateBackwardMoving -> StateHomePosition з JHAgroPanelApp.il).
 * Без моделі маршруту/вузлів (її в нас немає) — просто їде назад, поки не
 * зловить передній фронт домашнього маркера (рег.11, IsInHomeMarker), і стає.
 *
 * КЛЮЧОВЕ: Drive1+Drive2 рухаються ОДНІЄЮ командою з MotorID=3 (=1|2),
 * а не двома окремими (1 і 2) — так шле реальний застосунок
 * (Drive.Backward3/Stop3), і це, схоже, обов'язково для плати.
 *
 * ПЕРЕД ЗАПУСКОМ: колеса підняті або трансмісія розчеплена, фізичний
 * аварійний стоп під рукою, заводський застосунок закритий.
 *
 * Використання:
 *   PORT_NAME=COM1 node go_home.js
 *   PORT_NAME=COM1 SPEED=20 DIRECTION=0 TIMEOUT_MS=60000 node go_home.js
 *
 * Ctrl+C у будь-який момент -> негайний стоп.
 */

const { SerialPort } = require('serialport');
const pn = require('./powernet');

const PORT_NAME = process.env.PORT_NAME || 'COM3';
const BAUD = Number(process.env.BAUD) || 115200;
const SPEED = Number(process.env.SPEED) || 15; // 10-20 — безпечно для першого тесту
const DIRECTION = process.env.DIRECTION !== undefined ? Number(process.env.DIRECTION) : 1; // напрямок "назад" — звірити на місці
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS) || 60000; // запобіжник, якщо датчик не спрацює

const DRIVE_BOTH = pn.MOTOR_IDS.Drive1 | pn.MOTOR_IDS.Drive2; // = 3
const ALL_MASK = Object.values(pn.MOTOR_IDS).reduce((m, id) => m | id, 0);

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log('=== Повернення додому ===');
  console.log(`Порт: ${PORT_NAME} @ ${BAUD} 8N1, швидкість=${SPEED}, напрямок=${DIRECTION}, таймаут=${TIMEOUT_MS}мс`);
  console.log('Колеса підняті / трансмісія розчеплена? Аварійний стоп під рукою?');
  console.log('Старт через 3с... (Ctrl+C щоб перервати)');
  await delay(3000);

  const port = new SerialPort({ path: PORT_NAME, baudRate: BAUD, dataBits: 8, parity: 'none', stopBits: 1 });
  await new Promise((resolve, reject) => {
    port.on('open', resolve);
    port.on('error', reject);
  });
  console.log('Порт відкрито.\n');

  let chain = Promise.resolve();
  function write(frame) {
    chain = chain.then(
      () =>
        new Promise((resolve) => {
          port.write(frame, () => port.drain(() => setTimeout(resolve, 10)));
        })
    );
    return chain;
  }

  let rxBuf = Buffer.alloc(0);
  let sensors = null;
  port.on('data', (chunk) => {
    rxBuf = Buffer.concat([rxBuf, chunk]);
    const { frames, rest } = pn.extractFrames(rxBuf);
    rxBuf = rest;
    for (const raw of frames) {
      const msg = pn.parseFrame(raw);
      if (msg && msg.register === pn.REG.SENSORS && msg.data.length >= 7) {
        sensors = pn.decodeSensors(msg.data);
      }
    }
  });

  function driveBoth(status, direction) {
    return write(pn.motorFrame({ motorId: DRIVE_BOTH, status, speed: status ? SPEED : 0, direction, power: 60 }));
  }

  let stopping = false;
  let keepaliveTimer = null;
  async function emergencyStop(reason) {
    if (stopping) return;
    stopping = true;
    console.log(`\nАварійна зупинка: ${reason}`);
    clearInterval(keepaliveTimer);
    try {
      await driveBoth(0, DIRECTION);
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

  keepaliveTimer = setInterval(() => {
    if (!stopping) write(pn.readFrame(pn.REG.KEEPALIVE));
  }, 300);

  console.log(`Їду назад (MotorID=${DRIVE_BOTH}, напрямок=${DIRECTION}), чекаю домашній маркер (рег.11)...`);

  const deadline = Date.now() + TIMEOUT_MS;
  let wasHome = false; // для ловлі переднього фронту, як Marker.IsMarkerEvent у заводському коді
  let arrived = false;

  while (!stopping && Date.now() < deadline) {
    await driveBoth(1, DIRECTION);
    await write(pn.readFrame(pn.REG.SENSORS));
    await delay(150);

    const isHome = !!(sensors && sensors.inHomeMarker);
    if (isHome && !wasHome) {
      console.log('\nДомашній маркер зловлено (передній фронт IsInHomeMarker) — зупиняюсь.');
      arrived = true;
      break;
    }
    wasHome = isHome;
  }

  if (!stopping) {
    clearInterval(keepaliveTimer);
    await driveBoth(0, DIRECTION);

    if (arrived) {
      console.log('Вдома. (У заводському коді тут ще скидається лічильник маркерів позиції —');
      console.log('у нас його немає, бо немає моделі маршруту.)');
    } else {
      console.log(`Таймаут ${TIMEOUT_MS}мс — домашній маркер не спрацював. Перевір датчик/проводку/напрямок.`);
    }

    await write(pn.motorPowerFrame(false));
    console.log('Силове реле вимкнено. Закриваю порт.');
    port.close(() => process.exit(0));
  }
}

main().catch((e) => {
  console.error('Помилка:', e);
  process.exit(1);
});
