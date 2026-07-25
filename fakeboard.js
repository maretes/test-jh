'use strict';
/**
 * Віртуальна плата PowerNet для перевірки панелі без живого заліза.
 * Повертає об'єкт із тим самим інтерфейсом, що SerialPort
 * (isOpen/write/drain/close/on), тож server.js його не відрізняє.
 */

const { EventEmitter } = require('events');
const pn = require('./powernet');

function createFakePort() {
  const port = new EventEmitter();
  port.isOpen = true;

  const board = {
    batteryDeciVolts: 246, // 24.6 В
    motors: {}, // motorId -> останній заданий стан
    positionCounter: 0,
    inputs: { stop: 0, reset: 0, estop: 0, weighting: 0, spare1: 0, spare2: 0 },
    wireless: { lastAddr: 0, lastCmd: 0, ack: { status: 1, nodeId: 0, relayStatus: 0, switchPosition: 0 } },
  };

  function reply(register, data) {
    const frame = pn.buildFrame(data, register, { msgType: pn.MSG.REPLY, rw: pn.RW.READ });
    setTimeout(() => port.emit('data', frame), 5 + Math.random() * 10);
  }

  function handleTx(buf) {
    const msg = pn.parseFrame(buf);
    if (!msg) return; // биті кадри — плата б їх теж проігнорувала
    const { register, data, isWrite } = msg;

    switch (register) {
      case pn.REG.KEEPALIVE:
        reply(register, [board.batteryDeciVolts & 0xff, (board.batteryDeciVolts >>> 8) & 0xff]);
        break;

      case pn.REG.MOTOR_STATUS_BY_ID: {
        const id = data[0];
        const m = board.motors[id] || {
          status: 0, power: 0, powerDelay: 0, speed: 0, rampUp: 0, rampDown: 0, direction: 0,
        };
        reply(register, [id, m.status, m.power, m.powerDelay, m.speed, m.rampUp, m.rampDown, m.direction]);
        break;
      }

      case pn.REG.MOTOR_SETTINGS:
        if (isWrite && data.length >= 9) {
          const id = data[0];
          board.motors[id] = {
            status: data[2], power: data[3], powerDelay: data[4],
            speed: data[5], rampUp: data[6], rampDown: data[7], direction: data[8],
          };
          if (data[2]) board.positionCounter = (board.positionCounter + 1) & 0xffff;
        }
        break;

      case pn.REG.SENSORS:
        reply(register, [0, 0, 0, 1, 0, board.positionCounter & 0xff, (board.positionCounter >>> 8) & 0xff]);
        break;

      case pn.REG.DIGITAL_IN:
        reply(register, [
          board.inputs.stop, board.inputs.reset, board.inputs.estop,
          board.inputs.weighting, board.inputs.spare1, board.inputs.spare2,
        ]);
        break;

      case pn.REG.ANALOG_IN:
        reply(register, [10,0, 20,0, 30,0, 240,0, 5,0, 3,0]); // фіктивні значення для перевірки UI
        break;

      case pn.REG.BOARD_ERROR:
        reply(register, [0, 0, 0, 0, 0, 0]);
        break;

      case pn.REG.FOOD_WEIGHT:
        reply(register, Array.from(Buffer.from(new Float32Array([12.5]).buffer)));
        break;

      case pn.REG.VERSIONS:
        reply(register, [2, 2, 55, 1]);
        break;

      case pn.REG.SWITCH_ZONE_STATE:
        reply(register, [0]);
        break;

      case pn.REG.WIRELESS_CMD:
        if (isWrite && data.length >= 2) {
          board.wireless.lastAddr = data[0];
          board.wireless.lastCmd = data[1];
          board.wireless.ack = {
            status: 1,
            nodeId: data[0],
            relayStatus: data[1] === 0 ? 0 : 1,
            switchPosition: data[1] === 2 ? 1 : 0,
          };
        }
        break;

      case pn.REG.WIRELESS_TABLE:
        if (isWrite) board.wireless.ack = { status: 1, nodeId: 0, relayStatus: 1, switchPosition: 0 };
        break;

      case pn.REG.WIRELESS_ACK:
        reply(register, [
          board.wireless.ack.status, board.wireless.ack.nodeId,
          board.wireless.ack.relayStatus, board.wireless.ack.switchPosition,
        ]);
        break;

      case pn.REG.WIRELESS_STATE:
        reply(register, [1, board.wireless.lastCmd]);
        break;

      case pn.REG.WIRELESS_EVENT:
        reply(register, [board.wireless.lastAddr, board.wireless.lastCmd]);
        break;

      default:
        break; // актуатори/імпульси/ІЧ/сирена/заряд/реле/спейр — приймаємо мовчки, без відповіді
    }
  }

  port.write = (buf, cb) => {
    setTimeout(() => {
      try {
        handleTx(buf);
        cb && cb(null);
      } catch (e) {
        cb && cb(e);
      }
    }, 2 + Math.random() * 3);
  };
  port.drain = (cb) => setTimeout(cb, 1);
  port.close = (cb) => {
    port.isOpen = false;
    if (cb) cb();
    setTimeout(() => port.emit('close'), 0);
  };

  return port;
}

module.exports = { createFakePort };
