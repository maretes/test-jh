'use strict';
/**
 * Сканер послідовних портів/бодрейтів — пошук плати PowerNet наосліп.
 * На кожній комбінації порт+бодрейт шле keepalive (рег.1, читання) і дивиться,
 * чи прийшла валідна відповідь (правильний CRC). Розрізняє "тишу" (нічого не
 * прийшло — не той порт/кабель) від "сміття" (щось прийшло, CRC не збігається
 * — той порт, не той бодрейт/фреймінг).
 *
 * Використання:
 *   node scan.js                    - всі порти з SerialPort.list(), стандартні бодрейти
 *   node scan.js COM1               - лише COM1, стандартні бодрейти
 *   node scan.js COM1 9600          - лише COM1 на 9600
 *   node scan.js COM1 9600,19200    - COM1 на кількох конкретних бодрейтах
 */

const { SerialPort } = require('serialport');
const pn = require('./powernet');

const STANDARD_BAUDS = [9600, 19200, 38400, 57600, 115200];
const ATTEMPT_WINDOW_MS = 500;
const ATTEMPTS_PER_COMBO = 3;
const GAP_BETWEEN_COMBOS_MS = 150;

function hex(buf) {
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join(' ');
}

async function listPorts() {
  const ports = await SerialPort.list();
  return ports.map((p) => p.path);
}

/** Одна спроба порт+бодрейт: відкрити, кілька разів спитати keepalive, закрити. */
function tryCombo(path, baud) {
  return new Promise((resolve) => {
    const port = new SerialPort({
      path,
      baudRate: baud,
      dataBits: 8,
      parity: 'none',
      stopBits: 1,
      autoOpen: false,
    });

    let rxTotal = Buffer.alloc(0);
    let done = false;

    const finish = (result) => {
      if (done) return;
      done = true;
      port.removeAllListeners();
      if (port.isOpen) port.close(() => resolve(result));
      else resolve(result);
    };

    port.on('data', (chunk) => {
      rxTotal = Buffer.concat([rxTotal, chunk]);
    });
    port.on('error', (err) => finish({ ok: false, error: err.message, raw: rxTotal }));

    port.open((err) => {
      if (err) return finish({ ok: false, error: err.message, raw: rxTotal });

      let attempt = 0;
      const sendNext = () => {
        attempt++;
        const frame = pn.readFrame(pn.REG.KEEPALIVE);
        port.write(frame, () => port.drain(() => {}));

        setTimeout(() => {
          const { frames } = pn.extractFrames(rxTotal);
          const valid = frames.map((f) => pn.parseFrame(f)).find(Boolean);
          if (valid) return finish({ ok: true, valid, raw: rxTotal });
          if (attempt < ATTEMPTS_PER_COMBO) return sendNext();
          finish({ ok: false, raw: rxTotal });
        }, ATTEMPT_WINDOW_MS);
      };
      sendNext();
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  let ports;
  let bauds = STANDARD_BAUDS;

  if (args[0]) {
    ports = [args[0]];
  } else {
    ports = await listPorts();
    if (ports.length === 0) {
      console.log('SerialPort.list() не бачить жодного порту.');
      return;
    }
  }
  if (args[1]) bauds = args[1].split(',').map(Number);

  console.log(`Порти: ${ports.join(', ')}`);
  console.log(`Бодрейти: ${bauds.join(', ')}`);
  console.log('');

  const hits = [];

  for (const path of ports) {
    for (const baud of bauds) {
      process.stdout.write(`${path} @ ${baud} ... `);
      const result = await tryCombo(path, baud);

      if (result.ok) {
        console.log(`ВІДПОВІДЬ! рег=${result.valid.register} data=[${[...result.valid.data]}]`);
        hits.push({ path, baud });
      } else if (result.error) {
        console.log(`помилка відкриття: ${result.error}`);
      } else if (result.raw.length > 0) {
        console.log(`сміття (${result.raw.length} байт): ${hex(result.raw.slice(0, 32))}${result.raw.length > 32 ? '…' : ''}`);
      } else {
        console.log('тиша');
      }

      await new Promise((r) => setTimeout(r, GAP_BETWEEN_COMBOS_MS));
    }
  }

  console.log('');
  if (hits.length) {
    console.log('Робочі комбінації:');
    for (const h of hits) console.log(`  PORT_NAME=${h.path} BAUD=${h.baud}`);
  } else {
    console.log('Жодна комбінація не дала валідної відповіді.');
    console.log('Якщо десь було "сміття" (не тиша) — це найімовірніший кандидат: порт правильний,');
    console.log('бодрейт чи фреймінг не той. Якщо всюди тиша — перевір кабель/порт фізично.');
  }
}

main().catch((e) => {
  console.error('Помилка сканування:', e);
  process.exit(1);
});