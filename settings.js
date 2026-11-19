import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// ExtensionBase binds this domain in both GNOME Shell and the preferences process.
export const _ = message => GLib.dgettext('peripheral-batteries@stas.local', message);
// Mark strings in module-level tables without translating before the domain is bound.
export const N_ = message => message;

export const PLACEMENTS = {
    quick: N_('Quick Settings'),
    panel: N_('Top Bar'),
    both: N_('Both'),
};

export const DEVICE_TYPES = {
    keyboard: {label: N_('Keyboard'), icon: 'input-keyboard-symbolic'},
    mouse: {label: N_('Mouse'), icon: 'input-mouse-symbolic'},
    headphones: {label: N_('Over-ear headphones'), icon: 'audio-headphones-symbolic'},
    earbuds: {label: N_('Earbuds'), icon: 'earbuds-symbolic'},
    headset: {label: N_('Headset'), icon: 'audio-headset-symbolic'},
    speaker: {label: N_('Speaker'), icon: 'audio-speakers-symbolic'},
    gamepad: {label: N_('Gamepad'), icon: 'input-gaming-symbolic'},
    audio: {label: N_('Audio device'), icon: 'audio-card-symbolic'},
    other: {label: N_('Other device'), icon: 'bluetooth-symbolic'},
};

export const BATTERY_DIAGNOSTICS = {
    pending: N_('Waiting for the extension to check this device.'),
    disconnected: N_('Device is not currently detected.'),
    percentage: N_('Battery percentage available.'),
    level: N_('The device reports a battery level without a percentage.'),
    stale: N_('Showing the last known battery level.'),
    'stale-hidden': N_('The last known battery level is hidden by your display settings.'),
    'no-reading': N_('The system has not reported a battery level.'),
    waiting: N_('Waiting for a battery report from the USB receiver.'),
    asleep: N_('The USB receiver did not reply. Try waking the device.'),
    permission: N_('Access to the USB receiver was denied.'),
    unavailable: N_('The USB receiver is temporarily unavailable.'),
    unsupported: N_('Battery readings through this USB receiver are not supported.'),
};

export function iconFor(path, name) {
    if (name === 'earbuds-symbolic')
        return Gio.FileIcon.new(Gio.File.new_build_filenamev([path, 'icons', 'earbuds-symbolic.svg']));
    return Gio.ThemedIcon.new_with_default_fallbacks(name);
}

export function readDevices(settings, key) {
    return settings.get_value(key).deepUnpack();
}

export function writeDevices(settings, key, devices) {
    const value = new GLib.Variant('a{sa{ss}}', devices);
    if (!settings.get_value(key).equal(value))
        settings.set_value(key, value);
}

export function preferencesFor(devices, id) {
    return Object.hasOwn(devices, id) ? devices[id] : {};
}
