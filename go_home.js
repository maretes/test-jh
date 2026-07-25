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
 * ПЕРЕД ЗАПУСКОМ: візок підвісний, відчепити привід від руху не можна —
 * щойно мотор реально спрацює, візок поїде по рейці. Шлях вільний, фізичний
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
// Реальні числа з живого Settings.xml (%APPDATA%\JHAgroPanelApp\Settings\Settings.xml)
// цієї машини, звірені з формулою в DoForward/DoBackward/DoBackwardToHome
// (JHAgroPanelApp.il): Speed = ((MotorDriveSpeed-32)*CartSpeedPercent+3200)/100.
// Motors[0] = Drive1 (id=1 у XML): MotorDriveSpeed=255, MotorDriveMaxPower=44,
// MotorDrivePowerDelay=110, MotorDriveRumpUp=10, MotorDriveRumpDown=0.
// Заводський стан StateBackwardMoving (автоматичний рух назад/до дому) явно
// логує "Rail is near, DriveBackward (CartSpeedLow)" і рахує швидкість від
// CartSpeedLow=40% — це найближчий аналог того, що робить цей скрипт (їде
// назад, поки не зловить домашній маркер), тому дефолт побудовано на ньому:
// ((255-32)*40+3200)/100 = 121.2 -> 121. Ручні кнопки Forward/Backward у
// заводській панелі натомість рахують від CartSpeedNormal=70% -> 188.
const SPEED = Number(process.env.SPEED) || 121;
// DirectionMotorPlate=true для Drive1 у Settings.xml -> в IL це дає
// Direction=0 для Forward і Direction=1 для Backward (перевірено в
// DoForward/DoBackward/DoBackwardToHome — усі три гілки узгоджені).
const DIRECTION = process.env.DIRECTION !== undefined ? Number(process.env.DIRECTION) : 1;
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS) || 60000; // запобіжник, якщо датчик не спрацює
// Power/PowerDelay/RampUp/RampDown (байти 3/4/6/7 рег.7) — точні значення
// Drive1 з Settings.xml (Drive2 в тому ж файлі має ідентичні). Не наближення.
const POWER = Number(process.env.POWER) || 44;
const POWER_DELAY = Number(process.env.POWER_DELAY) || 110;
const RAMP_UP = Number(process.env.RAMP_UP) || 10;
const RAMP_DOWN = Number(process.env.RAMP_DOWN) || 0;

const DRIVE_BOTH = pn.MOTOR_IDS.Drive1 | pn.MOTOR_IDS.Drive2; // = 3
// РЕАЛЬНА маска регістру 25 цієї машини — НЕ всі 7 моторів. З Settings.xml
// MotorMaskDrive: true лише для Drive1, Drive2, Conveyor, Shredder (id 1,2,4,5);
// Extra/RightPlate/LeftPlate (id 3,6,7) вимкнені в конфігурації. Раніше тут
// стояла маска "усі 7" (127) — це розходилось із заводським конфігом і могло
// провокувати MotorLostCommunMask на моторах, які плата не очікує задіяними.
const REQUIRED_MASK = pn.MOTOR_IDS.Drive1 | pn.MOTOR_IDS.Drive2 | pn.MOTOR_IDS.Conveyor | pn.MOTOR_IDS.Shredder; // = 27 (0x1B)

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log('=== Повернення додому ===');
  console.log(`Порт: ${PORT_NAME} @ ${BAUD} 8N1, швидкість=${SPEED}, напрямок=${DIRECTION}, таймаут=${TIMEOUT_MS}мс`);
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
  let inputs = null;
  let boardError = null;
  let lastPrintedError = null;
  let lastPrintedInputs = null;
  // рег.6 не ехоїть MotorID — трекаємо чергу запитів (плата відповідає
  // в тому ж порядку, в якому питали, оскільки лінія напівдуплексна)
  const pendingMotorStatus = [];
  const lastPrintedMotorStatus = {};

  port.on('data', (chunk) => {
    rxBuf = Buffer.concat([rxBuf, chunk]);
    const { frames, rest } = pn.extractFrames(rxBuf);
    rxBuf = rest;
    for (const raw of frames) {
      const msg = pn.parseFrame(raw);
      if (!msg) {
        console.log(`rx НЕВАЛІДНИЙ КАДР (CRC?): ${[...raw].map((b) => b.toString(16).padStart(2, '0')).join(' ')}`);
        continue;
      }
      console.log(`rx рег=${msg.register} тип=${msg.messageType} write=${msg.isWrite} data=[${[...msg.data]}]`);
      // рег.11 реально повертає 2 байти (бітове поле + PositionMarkerCounter),
      // не 7, як гадали раніше — підтверджено з IL і живим кадром цієї плати.
      if (msg.register === pn.REG.SENSORS && msg.data.length >= 2) {
        sensors = pn.decodeSensors(msg.data);
      }
      // рег.15 — 1 байт, бітове поле (StopButton/ResetButton/EmergencyStopButton/…).
      if (msg.register === pn.REG.DIGITAL_IN && msg.data.length >= 1) {
        inputs = pn.decodeDigitalInputs(msg.data);
        const key = JSON.stringify(inputs);
        if (key !== lastPrintedInputs) {
          lastPrintedInputs = key;
          console.log(`\n[рег.15 входи] stop=${inputs.stopButton} eStop=${inputs.emergencyStop} reset=${inputs.resetButton} weighting=${inputs.weightingInput}`);
        }
      }
      if (msg.register === pn.REG.BOARD_ERROR) {
        boardError = pn.decodeBoardError(msg.data);
        const key = JSON.stringify(boardError.raw);
        if (key !== lastPrintedError) {
          lastPrintedError = key;
          console.log(`\n[рег.4 маска помилок] int=${boardError.internalErrorMask} lost=${boardError.motorLostCommunMask} protect=${boardError.motorProtectionTriggeringMask} raw=[${boardError.raw}]`);
        }
      }
      if (msg.register === pn.REG.MOTOR_STATUS_BY_ID && !msg.isWrite) {
        const id = pendingMotorStatus.shift(); // знімаємо завжди, навіть на порожню відповідь
        if (msg.data.length >= 7) {
          const fb = pn.decodeMotorStatus(msg.data);
          const key = JSON.stringify(fb);
          if (key !== lastPrintedMotorStatus[id]) {
            lastPrintedMotorStatus[id] = key;
            console.log(`\n[рег.6 статус мотора] id=${id} status=${fb.status} speed=${fb.speed} power=${fb.power} dir=${fb.direction}`);
          }
        } else if (lastPrintedMotorStatus[id] !== 'empty') {
          lastPrintedMotorStatus[id] = 'empty';
          console.log(`\n[рег.6 статус мотора] id=${id} ПОРОЖНЯ ВІДПОВІДЬ (невідомий/невалідний ID?)`);
        }
      }
    }
  });

  // COMBINED_ID=1 (дефолт): MotorID=3 (=1|2) в одній команді — так шле
  // заводський Drive.Forward3/Backward3, але рег.6 показує, що плата це
  // ігнорує (status завжди 0 після запису). SEPARATE=0: дві окремі команди
  // (ID=1, ID=2) одна за одною, як діагностика — раніше без правильної
  // boot-послідовності теж не рухало, перевіряємо ще раз тепер, коли вона є.
  const COMBINED_ID = process.env.COMBINED_ID !== '0';
  console.log(`Режим адресації Drive1+Drive2: ${COMBINED_ID ? 'комбінована команда MotorID=3' : 'дві окремі команди ID=1 і ID=2'}`);

  function driveBoth(status, direction) {
    const speed = status ? SPEED : 0;
    if (COMBINED_ID) {
      return write(pn.motorFrame({ motorId: DRIVE_BOTH, status, speed, direction, power: POWER, powerDelay: POWER_DELAY, rampUp: RAMP_UP, rampDown: RAMP_DOWN }));
    }
    return write(pn.motorFrame({ motorId: pn.MOTOR_IDS.Drive1, status, speed, direction, power: POWER, powerDelay: POWER_DELAY, rampUp: RAMP_UP, rampDown: RAMP_DOWN })).then(() =>
      write(pn.motorFrame({ motorId: pn.MOTOR_IDS.Drive2, status, speed, direction, power: POWER, powerDelay: POWER_DELAY, rampUp: RAMP_UP, rampDown: RAMP_DOWN }))
    );
  }

  function readMotorStatus(id) {
    pendingMotorStatus.push(id);
    return write(pn.motorStatusByIdFrame(id));
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

  console.log(`Power=${POWER}, PowerDelay=${POWER_DELAY}, RampUp=${RAMP_UP}, RampDown=${RAMP_DOWN}, RequiredMask=${REQUIRED_MASK}`);
  await write(pn.readFrame(pn.REG.BOARD_ERROR));
  await delay(100);

  // Рег.15 StopButton — ІНВЕРТОВАНИЙ біт, підтверджено з IL
  // (FeedingSystem: обробник MessageDigitalInputs рахує
  // `EmergencystopState = (StopButton == 1) ? false : true`). Тобто
  // StopButton=1 означає "контур цілий, НЕ зупинено", а 0 — реальний
  // E-Stop/Stop. EmergencyStopButton/ResetButton біти в цій єдиній
  // гейтуючій формулі заводського коду взагалі не використовуються — не
  // гейтуємо на них і ми. Раніше тут стояла протилежна (непідтверджена)
  // умова — саме вона хибно блокувала попередній запуск, хоча плата була
  // повністю готова їхати.
  console.log('Перевірка рег.15 (StopButton, інвертовано за FeedingSystem з IL)...');
  await write(pn.readFrame(pn.REG.DIGITAL_IN));
  await delay(150);

  const resetAll = () =>
    write(pn.resetErrorMaskFrame({
      resetIntError: true, resetSafetyStop: true, resetMotorLostComm: true, resetMotorProtect: true,
    }));

  // Точна послідовність запуску з FeedingSystem.BwBoardDE_DoWork (кнопка
  // Start у заводському застосунку) — раніше пропущений крок: імпульсний
  // вихід (рег.10) на 1с ПЕРЕД увімкненням силового реле, довші паузи.
  console.log('Boot-послідовність (як при натисканні Start у заводському застосунку)...');
  await write(pn.readFrame(pn.REG.KEEPALIVE));
  await write(pn.impulseOutFrame(true, false)); // рег.10, вихід1=ON
  console.log('Імпульсний вихід1 ON, чекаю 1с...');
  await delay(1000);
  await resetAll();
  console.log('Силове реле моторів (рег.17) — увімкнення...');
  await write(pn.motorPowerFrame(true));
  await write(pn.impulseOutFrame(false, false)); // рег.10, вихід1=OFF
  await resetAll();
  console.log('Чекаю 3с (як у заводській послідовності)...');
  await delay(3000);
  await write(pn.readFrame(pn.REG.KEEPALIVE));
  await resetAll();
  await write(pn.motorReqMaskFrame(REQUIRED_MASK));
  await resetAll();

  // Друга перевірка рег.15 — після boot-послідовності, той самий
  // (інвертований) гейт: абортуємо лише якщо StopButton==0.
  console.log('Перевірка рег.15 після boot-послідовності...');
  await write(pn.readFrame(pn.REG.DIGITAL_IN));
  await delay(150);
  if (inputs && !inputs.stopButton) {
    console.log(`\nСТОП: рег.15 показує StopButton=0 — контур Stop/E-Stop розімкнено. Перевір фізичну кнопку/роз'єм.`);
    await write(pn.motorPowerFrame(false));
    port.close(() => process.exit(1));
    return;
  }
  if (!inputs) {
    console.log('УВАГА: не отримав відповідь на рег.15 після reset — не можу підтвердити стан Stop-контуру.');
  }

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
    await write(pn.readFrame(pn.REG.BOARD_ERROR));
    await write(pn.readFrame(pn.REG.DIGITAL_IN));
    await readMotorStatus(DRIVE_BOTH);
    await readMotorStatus(pn.MOTOR_IDS.Drive1);
    await readMotorStatus(pn.MOTOR_IDS.Drive2);
    await delay(150);

    if (inputs && !inputs.stopButton) {
      await emergencyStop(`рег.15: StopButton=0 (контур Stop/E-Stop розімкнено)`);
      break;
    }

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
