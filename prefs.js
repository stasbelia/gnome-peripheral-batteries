import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk?version=4.0';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {_, N_, BATTERY_DIAGNOSTICS, DEVICE_TYPES, PLACEMENTS, iconFor, preferencesFor, readDevices, writeDevices} from './settings.js';

const DEVICE_SETTINGS = 'device-settings';
const SOURCES = {bluetooth: 'Bluetooth', upower: 'UPower', receiver: N_('USB receiver')};
const ICONS = Object.fromEntries(Object.values(DEVICE_TYPES).map(({label, icon}) => [icon, label]));
Object.assign(ICONS, {
    'battery-symbolic': N_('Battery'),
    'network-wireless-symbolic': N_('Wireless connection'),
});

function combo(title, choices, selected, changed) {
    const keys = Object.keys(choices);
    const row = new Adw.ComboRow({
        title,
        model: Gtk.StringList.new(Object.values(choices).map(_)),
        selected: Math.max(0, keys.indexOf(selected)),
    });
    row.connect('notify::selected', () => changed(keys[row.selected]));
    return row;
}

function addSwitch(group, settings, key, title, subtitle = '') {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    group.add(row);
}

function addNumber(group, settings, key, title, subtitle, min, max) {
    const row = new Adw.SpinRow({
        title,
        subtitle,
        adjustment: new Gtk.Adjustment({lower: min, upper: max, step_increment: 1}),
        numeric: true,
    });
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    group.add(row);
}

export default class PeripheralBatteriesPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        window.title = _('Peripheral Batteries');
        window.set_default_size(680, 650);
        const settings = this.getSettings();
        this._addDisplayPage(window, settings);
        this._addDevicesPage(window, settings);
    }

    _addDisplayPage(window, settings) {
        const page = new Adw.PreferencesPage({title: _('Display'), icon_name: 'preferences-system-symbolic'});
        const placement = new Adw.PreferencesGroup({title: _('Placement')});
        placement.add(combo(_('Show battery levels in'), PLACEMENTS, settings.get_string('placement'),
            value => settings.set_string('placement', value)));
        addSwitch(placement, settings, 'hide-lock-button', _('Hide the screen lock button'),
            _('Makes room for battery readings in the Quick Settings header.'));
        addSwitch(placement, settings, 'panel-names', _('Show device names in the top bar'));
        addNumber(placement, settings, 'panel-limit', _('Devices shown in the top bar'),
            _('Click the indicator to see additional devices.'), 1, 8);
        page.add(placement);

        const readings = new Adw.PreferencesGroup({title: _('Battery level')});
        addSwitch(readings, settings, 'show-unknown', _('Show devices without battery readings'),
            _('Shows a dash when the device has no battery reading.'));
        addSwitch(readings, settings, 'show-stale', _('Show the last known battery level'),
            _('A ~ marks outdated readings from USB receivers.'));
        addNumber(readings, settings, 'low-threshold', _('Low battery threshold (%)'),
            _('Set to 0 to turn off percentage-based highlighting.'), 0, 100);
        page.add(readings);
        window.add(page);
    }

    _addDevicesPage(window, settings) {
        const page = new Adw.PreferencesPage({title: _('Devices'), icon_name: 'preferences-system-devices-symbolic'});
        const group = new Adw.PreferencesGroup({title: _('Detected devices')});
        const empty = new Adw.ActionRow({
            title: _('No devices detected yet'),
            subtitle: _('Connect a wireless device while the extension is enabled.'),
        });
        group.add(empty);
        page.add(group);
        window.add(page);

        const rows = new Map();
        const sync = () => {
            const devices = Object.entries(readDevices(settings, 'known-devices'));
            devices.sort(([, a], [, b]) => a.name.localeCompare(b.name, undefined, {numeric: true}));
            empty.visible = devices.length === 0;
            for (const [id, device] of devices) {
                if (!rows.has(id)) {
                    const entry = this._createDeviceRow(window, settings, id);
                    rows.set(id, entry);
                    group.add(entry.row);
                }
                rows.get(id).update(device);
            }
        };
        sync();
        const changed = settings.connect('changed::known-devices', sync);
        window.connect('destroy', () => settings.disconnect(changed));
    }

    _createDeviceRow(window, settings, id) {
        const options = () => preferencesFor(readDevices(settings, DEVICE_SETTINGS), id);
        const save = (key, value) => {
            const devices = readDevices(settings, DEVICE_SETTINGS);
            const entry = {...preferencesFor(devices, id)};
            if (value)
                entry[key] = value;
            else
                delete entry[key];
            if (Object.keys(entry).length)
                devices[id] = entry;
            else
                delete devices[id];
            writeDevices(settings, DEVICE_SETTINGS, devices);
        };

        const saved = options();
        const theme = Gtk.IconTheme.get_for_display(window.get_display());
        const row = new Adw.ExpanderRow({use_markup: false});
        const preview = new Gtk.Image({pixel_size: 24});
        row.add_prefix(preview);
        const diagnostics = new Adw.ActionRow({title: _('Battery diagnostics'), use_markup: false});
        const usbId = id.match(/^usb:([a-f\d]{4}:[a-f\d]{4}):/i)?.[1];
        row.add_row(diagnostics);
        let current;
        const update = device => {
            current = device;
            const prefs = options();
            const type = DEVICE_TYPES[prefs.type] ?? DEVICE_TYPES[device.type] ?? DEVICE_TYPES.other;
            row.title = prefs.name || device.name;
            row.subtitle = `${_(type.label)} · ${_(SOURCES[device.source] ?? device.source)}`;
            const source = device.batterySource ?? device.source;
            const status = BATTERY_DIAGNOSTICS[device.status] ?? BATTERY_DIAGNOSTICS.pending;
            diagnostics.subtitle = [_(SOURCES[source] ?? source), usbId, _(status)].filter(Boolean).join(' · ');
            preview.gicon = iconFor(this.path, prefs.icon || type.icon);
        };
        const refresh = () => {
            if (current)
                update(current);
        };
        const name = new Adw.EntryRow({
            title: _('Display name'),
            text: saved.name ?? '',
            show_apply_button: true,
        });
        name.connect('apply', () => {
            save('name', name.text.trim());
            refresh();
        });
        row.add_row(name);

        const place = combo(_('Show in'), {
            inherit: N_('Use global setting'), ...PLACEMENTS, hidden: N_('Hide'),
        }, saved.placement ?? 'inherit', value => save('placement', value === 'inherit' ? '' : value));
        row.add_row(place);

        const pin = new Adw.SwitchRow({
            title: _('Pin device'),
            subtitle: _('Show this device before unpinned devices.'),
            active: saved.pinned === 'true',
        });
        pin.connect('notify::active', () => save('pinned', pin.active ? 'true' : ''));
        row.add_row(pin);

        const types = {auto: N_('Automatic')};
        for (const [type, info] of Object.entries(DEVICE_TYPES))
            types[type] = info.label;
        const type = combo(_('Device type'), types, saved.type ?? 'auto', value => {
            save('type', value === 'auto' ? '' : value);
            refresh();
        });
        row.add_row(type);

        const customIcon = saved.icon && !Object.hasOwn(ICONS, saved.icon);
        const iconInput = new Adw.EntryRow({
            title: _('Icon name from the theme'),
            text: customIcon ? saved.icon : '',
            show_apply_button: true,
            visible: !!customIcon,
        });
        const invalidIcon = new Adw.ActionRow({
            title: _('Icon not found in the current theme'),
            visible: false,
        });
        iconInput.connect('changed', () => {
            iconInput.remove_css_class('error');
            invalidIcon.visible = false;
        });
        iconInput.connect('apply', () => {
            const value = iconInput.text.trim();
            if (value && (!/^[a-z0-9][a-z0-9._-]*$/i.test(value) || !theme.has_icon(value))) {
                iconInput.add_css_class('error');
                invalidIcon.visible = true;
                return;
            }
            save('icon', value);
            refresh();
        });
        const icon = combo(_('Icon'), {auto: N_('Use device type'), ...ICONS, custom: N_('Custom icon name')},
            customIcon ? 'custom' : saved.icon ?? 'auto', value => {
                iconInput.visible = value === 'custom';
                invalidIcon.visible = false;
                if (value !== 'custom') {
                    save('icon', value === 'auto' ? '' : value);
                    refresh();
                }
            });
        row.add_row(icon);
        row.add_row(iconInput);
        row.add_row(invalidIcon);

        const reset = new Adw.ActionRow({title: _('Reset device settings'), activatable: true});
        reset.add_suffix(new Gtk.Image({icon_name: 'edit-undo-symbolic'}));
        reset.connect('activated', () => {
            name.text = '';
            place.selected = type.selected = icon.selected = 0;
            pin.active = false;
            iconInput.text = '';
            const devices = readDevices(settings, DEVICE_SETTINGS);
            delete devices[id];
            writeDevices(settings, DEVICE_SETTINGS, devices);
            refresh();
        });
        row.add_row(reset);
        return {row, update};
    }
}
