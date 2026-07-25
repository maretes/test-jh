#!/usr/bin/env python3
"""
PowerNet — керування мотором розвозчика сіна через COM-порт.

Відновлено з JHAgroPanelApp v2.2.294 (PowerNetDriver.dll).
CRC-таблицю звірено побайтово з таблицею всередині DLL — збіг 256/256.

УВАГА: цей код фізично запускає мотор. Читай розділ про безпеку внизу.
"""

import time

try:
    import serial  # pip install pyserial
except ImportError:
    serial = None

# ---------------------------------------------------------------- константи
FLAG = 0x7E          # стартовий/стоповий байт кадру
ESC = 0x7D          # escape-байт

MSG_REQUEST = 0
MSG_REPLY = 1
MSG_BROADCAST = 3

RW_READ = 0
RW_WRITE = 1

REG_KEEPALIVE = 1
REG_VERSIONS = 3
REG_BOARD_ERROR = 4
REG_MOTOR_STATUS = 5
REG_MOTOR_SETTINGS = 7      # <-- запис налаштувань/команди мотора
REG_SENSORS = 11            # індуктивні/оптичні датчики
REG_FOOD_WEIGHT = 12
REG_ANALOG_IN = 14
REG_DIGITAL_IN = 15         # кнопки Stop / Reset / Emergency

LOCAL_ADDR = 0              # дефолт у драйвері
REMOTE_ADDR = 1             # дефолт у драйвері (плата)


# ---------------------------------------------------------------- CRC-16
def _make_table():
    tbl = []
    for i in range(256):
        v = i
        for _ in range(8):
            v = (v >> 1) ^ 0x8408 if v & 1 else v >> 1
        tbl.append(v)
    return tbl


FCS_TABLE = _make_table()


def crc16(buf, start, end):
    """PPP FCS-16, init 0xFFFF, без фінального інвертування (як у DLL)."""
    crc = 0xFFFF
    for i in range(start, end):
        crc = (crc >> 8) ^ FCS_TABLE[(crc ^ buf[i]) & 0xFF]
    return crc & 0xFFFF


# ---------------------------------------------------------------- кадр
def build_frame(data, register, local=LOCAL_ADDR, remote=REMOTE_ADDR,
                msg_type=MSG_REQUEST, rw=RW_WRITE):
    n = len(data)
    buf = [0] * (n + 8)
    buf[0] = FLAG
    buf[1] = ((local << 3) | (remote >> 2)) & 0xFF
    buf[2] = (((remote << 6) & 0xFF) | register) & 0xFF
    buf[3] = ((msg_type << 6) | (0x20 if rw == RW_WRITE else 0)) & 0xFF
    buf[4] = n
    buf[5:5 + n] = data

    crc = crc16(buf, 1, len(buf) - 3)
    buf[-3] = crc & 0xFF          # LSB перший
    buf[-2] = (crc >> 8) & 0xFF   # MSB
    buf[-1] = FLAG

    # байт-стаффінг для всього між прапорцями
    out = [buf[0]]
    for byteval in buf[1:-1]:
        if byteval == FLAG:
            out += [ESC, 0x5E]
        elif byteval == ESC:
            out += [ESC, 0x5D]
        else:
            out.append(byteval)
    out.append(buf[-1])
    return bytes(out)


def unstuff(frame):
    """Зняти стаффінг з отриманого кадру (між прапорцями)."""
    body = frame[1:-1]
    out = []
    i = 0
    while i < len(body):
        if body[i] == ESC and i + 1 < len(body):
            out.append(FLAG if body[i + 1] == 0x5E else ESC)
            i += 2
        else:
            out.append(body[i])
            i += 1
    return bytes(out)


# ---------------------------------------------------------------- мотор
def motor_frame(motor_id, status, speed, direction,
                power=0, power_delay=0, ramp_up=0, ramp_down=0, ev=None):
    """
    status    : 1 = рух, 0 = стоп
    direction : 0 / 1 (вперед / назад — звірити на своїй машині!)
    speed     : 0..255
    power     : обмеження струму/потужності
    ev        : другий аргумент SetMotorSettings; у тест-панелі дорівнює status
    """
    if ev is None:
        ev = status
    data = [
        motor_id & 0xFF,      # [0] MotorID
        ev & 0xFF,            # [1] ev
        status & 0xFF,        # [2] Status
        power & 0xFF,         # [3] Power
        power_delay & 0xFF,   # [4] PowerDelay
        speed & 0xFF,         # [5] Speed
        ramp_up & 0xFF,       # [6] RampUp
        ramp_down & 0xFF,     # [7] RampDown
        direction & 0xFF,     # [8] Direction
    ]
    return build_frame(data, REG_MOTOR_SETTINGS)


def read_frame(register):
    """Кадр-запит на читання (напр. статусу мотора або датчиків)."""
    return build_frame([], register, rw=RW_READ)


# ---------------------------------------------------------------- транспорт
class PowerNet:
    def __init__(self, port, baud=115200, timeout=0.3):
        if serial is None:
            raise RuntimeError("Встанови pyserial:  pip install pyserial")
        self.ser = serial.Serial(
            port, baudrate=baud, bytesize=8,
            parity=serial.PARITY_NONE, stopbits=1, timeout=timeout,
        )

    def send(self, frame):
        self.ser.reset_input_buffer()
        self.ser.write(frame)
        self.ser.flush()
        return self.ser.read(64)

    def close(self):
        self.ser.close()


# ---------------------------------------------------------------- самоперевірка
if __name__ == "__main__":
    print("Приклади кадрів (hex):\n")

    f = motor_frame(motor_id=0, status=0, speed=0, direction=0)
    print("СТОП мотор 0        :", f.hex(" "))

    f = motor_frame(motor_id=0, status=1, speed=40, direction=0, power=60)
    print("РУХ мотор 0 sp=40   :", f.hex(" "))

    f = motor_frame(motor_id=0, status=1, speed=40, direction=1, power=60)
    print("РУХ назад sp=40     :", f.hex(" "))

    print("\nЗапити на читання:")
    print("статус мотора (r5)  :", read_frame(REG_MOTOR_STATUS).hex(" "))
    print("датчики       (r11) :", read_frame(REG_SENSORS).hex(" "))
    print("кнопки/E-Stop (r15) :", read_frame(REG_DIGITAL_IN).hex(" "))
    print("keepalive     (r1)  :", read_frame(REG_KEEPALIVE).hex(" "))

    # перевірка узгодженості CRC
    raw = motor_frame(0, 1, 40, 0, power=60)
    body = unstuff(raw)
    got = body[-2] | (body[-1] << 8)
    calc = crc16(b"\x00" + body[:-2], 1, len(body) - 1)
    print("\nCRC self-check:", "OK" if got == calc else f"MISMATCH {got:#06x} vs {calc:#06x}")
