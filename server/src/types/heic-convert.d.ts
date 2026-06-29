declare module 'heic-convert' {
  interface ConvertOptions {
    buffer: Buffer | ArrayBuffer | Uint8Array;
    format: 'JPEG' | 'PNG';
    /** 0..1 (JPEG only). */
    quality?: number;
  }
  /** Decodes the first image of an HEIC/HEIF container to the requested format. */
  export default function convert(options: ConvertOptions): Promise<ArrayBuffer>;
}
