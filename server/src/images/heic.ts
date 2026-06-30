// HEIC/HEIF decode fallback.
//
// sharp's prebuilt libvips ships without an HEIC decoding plugin (libheif is
// unbundled for licensing reasons), so `sharp(heicBuffer)` throws
// "No decoding plugin installed for this compression format". PhotoPrism and
// WebDAV already hand us JPEG/WebP thumbnails, but a local `directory` source
// can contain .heic straight off an iPhone. We decode those to JPEG with the
// pure-JS `heic-convert` (libheif compiled to wasm) before handing them to
// sharp for the actual resize.
//
// The decode itself runs in a worker thread (see heic-worker.ts): libheif's
// wasm is CPU-bound and synchronous, so decoding on the main thread would stall
// the event loop for the seconds a large HEIC takes on a Pi. The worker also
// isolates the (large) decode allocation from the server's capped main heap.

import { Worker } from 'worker_threads';
import { logger } from '../telemetry/logger.js';

/**
 * Detect an ISO-BMFF HEIC/HEIF container by its `ftyp` box brand. The first 4
 * bytes are the box size, bytes 4-8 are the type ("ftyp"), and bytes 8-12 are
 * the major brand. We match the still-image brands here (heic/heix/mif1/heif/
 * hevc/hevx) and deliberately exclude AVIF ("avif"), which sharp decodes natively.
 */
export function isHeic(buf: Buffer): boolean {
  if (buf.length < 12) return false;
  if (buf.toString('ascii', 4, 8) !== 'ftyp') return false;
  const brand = buf.toString('ascii', 8, 12);
  return ['heic', 'heix', 'mif1', 'heif', 'hevc', 'hevx', 'msf1'].includes(brand);
}

interface WorkerReply {
  id: number;
  ok: boolean;
  buffer?: ArrayBuffer;
  error?: string;
}
interface Pending {
  resolve: (b: Buffer) => void;
  reject: (e: Error) => void;
}

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, Pending>();

function failAll(err: Error): void {
  for (const p of pending.values()) p.reject(err);
  pending.clear();
  worker = null; // respawn on the next call
}

function getWorker(): Worker {
  if (worker) return worker;
  // tsx (dev) runs this module as .ts and runs the .ts worker directly; the
  // built server runs as .js next to the compiled worker. Match the extension
  // of the running module so both work.
  const ext = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
  const w = new Worker(new URL(`./heic-worker.${ext}`, import.meta.url));
  w.on('message', (msg: WorkerReply) => {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.ok && msg.buffer) p.resolve(Buffer.from(msg.buffer));
    else p.reject(new Error(msg.error ?? 'HEIC decode failed'));
  });
  w.on('error', (err) => {
    logger.error({ err }, 'HEIC worker error');
    failAll(err);
  });
  w.on('exit', (code) => {
    if (pending.size) failAll(new Error(`HEIC worker exited (code ${code})`));
    else worker = null;
  });
  w.unref(); // don't let an idle worker keep the process alive
  worker = w;
  return w;
}

/** Decode an HEIC buffer to a JPEG buffer (off the event loop) sharp can resize. */
export function heicToJpeg(buf: Buffer): Promise<Buffer> {
  const w = getWorker();
  const id = ++seq;
  // Copy into a fresh standalone ArrayBuffer (typed ArrayBuffer, not the
  // ArrayBufferLike union) so it can be transferred without detaching a pooled one.
  const copy = new Uint8Array(buf.byteLength);
  copy.set(buf);
  const ab = copy.buffer;
  return new Promise<Buffer>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ id, buffer: ab }, [ab]);
  });
}
