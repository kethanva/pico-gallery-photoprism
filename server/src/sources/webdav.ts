import { createHash } from 'crypto';
import { Readable } from 'stream';
import type { PhotoMeta, AuthStatus } from '@pico/shared';
import type { PhotoSource, GetOriginalResult } from './source.js';
import type { WebDavConfig } from '../config/index.js';
import { sourceFetch, type SourceResponse } from './http.js';
import { logger } from '../telemetry/logger.js';

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.tiff', '.tif', '.heic', '.avif']);

interface DavEntry {
  href: string;
  isDir: boolean;
}

// WebDAV servers use different namespace prefixes for the DAV: namespace
// (`d:`, `D:`, `ns0:`, or none), so match any prefix case-insensitively rather
// than hard-coding `d:`.
const RESPONSE_RE = /<(?:[a-z0-9]+:)?response\b[^>]*>([\s\S]*?)<\/(?:[a-z0-9]+:)?response>/gi;
const HREF_RE = /<(?:[a-z0-9]+:)?href\b[^>]*>(.*?)<\/(?:[a-z0-9]+:)?href>/i;
const COLLECTION_RE = /<(?:[a-z0-9]+:)?collection\b/i;

function parsePropfind(xml: string): DavEntry[] {
  const entries: DavEntry[] = [];
  let m;
  while ((m = RESPONSE_RE.exec(xml)) !== null) {
    const block = m[1] ?? '';
    const href = HREF_RE.exec(block)?.[1]?.trim() ?? '';
    const isDir = COLLECTION_RE.test(block);
    entries.push({ href, isDir });
  }
  return entries;
}

export class WebDavSource implements PhotoSource {
  readonly name = 'webdav';
  readonly displayName = 'WebDAV';
  private cfg!: WebDavConfig;
  private photos: PhotoMeta[] = [];

  async init(cfg: unknown): Promise<void> {
    this.cfg = cfg as WebDavConfig;
    await this.scan();
  }

  async authStatus(): Promise<AuthStatus> {
    return { kind: 'authenticated' };
  }

  async authenticate(): Promise<AuthStatus> {
    return { kind: 'authenticated' };
  }

  async listPhotos(limit: number, offset: number): Promise<PhotoMeta[]> {
    return this.photos.slice(offset, offset + limit);
  }

  async getOriginal(meta: PhotoMeta, _w: number, _h: number): Promise<GetOriginalResult> {
    const url = meta.downloadUrl ?? meta.id.slice(this.name.length + 1);
    const resp = await this.doFetch(url);
    if (!resp.ok) throw new Error(`WebDAV fetch failed: ${resp.status}`);
    const bytes = Buffer.from(await resp.arrayBuffer());
    const contentHash = createHash('sha256').update(bytes).digest('hex');
    const stream = Readable.from(bytes);
    const contentType = resp.headers.get('content-type') ?? 'image/jpeg';
    return { stream, contentType, contentHash };
  }

  async dispose(): Promise<void> {}

  private async scan(): Promise<void> {
    const entries = await this.propfind(this.cfg.url, this.cfg.recursive ?? true);
    this.photos = entries
      .filter((e) => !e.isDir && IMAGE_EXTS.has(e.href.slice(e.href.lastIndexOf('.')).toLowerCase()))
      .map((e) => {
        const filename = decodeURIComponent(e.href.split('/').pop() ?? '');
        const origin = new URL(this.cfg.url).origin;
        return {
          id: `webdav:${e.href}`,
          sourceName: 'webdav',
          filename,
          width: 0,
          height: 0,
          favorite: false,
          downloadUrl: e.href.startsWith('http') ? e.href : `${origin}${e.href}`,
        };
      });
    logger.info({ count: this.photos.length }, 'WebDAV scan complete');
  }

  private async propfind(url: string, recursive: boolean): Promise<DavEntry[]> {
    const depth = recursive ? 'infinity' : '1';
    const resp = await this.doFetch(url, {
      method: 'PROPFIND',
      headers: { Depth: depth, 'Content-Type': 'application/xml' },
      body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>',
    });
    if (!resp.ok) {
      logger.error({ status: resp.status }, 'WebDAV PROPFIND failed');
      return [];
    }
    const xml = await resp.text();
    return parsePropfind(xml);
  }

  private async doFetch(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<SourceResponse> {
    const headers: Record<string, string> = { ...(init?.headers ?? {}) };
    if (this.cfg.token) {
      headers['Authorization'] = `Bearer ${this.cfg.token}`;
    } else if (this.cfg.username) {
      headers['Authorization'] = `Basic ${Buffer.from(`${this.cfg.username}:${this.cfg.password ?? ''}`).toString('base64')}`;
    }
    return sourceFetch(
      url,
      { method: init?.method, headers, body: init?.body },
      { skipTlsVerify: this.cfg.skipTlsVerify }
    );
  }
}
