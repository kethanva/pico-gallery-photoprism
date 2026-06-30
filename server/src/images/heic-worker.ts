// Worker thread for HEIC→JPEG decoding.
//
// libheif (via heic-convert) is compiled to wasm and decodes synchronously on
// the thread it runs on. Doing that on the server's main thread would block the
// event loop — SSE pings, health checks, the slide timer, and other image
// requests all stall for the seconds a large HEIC takes on a Pi-class CPU. So
// the decode runs here, off the main loop, one request at a time.

import { parentPort } from 'worker_threads';
import convert from 'heic-convert';

if (!parentPort) throw new Error('heic-worker must be run as a worker thread');

interface DecodeRequest {
  id: number;
  buffer: ArrayBuffer;
}

parentPort.on('message', (msg: DecodeRequest) => {
  void (async () => {
    try {
      const out = await convert({ buffer: Buffer.from(msg.buffer), format: 'JPEG', quality: 0.92 });
      const jpeg = Buffer.from(out);
      // Copy into a fresh standalone ArrayBuffer so it transfers back cleanly.
      const copy = new Uint8Array(jpeg.byteLength);
      copy.set(jpeg);
      parentPort!.postMessage({ id: msg.id, ok: true, buffer: copy.buffer }, [copy.buffer]);
    } catch (err) {
      parentPort!.postMessage({ id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  })();
});
