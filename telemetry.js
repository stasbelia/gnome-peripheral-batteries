import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// A pending read must finish (including cancellation) before closing its pipe.
// This class keeps that order even when GNOME disables an extension mid-read.
export class TelemetryReader {
    constructor(argv, onData, onError) {
        this._closed = false;
        this._reading = false;
        this._onData = onData;
        this._onError = onError;
        this._cancellable = new Gio.Cancellable();
        this._process = Gio.Subprocess.new(argv,
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        this._stream = new Gio.DataInputStream({base_stream: this._process.get_stdout_pipe()});
        this._completion = new Promise(resolve => { this._resolveClosed = resolve; });
        this._read();
    }

    _read() {
        if (this._closed)
            return;
        this._reading = true;
        this._stream.read_line_async(GLib.PRIORITY_DEFAULT, this._cancellable, (stream, result) => {
            this._reading = false;
            try {
                const [bytes] = stream.read_line_finish(result);
                if (!this._closed) {
                    if (bytes === null)
                        throw new Error('The monitoring process exited.');
                    this._onData(JSON.parse(new TextDecoder().decode(bytes)));
                }
            } catch (error) {
                if (!this._closed) {
                    this._onError(error);
                    this.close();
                }
            }
            if (this._closed)
                this._closeStream();
            else
                this._read();
        });
    }

    close() {
        if (!this._closed) {
            this._closed = true;
            this._cancellable.cancel();
            this._process.force_exit();
            this._process = null;
            if (!this._reading)
                this._closeStream();
        }
        return this._completion;
    }

    _closeStream() {
        const stream = this._stream;
        if (!stream)
            return;
        this._stream = null;
        stream.close_async(GLib.PRIORITY_DEFAULT, null, (source, result) => {
            try {
                source.close_finish(result);
            } catch (error) {
                console.warn(`Peripheral Batteries pipe: ${error.message}`);
            }
            this._resolveClosed();
        });
    }
}
