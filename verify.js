const pn = require('./powernet');
// Еталон із перевіреної Python-реалізації
const expected = {
  'СТОП мотор 0':      '7e 00 47 20 09 00 00 00 00 00 00 00 00 00 68 42 7e',
  'РУХ sp=40 dir=0':   '7e 00 47 20 09 00 01 01 3c 00 28 00 00 00 ad c0 7e',
  'РУХ sp=40 dir=1':   '7e 00 47 20 09 00 01 01 3c 00 28 00 00 01 24 d1 7e',
  'read r5':           '7e 00 45 00 00 ea 3c 7e',
  'read r11':          '7e 00 4b 00 00 f1 2c 7e',
  'read r15':          '7e 00 4f 00 00 90 4f 7e',
  'read r1':           '7e 00 41 00 00 8b 5f 7e',
};
const got = {
  'СТОП мотор 0':    pn.motorFrame({motorId:0,status:0,speed:0,direction:0}),
  'РУХ sp=40 dir=0': pn.motorFrame({motorId:0,status:1,speed:40,direction:0,power:60}),
  'РУХ sp=40 dir=1': pn.motorFrame({motorId:0,status:1,speed:40,direction:1,power:60}),
  'read r5':         pn.readFrame(pn.REG.MOTOR_STATUS),
  'read r11':        pn.readFrame(pn.REG.SENSORS),
  'read r15':        pn.readFrame(pn.REG.DIGITAL_IN),
  'read r1':         pn.readFrame(pn.REG.KEEPALIVE),
};
let ok = true;
for (const k of Object.keys(expected)) {
  const hex = [...got[k]].map(b=>b.toString(16).padStart(2,'0')).join(' ');
  const pass = hex === expected[k];
  if (!pass) ok = false;
  console.log((pass?'OK  ':'FAIL') + '  ' + k.padEnd(18) + hex);
}
// round-trip: build -> parse
const f = pn.motorFrame({motorId:0,status:1,speed:40,direction:0,power:60});
const p = pn.parseFrame(f);
console.log('\nparseFrame:', p ? JSON.stringify({reg:p.register, data:[...p.data]}) : 'CRC FAIL');
// stuffing test: примусимо 0x7E у даних (speed=126)
const s = pn.motorFrame({motorId:0,status:1,speed:126,direction:0});
const hasEsc = s.includes(0x7d);
const rt = pn.parseFrame(s);
console.log('stuffing 0x7E -> escape присутній:', hasEsc, '| round-trip speed =', rt ? rt.data[5] : 'FAIL');
console.log('\nRESULT:', ok && p && rt && rt.data[5]===126 ? 'ВСЕ ЗБІГАЄТЬСЯ' : 'Є РОЗБІЖНОСТІ');
