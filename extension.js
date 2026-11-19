import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {collectDevices, validPercent} from './devices.js';
import {_, N_, BATTERY_DIAGNOSTICS, DEVICE_TYPES, iconFor, preferencesFor, readDevices, writeDevices} from './settings.js';
import {SystemBatteries} from './system-batteries.js';
import {TelemetryReader} from './telemetry.js';

const QUICK_COLUMNS = 2;
const TITLE = N_('Peripheral Batteries');
const BATTERY_ICON = 'battery-symbolic';
const LEVELS = {3: N_('Low'), 4: N_('Critical'), 6: N_('Normal'), 7: N_('High'), 8: N_('Full')};

function batteryStatus(device, level, showStale) {
    if (!device.connected)
        return 'disconnected';
    if (validPercent(device.percent))
        return device.stale ? (showStale ? 'stale' : 'stale-hidden') : 'percentage';
    if (level)
        return 'level';
    if (Object.hasOwn(BATTERY_DIAGNOSTICS, device.error))
        return device.error;
    return device.source === 'receiver' ? 'waiting' : 'no-reading';
}

export default class PeripheralBatteries extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._known = readDevices(this._settings, 'known-devices');
        this._bluez = {};
        this._power = [];
        this._hid = {};
        this._readerAttempts = 0;
        this._settingsChanged = this._settings.connect('changed', (_, key) => {
            if (key !== 'known-devices')
                this._render();
        });

        this._createPanel();
        if (!this._attachQuickRow()) {
            let attempts = 0;
            this._waitId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
                if (!this._attachQuickRow() && ++attempts < 50)
                    return GLib.SOURCE_CONTINUE;
                this._waitId = 0;
                return GLib.SOURCE_REMOVE;
            });
        }

        this._system = new SystemBatteries((bluez, power) => {
            this._bluez = bluez;
            this._power = power;
            this._render();
        });
        this._startReader();
        this._render();
    }

    _openPreferences() {
        Main.panel.statusArea.quickSettings.menu.close();
        this._panel.menu.close();
        this.openPreferences();
    }

    _createPanel() {
        this._panel = new PanelMenu.Button(0.0, _(TITLE));
        this._panel.hide();
        Main.panel.addToStatusArea(this.uuid, this._panel, 0, 'right');
        this._panelBox = new St.BoxLayout({style_class: 'peripheral-batteries-panel'});
        this._panel.add_child(this._panelBox);
        this._panelRows = {box: this._panelBox, rows: new Map()};
        this._panelDetails = this._addDetails(this._panel.menu);
    }

    _addDetails(menu) {
        const section = new PopupMenu.PopupMenuSection();
        menu.addMenuItem(section);
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        menu.addAction(_('Extension Preferences'), () => this._openPreferences(),
            'emblem-system-symbolic');
        return {section, rows: new Map()};
    }

    _attachQuickRow() {
        // GNOME 51 provides a different spacer depending on the battery button.
        const item = Main.panel.statusArea.quickSettings._system?._systemItem;
        if (!item?._laptopSpacer || !item?._desktopSpacer)
            return false;

        this._laptopSpacer = item._laptopSpacer;
        this._desktopSpacer = item._desktopSpacer;
        const lockButton = item.child.get_children().find(child =>
            child.icon_name === 'system-lock-screen-symbolic');
        if (lockButton)
            this._lockSlot = {button: lockButton, parent: item.child, next: lockButton.get_next_sibling()};

        const grid = new Clutter.GridLayout({column_spacing: 9, row_spacing: 2});
        const box = new St.Widget({
            style_class: 'peripheral-batteries-quick',
            layout_manager: grid,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._inlineButton = new St.Button({
            can_focus: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            child: box,
        });
        this._inlineButton.connect('clicked', () => this._openPreferences());
        this._inlineRows = {box, grid, rows: new Map()};
        this._spacerChanged = this._laptopSpacer.connect('notify::visible', () => this._moveQuickRow());
        this._moveQuickRow();
        this._render();
        return true;
    }

    _moveQuickRow() {
        const spacer = this._laptopSpacer.visible ? this._laptopSpacer : this._desktopSpacer;
        this._detachQuickRow();
        this._savedSpacer = {spacer, layout: spacer.layout_manager};
        this._spacerLayout = new Clutter.BinLayout();
        spacer.layout_manager = this._spacerLayout;
        spacer.add_child(this._inlineButton);
    }

    _detachQuickRow() {
        if (!this._savedSpacer)
            return;
        const {spacer, layout} = this._savedSpacer;
        spacer.remove_child(this._inlineButton);
        if (spacer.layout_manager === this._spacerLayout)
            spacer.layout_manager = layout;
        this._savedSpacer = this._spacerLayout = null;
    }

    _setLockHidden(hidden) {
        if (!this._lockSlot)
            return;
        const {button, parent, next} = this._lockSlot;
        // Leave GNOME's can-lock-screen visibility binding in place.
        if (hidden && button.get_parent() === parent)
            parent.remove_child(button);
        else if (!hidden && !button.get_parent())
            parent.insert_child_below(button, next);
    }

    _startReader() {
        const retry = error => {
            console.warn(`Peripheral Batteries: ${error.message}`);
            this._hid = {};
            this._render();
            const delay = Math.min(60, 5 * 2 ** this._readerAttempts);
            if (delay < 60)
                this._readerAttempts++;
            this._retryId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, delay, () => {
                this._retryId = 0;
                this._startReader();
                return GLib.SOURCE_REMOVE;
            });
        };
        try {
            this._reader = new TelemetryReader([
                'python3', '-u', GLib.build_filenamev([this.path, 'monitor.py']), '--device-list',
            ], data => {
                this._readerAttempts = 0;
                this._hid = data;
                this._render();
            }, retry);
        } catch (error) {
            retry(error);
        }
    }

    _render() {
        const devices = collectDevices(this._bluez, this._power, this._hid);
        const deviceSettings = readDevices(this._settings, 'device-settings');
        const placement = this._settings.get_string('placement');
        const showUnknown = this._settings.get_boolean('show-unknown');
        const showStale = this._settings.get_boolean('show-stale');
        const threshold = this._settings.get_int('low-threshold');
        const quick = [];
        const panel = [];
        const seen = new Set();

        for (const device of devices) {
            const {id, name, type, source, connected} = device;
            const level = LEVELS[device.level] && _(LEVELS[device.level]);
            const status = batteryStatus(device, level, showStale);
            this._known[id] = {name, type, source, batterySource: device.batterySource ?? source, status};
            seen.add(id);
            if (!connected)
                continue;

            const settings = preferencesFor(deviceSettings, id);
            const place = settings.placement || placement;
            const info = DEVICE_TYPES[settings.type] ?? DEVICE_TYPES[type] ?? DEVICE_TYPES.other;
            const percent = validPercent(device.percent) && (!device.stale || showStale)
                ? Math.round(device.percent) : null;
            if (place === 'hidden' || (!showUnknown && percent === null && !level))
                continue;

            const displayName = settings.name || name;
            const charge = percent === null ? level ?? '—' : `${device.stale ? '~' : ''}${percent}%`;
            const details = [
                charge !== '—' && charge,
                device.charging && _('charging'),
                status !== 'percentage' && _(BATTERY_DIAGNOSTICS[status]),
            ].filter(Boolean).join(', ');
            let state = '';
            if (device.stale || charge === '—')
                state = 'stale';
            else if (device.charging)
                state = 'charging';
            else if ((threshold > 0 && percent !== null && percent <= threshold) || [3, 4].includes(device.level))
                state = 'low';

            const row = {
                id, name: displayName, type: _(info.label), icon: settings.icon || info.icon,
                charge, details, state, pinned: settings.pinned === 'true',
            };
            if (place === 'quick' || place === 'both')
                quick.push(row);
            if (place === 'panel' || place === 'both')
                panel.push(row);
        }
        for (const [id, device] of Object.entries(this._known)) {
            if (!seen.has(id))
                device.status = 'disconnected';
        }
        writeDevices(this._settings, 'known-devices', this._known);

        for (const list of [quick, panel]) {
            list.sort((a, b) => Number(b.pinned) - Number(a.pinned) ||
                Number(a.charge === '—') - Number(b.charge === '—') ||
                a.name.localeCompare(b.name, undefined, {numeric: true}));
        }

        const panelLimit = this._settings.get_int('panel-limit');
        this._syncRows(this._panelRows, panel.slice(0, panelLimit),
            this._settings.get_boolean('panel-names'));
        this._panelOverflow = this._syncOverflow(this._panelBox, this._panelOverflow, panel.length - panelLimit);
        this._syncRows(this._panelDetails, panel, true);
        this._panel.visible = panel.length > 0;
        this._panel.accessible_name = panel.map(row => `${row.name}, ${row.details}`).join('. ') || _(TITLE);
        if (!this._panel.visible)
            this._panel.menu.close();

        if (this._inlineRows) {
            this._syncRows(this._inlineRows, quick);
            this._inlineButton.visible = quick.length > 0;
            this._inlineButton.accessible_name = quick.map(row => `${row.name}, ${row.details}`).join('. ') || _(TITLE);
            this._setLockHidden(quick.length > 0 && this._settings.get_boolean('hide-lock-button'));
        }
    }

    _syncOverflow(box, label, extra) {
        if (extra > 0) {
            if (!label) {
                label = new St.Label({
                    style_class: 'peripheral-battery-overflow',
                    y_align: Clutter.ActorAlign.CENTER,
                });
                box.add_child(label);
            }
            box.set_child_above_sibling(label, null);
            label.text = `+${extra}`;
        } else {
            label?.destroy();
            label = null;
        }
        return label;
    }

    _syncRows(surface, devices, showNames = false) {
        const ids = devices.map(({id}) => id);
        if (ids.length !== surface.rows.size || ids.some((id, index) => id !== surface.ids?.[index])) {
            for (const row of surface.rows.values())
                row.actor.destroy();
            surface.rows.clear();
            surface.ids = ids;
            ids.forEach((id, index) => surface.rows.set(id, this._addRow(surface, index)));
        }

        for (const device of devices) {
            const row = surface.rows.get(device.id);
            if (row.iconName !== device.icon) {
                row.icon.gicon = iconFor(this.path, device.icon);
                row.iconName = device.icon;
            }
            row.name.visible = showNames;
            row.name.text = device.name;
            row.label.text = device.charge;
            row.label.style_class = ['peripheral-battery-label',
                device.state && `peripheral-battery-${device.state}`].filter(Boolean).join(' ');
            row.actor.accessible_name = `${device.name}, ${device.type}, ${device.details}`;
        }
    }

    _addRow({box, grid, section}, index) {
        const menu = section
            ? new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false})
            : null;
        const actor = menu ?? new St.BoxLayout({style_class: 'peripheral-battery-row'});
        const icon = new St.Icon({
            style_class: menu ? 'popup-menu-icon' : 'peripheral-battery-icon',
            fallback_icon_name: BATTERY_ICON,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const name = new St.Label({
            style_class: menu ? 'peripheral-battery-menu-name' : 'peripheral-battery-panel-name',
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: !!menu,
        });
        name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        const label = new St.Label({y_align: Clutter.ActorAlign.CENTER});
        actor.add_child(icon);
        actor.add_child(name);
        actor.add_child(label);
        if (menu)
            section.addMenuItem(menu);
        else if (grid)
            grid.attach(actor, index % QUICK_COLUMNS, Math.floor(index / QUICK_COLUMNS), 1, 1);
        else
            box.add_child(actor);
        return {actor, icon, name, label};
    }

    disable() {
        for (const id of [this._waitId, this._retryId]) {
            if (id)
                GLib.source_remove(id);
        }
        this._waitId = this._retryId = 0;
        this._system?.close();
        this._reader?.close();
        if (this._settingsChanged)
            this._settings.disconnect(this._settingsChanged);
        this._settingsChanged = 0;

        if (this._laptopSpacer) {
            this._laptopSpacer.disconnect(this._spacerChanged);
            this._detachQuickRow();
            this._inlineButton.destroy();
            this._setLockHidden(false);
        }
        this._panel?.destroy();

        this._settings = this._system = this._reader = this._known = null;
        this._bluez = this._power = this._hid = null;
        this._laptopSpacer = this._desktopSpacer = this._lockSlot = this._inlineButton = null;
        this._panel = this._panelBox = this._panelOverflow = null;
        this._inlineRows = this._panelRows = this._panelDetails = null;
    }
}
