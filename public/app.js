'use strict';

const REG_NAMES = {
  1: 'KEEPALIVE', 3: 'VERSIONS', 4: 'BOARD_ERROR', 5: 'MOTOR_STATUS/RESET_ERR',
  6: 'MOTOR_STATUS_BY_ID', 7: 'MOTOR_SETTINGS', 8: 'IR_STATE', 9: 'ALARM',
  10: 'IMPULSE_OUT', 11: 'SENSORS', 12: 'FOOD_WEIGHT', 13: 'ACTUATORS',
  14: 'ANALOG_IN', 15: 'DIGITAL_IN', 16: 'CHARGE', 17: 'MOTOR_POWER',
  18: 'SPARE_OUT', 19: 'WIRELESS_TABLE', 20: 'RESET_SW_ZONE', 21: 'SWITCH_AMOUNT',
  22: 'WIRELESS_ACK', 23: 'SWITCH_ZONE_STATE', 25: 'MOTOR_REQ_MASK',
  26: 'WIRELESS_STATE', 28: 'WIRELESS_CMD', 29: 'WIRELESS_EVENT',
};

let ws = null;
let cardsBuilt = false;
let ioBuilt = false;
let lastState = null;

function connect() {
  ws = new WebSocket(`ws://${location.host}`);
  ws.onopen = () => {
    setConn(true);
    setInterval(() => { if (ws.readyState === 1) ws.send(JSON.stringify({ cmd: 'ping' })); }, 500);
  };
  ws.onclose = () => { setConn(false); setTimeout(connect, 1000); };
  ws.onerror = () => {};
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'state') render(msg.state);
  };
}

function send(cmd) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(cmd));
}

function setConn(ok) {
  const el = document.getElementById('connStatus');
  el.textContent = ok ? "БРАУЗЕР ↔ СЕРВЕР: OK" : 'БРАУЗЕР ↔ СЕРВЕР: НЕМА';
  el.className = 'pill ' + (ok ? 'pill-ok' : 'pill-danger');
}

// ---------------------------------------------------------------- рендер
function render(state) {
  lastState = state;

  const linkEl = document.getElementById('connStatus');
  // не перетираємо статус браузер-сервер тут, окремий індикатор нижче для плати
  document.getElementById('portName').textContent = state.portName + (state.mock ? ' (mock)' : '');
  document.getElementById('lastErrorText').textContent = state.lastError || '—';
  document.getElementById('errorBar').textContent = state.lastError || '';
  document.getElementById('errorBar').classList.toggle('hidden', !state.lastError);
  document.getElementById('versions').textContent = state.versions ? JSON.stringify(state.versions.raw || state.versions) : '—';

  const bat = state.battery;
  document.getElementById('battery').textContent =
    bat && bat.voltage !== undefined ? `${bat.voltage.toFixed(2)} В` : '—';

  if (state.lastReplyAt) {
    const sec = Math.max(0, Math.round((Date.now() - state.lastReplyAt) / 1000));
    document.getElementById('lastReplyAgo').textContent = sec + ' с тому';
  }

  const estop = document.getElementById('estopStatus');
  const active = state.inputs && (state.inputs.emergencyStop || state.inputs.stopButton);
  estop.textContent = active ? 'E-STOP АКТИВНИЙ' : (state.inputs ? 'E-STOP: ОК' : 'E-STOP: ?');
  estop.className = 'pill ' + (active ? 'pill-danger' : (state.inputs ? 'pill-ok' : 'pill-off'));

  document.getElementById('motorPowerToggle').checked = !!state.motorPower;

  renderMotors(state);
  renderSensors(state);
  renderIO(state);
  renderWireless(state);
  renderHopper(state);
  renderFrameLog(state);
}

// ---------------------------------------------------------------- мотори
function renderMotors(state) {
  const wrap = document.getElementById('motorCards');
  const motors = Object.values(state.motors);
  if (!cardsBuilt) {
    wrap.innerHTML = '';
    for (const m of motors) {
      const card = document.createElement('div');
      card.className = 'card';
      card.dataset.motorId = m.motorId;
      card.innerHTML = `
        <h4>${m.name} <span style="font-weight:400;color:var(--muted)">(ID ${m.motorId})</span></h4>
        <label>Швидкість <span class="speedVal">${m.speed}</span>
          <input type="range" min="0" max="255" value="${m.speed}" class="speedRange"/>
        </label>
        <label class="switchRow"><input type="checkbox" class="dirCheck" ${m.direction ? 'checked' : ''}/> Напрямок (0/1)</label>
        <button class="runBtn">Пуск</button>
        <div class="feedback">—</div>
      `;
      const speedRange = card.querySelector('.speedRange');
      const speedVal = card.querySelector('.speedVal');
      const dirCheck = card.querySelector('.dirCheck');
      const runBtn = card.querySelector('.runBtn');

      speedRange.addEventListener('input', () => {
        speedVal.textContent = speedRange.value;
        const running = lastState && lastState.motors[m.motorId].running;
        if (running) send({ cmd: 'speed', motorId: m.motorId, speed: Number(speedRange.value) });
      });

      runBtn.addEventListener('click', () => {
        const running = lastState && lastState.motors[m.motorId].running;
        if (running) {
          send({ cmd: 'motorStop', motorId: m.motorId });
        } else {
          send({
            cmd: 'run', motorId: m.motorId,
            speed: Number(speedRange.value), direction: dirCheck.checked ? 1 : 0,
          });
        }
      });

      wrap.appendChild(card);
    }
    cardsBuilt = true;
  }

  for (const m of motors) {
    const card = wrap.querySelector(`[data-motor-id="${m.motorId}"]`);
    if (!card) continue;
    const runBtn = card.querySelector('.runBtn');
    runBtn.textContent = m.running ? 'Стоп' : 'Пуск';
    runBtn.className = 'runBtn' + (m.running ? ' stopbtn' : '');
    runBtn.disabled = !m.running && !state.motorPower;
    const fb = state.feedback[m.motorId];
    card.querySelector('.feedback').textContent = fb
      ? `плата: статус=${fb.status} швидк=${fb.speed} напр=${fb.direction}`
      : 'плата: немає даних';
  }
}

// ---------------------------------------------------------------- датчики
function renderSensors(state) {
  const s = state.sensors, i = state.inputs, a = state.analog, e = state.boardError, w = state.foodWeight;
  const rows = [];
  if (s) {
    rows.push(['Домашній маркер', s.inHomeMarker], ['Маркер позиції', s.inPosMarker],
      ['Бак повний', s.fullSensorOpen], ['Бак пустий', s.emptySensorOpen],
      ['Передній датчик', s.frontSensorOpen], ['Лічильник маркерів', s.positionCounter]);
  }
  if (i) {
    rows.push(['StopButton', i.stopButton], ['ResetButton', i.resetButton],
      ['EmergencyStop', i.emergencyStop], ['WeightingInput', i.weightingInput],
      ['SpareInput1', i.spareInput1], ['SpareInput2', i.spareInput2]);
  }
  if (w) rows.push(['Вага корму', w.weight !== undefined ? w.weight.toFixed(2) : JSON.stringify(w.raw)]);
  if (a) {
    rows.push(['Analog (сирі)', a.raw ? a.raw.join(',') :
      `U1=${a.voltageInput1} U2=${a.voltageInput2} U3=${a.voltageInput3} Uch=${a.voltageCharge} I1=${a.currentInput1} I2=${a.currentInput2}`]);
  }
  if (e) rows.push(['Маска помилок (сира)', `int=${e.internalErrorMask} lost=${e.motorLostCommunMask} prot=${e.motorProtectionTriggeringMask}`]);

  document.getElementById('sensorGrid').innerHTML = rows
    .map(([k, v]) => `<div>${k}</div><div>${v}</div>`).join('');
}

// ---------------------------------------------------------------- IO
function renderIO(state) {
  const wrap = document.getElementById('ioCards');
  if (!ioBuilt) {
    wrap.innerHTML = `
      <div class="card"><h4>Актуатор 1</h4><button data-io="actuator1">Перемкнути</button></div>
      <div class="card"><h4>Актуатор 2</h4><button data-io="actuator2">Перемкнути</button></div>
      <div class="card"><h4>Імпульсний вихід 1</h4><button data-io="impulse1">Перемкнути</button></div>
      <div class="card"><h4>Імпульсний вихід 2</h4><button data-io="impulse2">Перемкнути</button></div>
      <div class="card"><h4>Сирена</h4><button data-io="alarm" class="warn">Перемкнути</button></div>
      <div class="card"><h4>Реле заряду</h4><button data-io="charge">Перемкнути</button></div>
      <div class="card"><h4>Запасний вихід</h4><button data-io="spareOut">Перемкнути</button></div>
    `;
    wrap.querySelectorAll('[data-io]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.io;
        const cur = !!lastState.io[key];
        const cmdMap = {
          actuator1: () => send({ cmd: 'actuator', index: 1, on: !cur }),
          actuator2: () => send({ cmd: 'actuator', index: 2, on: !cur }),
          impulse1: () => send({ cmd: 'impulse', index: 1, on: !cur }),
          impulse2: () => send({ cmd: 'impulse', index: 2, on: !cur }),
          alarm: () => send({ cmd: 'alarm', on: !cur }),
          charge: () => send({ cmd: 'charge', on: !cur }),
          spareOut: () => send({ cmd: 'spareOut', on: !cur }),
        };
        cmdMap[key]();
      });
    });
    ioBuilt = true;
  }
  for (const key of ['actuator1', 'actuator2', 'impulse1', 'impulse2', 'alarm', 'charge', 'spareOut']) {
    const btn = wrap.querySelector(`[data-io="${key}"]`);
    const on = !!state.io[key];
    btn.textContent = on ? 'УВІМКНЕНО (натисни щоб вимкнути)' : 'вимкнено';
  }
}

// ---------------------------------------------------------------- стрілки
document.getElementById('swAddr');
function wireDirectButtons() {
  document.querySelectorAll('[data-cmd]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const addr = Number(document.getElementById('swAddr').value) || 0;
      const map = { posA: 1, posB: 2, stop: 0, ping: 7, cardid: 6, reset: 4 };
      send({ cmd: 'wirelessCommand', address: addr, command: map[btn.dataset.cmd] });
    });
  });
}

let switchRows = [];
function buildSwitchTable() {
  const n = Math.max(1, Math.min(20, Number(document.getElementById('swCount').value) || 1));
  const wrap = document.getElementById('swTable');
  wrap.innerHTML = '';
  switchRows = [];
  for (let idx = 1; idx <= n; idx++) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <h4>Стрілка ${idx}</h4>
      <label class="switchRow"><input type="checkbox" class="upd" checked/> оновити</label>
      <label class="switchRow"><input type="radio" name="pos${idx}" value="0" checked/> Положення A</label>
      <label class="switchRow"><input type="radio" name="pos${idx}" value="1"/> Положення B</label>
    `;
    wrap.appendChild(card);
    switchRows.push({ idx, card });
  }
}

function wireTableButtons() {
  document.querySelectorAll('[data-tcmd]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const timeout = Number(document.getElementById('swTimeout').value) || 20;
      const switches = switchRows.map(({ idx, card }) => ({
        index: idx,
        update: card.querySelector('.upd').checked,
        position: Number(card.querySelector(`input[name="pos${idx}"]:checked`).value),
      }));
      send({ cmd: 'wirelessTable', cmd2: Number(btn.dataset.tcmd), switches, timeout });
    });
  });
}

function renderWireless(state) {
  const w = state.wireless || {};
  document.getElementById('wAck').textContent = w.ack ? JSON.stringify(w.ack) : '—';
  document.getElementById('wState').textContent = w.state ? JSON.stringify(w.state) : '—';
  document.getElementById('wEvent').textContent = w.event ? JSON.stringify(w.event) : '—';
  document.getElementById('wZone').textContent = w.zoneState ? JSON.stringify(w.zoneState.raw) : '—';
}

// ---------------------------------------------------------------- погрузчик
function wireHopper() {
  document.querySelectorAll('[data-hop]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const addr = Number(document.getElementById('hopAddr').value) || 0;
      send({ cmd: 'wirelessCommand', address: addr, command: Number(btn.dataset.hop) });
    });
  });
  document.getElementById('hopIr').addEventListener('change', (e) => {
    send({ cmd: 'ir', enable: e.target.checked, time: 0 });
  });
  document.getElementById('hopCharge').addEventListener('change', (e) => {
    send({ cmd: 'charge', on: e.target.checked });
  });
}

function renderHopper(state) {
  const w = state.foodWeight;
  document.getElementById('hopWeight').textContent = w
    ? (w.weight !== undefined ? w.weight.toFixed(2) : JSON.stringify(w.raw))
    : '—';
  document.getElementById('hopIr').checked = !!state.io.ir;
  document.getElementById('hopCharge').checked = !!state.io.charge;
}

// ---------------------------------------------------------------- журнал
function renderFrameLog(state) {
  const el = document.getElementById('frameLog');
  const log = state.frameLog || [];
  el.innerHTML = log
    .slice()
    .reverse()
    .map((f) => {
      const regName = f.register !== undefined ? (REG_NAMES[f.register] || f.register) : '';
      return `<div class="${f.dir}">${f.dir.toUpperCase()} ${regName ? '[' + regName + '] ' : ''}${f.hex}</div>`;
    })
    .join('');
}

// ---------------------------------------------------------------- ініціалізація
document.getElementById('bigStop').addEventListener('click', () => send({ cmd: 'stop' }));
document.getElementById('motorPowerToggle').addEventListener('change', (e) => {
  send({ cmd: 'motorPower', on: e.target.checked });
});
document.getElementById('swBuildTable').addEventListener('click', buildSwitchTable);

wireDirectButtons();
wireTableButtons();
wireHopper();
buildSwitchTable();
connect();
