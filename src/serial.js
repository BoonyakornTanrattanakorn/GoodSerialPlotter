// Web Serial wrapper plus a fake source for dev mode. Both expose the same
// shape: connect() -> begins delivering complete text lines via onLine(line),
// write(text) sends back to the device, disconnect() stops cleanly.
//
// The read loop streams bytes through TextDecoderStream and splits on \n,
// carrying any partial trailing line across chunk boundaries so we never lose
// or fragment a sample at high data rates.

export function isSupported() {
  return typeof navigator !== 'undefined' && 'serial' in navigator;
}

export class SerialSource {
  constructor({ onLine, onStatus }) {
    this.onLine = onLine;
    this.onStatus = onStatus;
    this.port = null;
    this.reader = null;
    this.writer = null;
    this.keepReading = false;
    this.remainder = '';
  }

  async connect(baudRate) {
    this.port = await navigator.serial.requestPort();
    await this.port.open({ baudRate });
    this.onStatus?.(`Connected @ ${baudRate} baud`);

    if (this.port.writable) {
      this.writer = this.port.writable.getWriter();
    }

    this.keepReading = true;
    this.readLoop(); // fire and forget; loop owns its lifecycle
  }

  async readLoop() {
    const decoder = new TextDecoderStream();
    const readableClosed = this.port.readable.pipeTo(decoder.writable).catch(() => {});
    this.reader = decoder.readable.getReader();

    try {
      while (this.keepReading) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (value) this.ingest(value);
      }
    } catch (err) {
      this.onStatus?.(`Read error: ${err.message}`);
    } finally {
      try { this.reader.releaseLock(); } catch {}
      await readableClosed;
    }
  }

  ingest(chunk) {
    let buf = this.remainder + chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (line) this.onLine(line);
    }
    this.remainder = buf;
  }

  async write(text) {
    if (!this.writer) return;
    const data = new TextEncoder().encode(text);
    await this.writer.write(data);
  }

  async disconnect() {
    this.keepReading = false;
    try { await this.reader?.cancel(); } catch {}
    try { this.writer?.releaseLock(); } catch {}
    try { await this.port?.close(); } catch {}
    this.port = this.reader = this.writer = null;
    this.remainder = '';
    this.onStatus?.('Disconnected');
  }
}

// Emits ~1000 lines/sec of 3-channel synthetic data so the full pipeline can
// be exercised at the target rate without hardware. Batches per animation
// frame to avoid 1000 timer callbacks/sec.
export class FakeSource {
  constructor({ onLine, onStatus }) {
    this.onLine = onLine;
    this.onStatus = onStatus;
    this.running = false;
    this.t0 = 0;
    this.emitted = 0;
  }

  async connect() {
    this.running = true;
    this.t0 = performance.now();
    this.emitted = 0;
    this.onStatus?.('Dev mode: synthetic 1kHz, 3 channels');
    const tick = () => {
      if (!this.running) return;
      const elapsedMs = performance.now() - this.t0;
      const due = Math.floor(elapsedMs); // 1 sample per ms => 1000Hz
      while (this.emitted < due) {
        const t = this.emitted / 1000;
        const a = (Math.sin(t * 2 * Math.PI * 1.0) * 100).toFixed(2);
        const b = (Math.sin(t * 2 * Math.PI * 3.0) * 60 + 20).toFixed(2);
        const c = (Math.random() * 10).toFixed(2);
        this.onLine(`sine:${a},tri:${b},noise:${c}`);
        this.emitted++;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  async write() { /* no-op in dev mode */ }

  async disconnect() {
    this.running = false;
    this.onStatus?.('Disconnected');
  }
}
