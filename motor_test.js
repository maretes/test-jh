'use strict';
/**
 * Тестовий прогін усіх моторів наживо: мала швидкість, по черзі, вперед/назад.
 * Drive1+Drive2 (по CLAUDE.md — тягнуть візок по рейці на роликах) ЗАВЖДИ
 * вмикаються й вимикаються РАЗОМ — окремо рватиме візок.
 *
 * ПЕРЕД ЗАПУСКОМ: візок підвісний, відчепити привід від руху не можна —
 * щойно мотор реально спрацює, візок поїде по рейці. Шлях вільний, фізичний
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
// Заводська формула швидкості ((MotorDriveSpeed-32)*CartSpeedPercent+3200)/100,
// звірена з реальним Settings.xml (%APPDATA%\JHAgroPanelApp\Settings\Settings.xml)
// цієї машини: MotorDriveSpeed=255 для всіх, крім плат (32), CartSpeedNormal=70%
// -> ((255-32)*70+3200)/100 = 188.1 -> 188.
const SPEED = Number(process.env.SPEED) || 188;
const RUN_MS = Number(process.env.RUN_MS) || 3000;
const PAUSE_MS = 1000; // пауза між кроками — встигнути побачити результат / зупинити руками

// Навмисно всі 7 біт, а не реальна маска цієї машини (0x1B — див. go_home.js/
// server.js) — цей скрипт існує саме для того, щоб фізично прозондувати й
// Extra/RightPlate/LeftPlate, які в поточному Settings.xml вимкнені
// (MotorMaskDrive=false), і перевірити, чи є там взагалі щось підключене.
const ALL_MASK = Object.values(pn.MOTOR_IDS).reduce((m, id) => m | id, 0);

// Per-motor Power/PowerDelay/RampUp/RampDown — точні значення з Settings.xml
// (Motors[0..6] = Drive1, Drive2, Extra, Conveyor, Shredder, RightPlate, LeftPlate,
// перевірено проти MotorMaskDrive->бітова маска в JHAgroPanelApp.il). Раніше тут
// стояв один спільний power=60 для всіх моторів — це ВИЩЕ за реальний калібрувальний
// ліміт Extra/RightPlate/LeftPlate (15), тобто фактично вимикало захист по струму
// саме для найслабших моторів.
// speed — за заводською формулою з MotorDriveSpeed кожного мотора (RightPlate/
// LeftPlate каліброван на MotorDriveSpeed=32, що завжди дає Speed=32 незалежно
// від CartSpeedPercent; решта на MotorDriveSpeed=255 -> 188 при CartSpeedNormal=70%)
const MOTOR_CALIBRATION = {
  Drive1: { power: 44, powerDelay: 110, rampUp: 10, rampDown: 0, speed: 188 },
  Drive2: { power: 44, powerDelay: 110, rampUp: 10, rampDown: 0, speed: 188 },
  Extra: { power: 15, powerDelay: 110, rampUp: 0, rampDown: 0, speed: 188 },
  Conveyor: { power: 36, powerDelay: 110, rampUp: 10, rampDown: 0, speed: 188 },
  Shredder: { power: 44, powerDelay: 110, rampUp: 10, rampDown: 0, speed: 188 },
  RightPlate: { power: 15, powerDelay: 110, rampUp: 0, rampDown: 0, speed: 32 },
  LeftPlate: { power: 15, powerDelay: 110, rampUp: 0, rampDown: 0, speed: 32 },
};
function calibrationForIds(ids) {
  // Drive1+Drive2 ідентичні — для комбінованої команди (MotorID=3) досить
  // калібрування першого
  const name = Object.keys(pn.MOTOR_IDS).find((n) => ids.includes(pn.MOTOR_IDS[n]));
  return MOTOR_CALIBRATION[name] || { power: 15, powerDelay: 110, rampUp: 0, rampDown: 0 };
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log('=== Тест моторів PowerNet ===');
  console.log(`Порт: ${PORT_NAME} @ ${BAUD} 8N1, швидкість=${SPEED}, тривалість кроку=${RUN_MS}мс`);
  console.log('Візок підвісний — коліс/трансмісії, які можна відчепити, немає.');
  console.log('Щойно поїде — поїде реально по рейці. Шлях вільний? Аварійний стоп під рукою?');
  console.log('Старт через 3с... (Ctrl+C щоб перервати)');
  await delay(3000);

  const port = new SerialPort({ path: PORT_NAME, baudRate: BAUD, dataBits: 8, parity: 'none', stopBits: 1 });
  await new Promise((resolve, reject) => {
    port.on('open', resolve);
    port.on('error', reject);
  });
  console.log('Порт відкрито.\n');

  // послідовна черга запису — як у server.js: кадри не можна змішувати,
  // а плата, схоже, має watchdog і глушить мотор, якщо трафік не триває,
  // тож фонового keepalive і одноразового запису недостатньо
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

  async function stopAll() {
    for (const id of Object.values(pn.MOTOR_IDS)) {
      await write(pn.motorFrame({ motorId: id, status: 0, speed: 0 }));
    }
  }

  let stopping = false;
  let keepaliveTimer = null; // призначається нижче; clearInterval(null) безпечний
  async function emergencyStop(reason) {
    if (stopping) return;
    stopping = true;
    console.log(`\nАварійна зупинка: ${reason}`);
    clearInterval(keepaliveTimer);
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

  // фоновий keepalive протягом усього тесту — без нього плата може
  // вважати, що майстра нема, і сама скидати стан
  keepaliveTimer = setInterval(() => {
    if (!stopping) write(pn.readFrame(pn.REG.KEEPALIVE));
  }, 300);

  async function runMotors(ids, direction, label) {
    if (stopping) return;
    const cal = calibrationForIds(ids);
    // SPEED з env -> явне перевизначення для всіх моторів; інакше калібрування
    // конкретного мотора (плати каліброван на 32, решта на 188)
    const speed = process.env.SPEED !== undefined ? SPEED : cal.speed;
    console.log(`-> ${label} (motorId=[${ids}], напрямок=${direction}, power=${cal.power}, speed=${speed})`);
    const until = Date.now() + RUN_MS;
    while (Date.now() < until && !stopping) {
      for (const id of ids) {
        await write(pn.motorFrame({ ...cal, motorId: id, status: 1, speed, direction }));
      }
      await delay(150);
    }
    for (const id of ids) {
      await write(pn.motorFrame({ motorId: id, status: 0, speed: 0, direction }));
    }
    console.log('   стоп.');
    await delay(PAUSE_MS);
  }

  // Drive1+Drive2 рухають візок по рейці — ОДНІЄЮ командою з MotorID=3 (=1|2),
  // так само як заводський Drive.Forward3/Backward3, а не двома окремими
  const driveIds = [pn.MOTOR_IDS.Drive1 | pn.MOTOR_IDS.Drive2];
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
    clearInterval(keepaliveTimer);
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
