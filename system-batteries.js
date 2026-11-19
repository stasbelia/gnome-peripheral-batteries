import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const BLUEZ = 'org.bluez';
const UPOWER = 'org.freedesktop.UPower';
const PROPERTIES = 'org.freedesktop.DBus.Properties';
const OBJECTS = 'org.freedesktop.DBus.ObjectManager';
const POWER_DEVICE = `${UPOWER}.Device`;

Gio._promisify(Gio, 'bus_get', 'bus_get_finish');
Gio._promisify(Gio.DBusConnection.prototype, 'call', 'call_finish');

export class SystemBatteries {
    constructor(onChange) {
        this._onChange = onChange;
        this._cancellable = new Gio.Cancellable();
        this._signals = [];
        this._refreshing = false;
        this._queued = false;
        this._refreshId = 0;
        this._periodicId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 30, () => {
            this._start();
            return GLib.SOURCE_CONTINUE;
        });
        this._start();
    }

    async _start() {
        if (this._bus) {
            this._schedule();
            return;
        }
        try {
            const bus = await Gio.bus_get(Gio.BusType.SYSTEM, this._cancellable);
            if (this._cancellable.is_cancelled() || this._bus)
                return;
            this._bus = bus;
            this._watch(BLUEZ, OBJECTS, 'InterfacesAdded');
            this._watch(BLUEZ, OBJECTS, 'InterfacesRemoved');
            this._watch(BLUEZ, PROPERTIES, 'PropertiesChanged', 'org.bluez.Device1');
            this._watch(BLUEZ, PROPERTIES, 'PropertiesChanged', 'org.bluez.Battery1');
            this._watch(UPOWER, UPOWER, 'DeviceAdded');
            this._watch(UPOWER, UPOWER, 'DeviceRemoved');
            this._watch(UPOWER, PROPERTIES, 'PropertiesChanged', POWER_DEVICE);
            for (const service of [BLUEZ, UPOWER])
                this._watch('org.freedesktop.DBus', 'org.freedesktop.DBus', 'NameOwnerChanged', service);
            this._schedule();
        } catch (error) {
            if (!this._cancellable.is_cancelled())
                console.debug(`Peripheral Batteries: ${error.message}`);
        }
    }

    _watch(sender, iface, member, arg0 = null) {
        const id = this._bus.signal_subscribe(sender, iface, member, null, arg0,
            Gio.DBusSignalFlags.NONE, () => this._schedule());
        this._signals.push(id);
    }

    _schedule() {
        if (this._cancellable.is_cancelled() || this._refreshId)
            return;
        if (this._refreshing) {
            this._queued = true;
            return;
        }
        this._refreshId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
            this._refreshId = 0;
            this._refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    async _call(name, path, iface, method, params = null) {
        const reply = await this._bus.call(name, path, iface, method, params, null,
            Gio.DBusCallFlags.NONE, 3000, this._cancellable);
        return reply.recursiveUnpack()[0];
    }

    async _getUPower() {
        const paths = await this._call(UPOWER, '/org/freedesktop/UPower', UPOWER, 'EnumerateDevices');
        const result = await Promise.allSettled(paths.map(async path =>
            [path, await this._call(UPOWER, path, PROPERTIES, 'GetAll',
                new GLib.Variant('(s)', [POWER_DEVICE]))]));
        return result.filter(item => item.status === 'fulfilled').map(item => item.value);
    }

    async _refresh() {
        this._refreshing = true;
        try {
            const [bluez, power] = await Promise.allSettled([
                this._call(BLUEZ, '/', OBJECTS, 'GetManagedObjects'), this._getUPower(),
            ]);
            if (!this._cancellable.is_cancelled())
                this._onChange(bluez.value ?? {}, power.value ?? []);
        } finally {
            this._refreshing = false;
            if (this._queued) {
                this._queued = false;
                this._schedule();
            }
        }
    }

    close() {
        this._cancellable.cancel();
        GLib.source_remove(this._periodicId);
        if (this._refreshId)
            GLib.source_remove(this._refreshId);
        for (const id of this._signals)
            this._bus.signal_unsubscribe(id);
    }
}
