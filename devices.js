import {_} from './settings.js';

const UPOWER_TYPES = new Map([
    [5, 'mouse'], [6, 'keyboard'], [12, 'gamepad'], [17, 'headset'],
    [18, 'speaker'], [19, 'headphones'], [21, 'audio'], [28, 'other'],
]);

const CLASSIC_AUDIO = new Map([
    [1, 'headset'], [2, 'headset'], [5, 'speaker'], [6, 'headphones'], [7, 'audio'],
]);
const APPEARANCE = new Map([
    [0x03c1, 'keyboard'], [0x03c2, 'mouse'], [0x03c3, 'gamepad'], [0x03c4, 'gamepad'],
    [0x0840, 'audio'], [0x0841, 'speaker'], [0x0842, 'speaker'], [0x0843, 'speaker'],
    [0x0844, 'speaker'], [0x0845, 'speaker'], [0x0940, 'audio'], [0x0941, 'earbuds'],
    [0x0942, 'headset'], [0x0943, 'headphones'], [0x0944, 'headset'],
]);
const ICON_TYPES = new Map([
    ['input-keyboard', 'keyboard'], ['input-mouse', 'mouse'], ['input-gaming', 'gamepad'],
    ['audio-headphones', 'headphones'], ['audio-headset', 'headset'],
    ['audio-speakers', 'speaker'],
]);
const AUDIO_SERVICE = new Set(['1108', '110b', '110d', '111e', '184e']);

export function classify(name, props = {}, upowerType) {
    const appearance = APPEARANCE.get(props.Appearance);
    if (appearance && appearance !== 'audio')
        return appearance;

    // Classic Bluetooth often identifies both earbuds and headphones as headphones.
    if (/\b(ear\s?buds?|airpods(?!\s+max)|freebuds|galaxy\s*buds|pixel\s*buds|redmi\s*buds|buds|tws|in[- ]ear|wf[- ]\w+)\b/i.test(name))
        return 'earbuds';
    if (/\b(over[- ]ear|on[- ]ear|airpods\s+max|wh[- ]\w+|quietcomfort(?!\s+(ear)?buds)|headphones)\b/i.test(name))
        return 'headphones';
    if (/\b(speakers?|soundbar|jbl\s+(flip|charge|go|clip|xtreme|boombox))\b/i.test(name) || /колонка/i.test(name))
        return 'speaker';

    const major = (props.Class >> 8) & 0x1f;
    const minor = (props.Class >> 2) & 0x3f;
    if (major === 4 && CLASSIC_AUDIO.has(minor))
        return CLASSIC_AUDIO.get(minor);
    if (major === 5) {
        if (minor & 0x10)
            return 'keyboard';
        if (minor & 0x20)
            return 'mouse';
        if (minor === 1 || minor === 2)
            return 'gamepad';
    }

    const iconType = ICON_TYPES.get(props.Icon?.replace(/-symbolic$/, ''));
    if (iconType)
        return iconType;
    if (/\b(keyboard|aula[- ]?f\d+|keychron|mx keys)\b/i.test(name) || /клавіатур/i.test(name))
        return 'keyboard';
    if (/\b(mouse|mx master|mx anywhere|attack shark x\d+)\b/i.test(name) || /миша/i.test(name))
        return 'mouse';
    if (/\bheadset\b/i.test(name) || /гарнітур/i.test(name))
        return 'headset';
    if (upowerType && upowerType !== 'other')
        return upowerType;
    if (major === 4 || appearance || props.UUIDs?.some(uuid => AUDIO_SERVICE.has(uuid.slice(4, 8))))
        return 'audio';
    return 'other';
}

function address(value) {
    const match = value?.match(/(?:^|[^0-9a-f])(?:([0-9a-f]{2}(?:[:_-][0-9a-f]{2}){5}))(?=$|[^0-9a-f])/i);
    if (match)
        return match[1].replace(/[_-]/g, ':').toLowerCase();
    return /^[0-9a-f]{12}$/i.test(value ?? '')
        ? value.match(/../g).join(':').toLowerCase()
        : null;
}

export function validPercent(value) {
    return Number.isFinite(value) && value >= 0 && value <= 100;
}

export function collectDevices(bluezObjects, powerObjects, hidDevices) {
    const upowerByAddress = new Map();
    const devices = new Map();

    for (const [path, props] of powerObjects) {
        if (props.PowerSupply || (props.IsPresent === false && props.Type !== 0))
            continue;
        const btAddress = address(props.Serial) ?? address(props.NativePath);
        const type = UPOWER_TYPES.get(props.Type);
        const level = [3, 4, 6, 7, 8].includes(props.BatteryLevel) ? props.BatteryLevel : null;
        const unknownZero = props.BatteryLevel === 0 && props.Percentage === 0 && !props.State;
        const percent = level === null && !unknownZero && validPercent(props.Percentage)
            ? props.Percentage : null;
        const name = props.Model?.trim() || props.Vendor?.trim() || _('Wireless device');
        const deviceType = classify(name, {}, type);
        const unknownPeripheral = props.Type === 0 &&
            (percent !== null || level !== null || deviceType !== 'other');
        if (!type && !unknownPeripheral && !(props.Type === 2 && (btAddress || props.Model)))
            continue;
        const id = btAddress ? `bt:${btAddress}` : `upower:${path}`;
        const device = {
            id, name, type: deviceType, source: btAddress ? 'bluetooth' : 'upower',
            batterySource: 'upower', percent, level, charging: props.State === 1, connected: true,
        };
        devices.set(id, device);
        if (btAddress)
            upowerByAddress.set(btAddress, device);
    }

    for (const [path, interfaces] of Object.entries(bluezObjects)) {
        const props = interfaces['org.bluez.Device1'];
        if (!props)
            continue;
        const btAddress = address(props.Address) ?? address(path);
        if (!btAddress)
            continue;
        const power = upowerByAddress.get(btAddress);
        const battery = interfaces['org.bluez.Battery1']?.Percentage;
        const bluezHasReading = validPercent(battery);
        const name = props.Alias || props.Name || power?.name || _('Bluetooth device');
        const type = classify(props.Name || name, props, power?.type);
        const id = `bt:${btAddress}`;
        if (devices.get(id)?.source === 'bluetooth' &&
            devices.get(id) !== power && !props.Connected)
            continue;
        devices.delete(id);
        if (!(props.Connected || props.Paired || props.Bonded) ||
            (type === 'other' && !power && !bluezHasReading))
            continue;
        devices.set(id, {
            id, name, type, source: 'bluetooth', connected: !!props.Connected,
            batterySource: bluezHasReading || !power ? 'bluetooth' : 'upower',
            percent: bluezHasReading ? battery : power?.percent ?? null,
            level: bluezHasReading ? null : power?.level ?? null,
            charging: power?.charging ?? false,
        });
    }

    for (const [id, device] of Object.entries(hidDevices))
        devices.set(id, {...device, id, connected: true, source: 'receiver'});
    return [...devices.values()];
}
