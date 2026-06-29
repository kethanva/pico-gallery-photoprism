// HEIC/HEIF decode fallback.
//
// sharp's prebuilt libvips ships without an HEIC decoding plugin (libheif is
// unbundled for licensing reasons), so `sharp(heicBuffer)` throws
// "No decoding plugin installed for this compression format". PhotoPrism and
// WebDAV already hand us JPEG/WebP thumbnails, but a local `directory` source
// can contain .heic straight off an iPhone. We decode those to JPEG with the
// pure-JS `heic-convert` (libheif compiled to wasm) before handing them to
// sharp for the actual resize.

// heic-convert ships no types; declared in src/types/heic-convert.d.ts.
import convert from 'heic-convert';

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

/** Decode an HEIC buffer to a JPEG buffer sharp can then resize. */
export async function heicToJpeg(buf: Buffer): Promise<Buffer> {
  const out = await convert({ buffer: buf, format: 'JPEG', quality: 0.92 });
  return Buffer.from(out);
}
