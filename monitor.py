#!/usr/bin/env python3
"""Detect supported USB receivers and read charge where available."""
import argparse
from dataclasses import dataclass
import json
import os
from pathlib import Path
import select
import signal
import time

MOUSE_PRODUCTS = {0xFA60, 0xFA55, 0x2155}
KEYBOARD_INTERVAL = 300
FIRST_RETRY = 15
MAX_RETRY = 60


@dataclass(frozen=True)
class Receiver:
    kind: str
    name: str
    path: Path
    sysfs_path: Path


def parse_keyboard(packet):
    if (len(packet) != 20 or packet[0] != 0x13 or packet[1] & 0x7F != 0x4A
            or packet[2] != 1 or packet[3] != 0 or not 2 <= packet[4] <= 14
            or sum(packet[:19]) & 0xFF != packet[19] or packet[5] > 100):
        return None
    # The status flags vary by firmware; do not guess a charging indicator.
    return packet[5], None


def parse_mouse(packet):
    # 03 <device-id> 40 <state> <percent>. Link messages (03 xx 01) are not charge.
    if (len(packet) != 5 or packet[0] != 3 or packet[2] != 0x40
            or packet[3] not in (1, 2, 3) or packet[4] > 100):
        return None
    return packet[4], packet[3] == 3


def keyboard_request():
    packet = bytearray(20)
    packet[:5] = bytes((0x13, 0x4A, 1, 0, 0))
    packet[19] = sum(packet[:19]) & 0xFF
    return bytes(packet)


def discover(root=Path('/sys/class/hidraw')):
    found = {}
    for node in sorted(root.glob('hidraw*')):
        try:
            device = (node / 'device').resolve(strict=True)
            properties = dict(line.split('=', 1) for line in
                              (device / 'uevent').read_text().splitlines() if '=' in line)
            bus, vendor, product = (int(value, 16) for value in properties['HID_ID'].split(':'))
            if bus != 3:
                continue
            if (vendor, product) == (0x3554, 0xFA09):
                kind, name = 'keyboard', 'AULA F75'
                usage, report = b'\x06\x02\xff', b'\x85\x13'
            elif vendor == 0x1D57 and product in MOUSE_PRODUCTS:
                kind, name = 'mouse', 'Attack Shark X11'
                usage, report = b'\x05\x0a', b'\x85\x03'
            else:
                continue
            descriptor = (device / 'report_descriptor').read_bytes()
            if usage not in descriptor or report not in descriptor:
                continue
            # USB serial (when present) or the physical receiver port, rather
            # than hidraw's ephemeral index, keeps display overrides stable.
            identity = (properties.get('HID_UNIQ') or
                        properties.get('HID_PHYS', '').split('/input')[0] or
                        str(device.parent))
            key = f'usb:{vendor:04x}:{product:04x}:{identity}'
            found[key] = Receiver(kind, name, Path('/dev') / node.name, device)
        except (OSError, ValueError, KeyError):
            continue
    return found


def discover_usb_audio(root=Path('/sys/class/sound')):
    devices = {}
    for card in root.glob('card[0-9]*'):
        try:
            usb = (card / 'device').resolve(strict=True).parent
            vendor = (usb / 'idVendor').read_text().strip()
            product = (usb / 'idProduct').read_text().strip()
            name = (usb / 'product').read_text().strip()
        except OSError:
            continue
        # The Skadi shares its USB ID with other firmware variants. Match its
        # product name too. This variant has no declared battery report.
        if (vendor, product, name.casefold()) != ('291d', '385d', 'skadi hsw191b'):
            continue
        devices[f'usb:{vendor}:{product}:{usb.name}'] = {
            'name': name, 'type': 'headset', 'percent': None, 'charging': None,
            'stale': False, 'error': 'unsupported', 'age_seconds': None,
        }
    return devices


class Device:
    def __init__(self, receiver):
        self.receiver = receiver
        self.fd = None
        self.percent = None
        self.charging = None
        self.seen = None
        self.error = None
        self.pending = None
        self.next_poll = 0
        self.retry_delay = FIRST_RETRY
        self.missed = False

    def close(self):
        if self.fd is not None:
            os.close(self.fd)
        self.fd = None
        self.pending = None

    def attach(self):
        if self.fd is None:
            try:
                mode = os.O_RDWR if self.receiver.kind == 'keyboard' else os.O_RDONLY
                self.fd = os.open(self.receiver.path, mode | os.O_NONBLOCK | os.O_CLOEXEC)
                self.error = None
            except PermissionError:
                self.error = 'permission'
            except OSError:
                self.error = 'unavailable'

    def request(self, now):
        if self.receiver.kind != 'keyboard' or self.fd is None or now < self.next_poll:
            return
        self.next_poll = now + KEYBOARD_INTERVAL
        try:
            # This request reads charge only. Ignore unrelated input reports.
            os.write(self.fd, keyboard_request())
            self.pending = now + 2
        except OSError:
            self.error = 'unavailable'
            self.close()
            self.reschedule(now)

    def reschedule(self, now):
        self.missed = True
        self.next_poll = now + self.retry_delay
        self.retry_delay = min(self.retry_delay * 2, MAX_RETRY)

    def receive(self, now):
        try:
            packet = os.read(self.fd, 64)
            if not packet:
                raise OSError('Disconnected')
        except BlockingIOError:
            return
        except OSError:
            self.close()
            self.error = 'unavailable'
            self.missed = True
            return
        value = (parse_keyboard if self.receiver.kind == 'keyboard' else parse_mouse)(packet)
        if value is not None:
            self.percent, self.charging = value
            self.seen = now
            self.pending = None
            self.missed = False
            self.error = None
            if self.receiver.kind == 'keyboard':
                self.next_poll = now + KEYBOARD_INTERVAL
                self.retry_delay = FIRST_RETRY

    def snapshot(self, now):
        if self.pending is not None and now >= self.pending:
            self.pending = None
            self.reschedule(now)
            self.error = 'asleep'
        max_age = KEYBOARD_INTERVAL + 60 if self.receiver.kind == 'keyboard' else 60
        expired = self.seen is not None and now - self.seen > max_age
        return {'name': self.receiver.name, 'type': self.receiver.kind,
                'percent': self.percent, 'charging': self.charging,
                'stale': self.missed or expired, 'error': self.error,
                'age_seconds': round(now - self.seen) if self.seen is not None else None}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--once', action='store_true', help='Sample detected receivers and exit')
    parser.add_argument('--timeout', type=float, default=8)
    parser.add_argument('--device-list', action='store_true', help='Use one entry per receiver')
    args = parser.parse_args()
    devices = {}
    usb_audio = {}
    running = True

    def stop(*_):
        nonlocal running
        running = False

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    start = time.monotonic()
    next_scan = next_emit = 0
    previous = None
    try:
        while running:
            now = time.monotonic()
            if now >= next_scan:
                if args.device_list:
                    usb_audio = discover_usb_audio()
                found = discover()
                for key in list(devices):
                    if devices[key].receiver != found.get(key):
                        devices.pop(key).close()
                for key, receiver in found.items():
                    if key not in devices:
                        devices[key] = Device(receiver)
                    devices[key].attach()
                next_scan = now + 5
            for device in devices.values():
                device.request(now)
            data = {key: device.snapshot(now) for key, device in devices.items()}
            data.update(usb_audio)
            if not args.device_list:
                # An already loaded v1 Shell extension can still launch this file
                # until GNOME starts a fresh session and loads the v2 JavaScript.
                data = legacy_snapshot(data)
            # Age is included for diagnostics, but does not trigger updates every second.
            signature = {key: {k: v for k, v in item.items() if k != 'age_seconds'}
                         for key, item in data.items()}
            if not args.once and (signature != previous or now >= next_emit):
                print(json.dumps(data, ensure_ascii=False), flush=True)
                previous = signature
                next_emit = now + 15
            if args.once and (now - start >= args.timeout or
                              all(d.percent is not None or d.error == 'permission'
                                  for d in devices.values())):
                print(json.dumps(data, ensure_ascii=False), flush=True)
                return
            readers = [d.fd for d in devices.values() if d.fd is not None]
            readable, _, _ = select.select(readers, [], [], 0.5)
            for device in devices.values():
                if device.fd in readable:
                    device.receive(time.monotonic())
    finally:
        for device in devices.values():
            device.close()


def legacy_snapshot(data):
    result = {kind: {'percent': None, 'charging': None, 'stale': False,
                     'error': 'disconnected', 'age_seconds': None}
              for kind in ('keyboard', 'mouse')}
    for item in data.values():
        result[item['type']] = {key: value for key, value in item.items()
                                if key not in ('type', 'name')}
    return result


if __name__ == '__main__':
    main()
