import { createHash } from 'crypto';
import { Readable } from 'stream';
import type { PhotoMeta, AuthStatus } from '@pico/shared';
import type { PhotoSource, GetOriginalResult } from './source.js';
import type { PhotoPrismConfig } from '../config/index.js';
import { sourceFetch, type SourceResponse } from './http.js';
import { logger } from '../telemetry/logger.js';

interface PrismPhoto {
  UID: string;
  FileName: string;
  Title: string;
  TakenAt: string;
  Width: number;
  Height: number;
  Favorite: boolean;
  Hash: string;
  Albums?: Array<{ Title: string }>;
}

interface PrismSession {
  id: string;            // session ID — used as X-Auth-Token for API requests
  downloadToken: string; // used in thumbnail URL path: /api/v1/t/{hash}/{downloadToken}/{size}
}

function snapThumbSize(size: number): number {
  // Standard PhotoPrism fit sizes: https://docs.photoprism.app/developer-guide/api/resources/thumbnails/
  const sizes = [320, 720, 1280, 1920, 2048, 3840];
  for (const s of sizes) {
    if (size <= s) return s;
  }
  return 3840;
}

export class PhotoPrismSource implements PhotoSource {
  readonly name = 'photoprism';
  readonly displayName = 'PhotoPrism';
  private cfg!: PhotoPrismConfig;
  private session: PrismSession | null = null;

  async init(cfg: unknown): Promise<void> {
    this.cfg = cfg as PhotoPrismConfig;
    await this.login();
  }

  async authStatus(): Promise<AuthStatus> {
    if (this.session) return { kind: 'authenticated' };
    return { kind: 'unauthenticated' };
  }

  async authenticate(): Promise<AuthStatus> {
    await this.login();
    return this.authStatus();
  }

  async listPhotos(limit: number, offset: number): Promise<PhotoMeta[]> {
    const params = this.buildSearchParams(limit, offset);
    const url = `${this.cfg.url}/api/v1/photos?${params}`;
    const resp = await this.doFetch(url);
    if (!resp.ok) {
      logger.error({ status: resp.status }, 'PhotoPrism list failed');
      return [];
    }
    const photos = (await resp.json()) as PrismPhoto[];
    return photos.map((p) => this.toMeta(p));
  }

  async getOriginal(meta: PhotoMeta, w: number, h: number): Promise<GetOriginalResult> {
    const hash = meta.contentHash ?? meta.extra?.['hash'] ?? meta.id.split(':')[1];
    const dlToken = this.session?.downloadToken ?? 'public';
    const size = snapThumbSize(Math.max(w, h));
    const thumbUrl = `${this.cfg.url}/api/v1/t/${hash}/${dlToken}/fit_${size}`;
    const resp = await this.doFetch(thumbUrl);
    if (!resp.ok) throw new Error(`PhotoPrism fetch failed: ${resp.status}`);
    const bytes = Buffer.from(await resp.arrayBuffer());
    // PhotoPrism's per-file Hash is the cache identity (set on PhotoMeta), so a
    // hit never reaches here; only hash the bytes if it was somehow left unset.
    const contentHash = meta.contentHash ?? createHash('sha256').update(bytes).digest('hex');
    const stream = Readable.from(bytes);
    const contentType = resp.headers.get('content-type') ?? 'image/jpeg';
    return { stream, contentType, contentHash };
  }

  async setFavorite(meta: PhotoMeta, favorite: boolean): Promise<void> {
    const localId = meta.id.slice(this.name.length + 1);
    const url = `${this.cfg.url}/api/v1/photos/${localId}/like`;
    await this.doFetch(url, { method: favorite ? 'POST' : 'DELETE' });
  }

  async search(q: string, limit: number, offset: number): Promise<PhotoMeta[]> {
    const params = new URLSearchParams({ q, count: String(limit), offset: String(offset) });
    const resp = await this.doFetch(`${this.cfg.url}/api/v1/photos?${params}`);
    if (!resp.ok) return [];
    const photos = (await resp.json()) as PrismPhoto[];
    return photos.map((p) => this.toMeta(p));
  }

  async dispose(): Promise<void> {
    if (this.session) {
      await this.doFetch(`${this.cfg.url}/api/v1/session/${this.session.id}`, { method: 'DELETE' }).catch(() => {});
      this.session = null;
    }
  }

  private async login(): Promise<void> {
    const password = this.cfg.appPassword ?? this.cfg.password;
    const resp = await this.doFetch(`${this.cfg.url}/api/v1/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: this.cfg.username, password }),
    });
    if (!resp.ok) {
      logger.error({ status: resp.status }, 'PhotoPrism login failed');
      return;
    }
    const data = (await resp.json()) as { id: string; config?: { downloadToken?: string } };
    this.session = { id: data.id, downloadToken: data.config?.downloadToken ?? 'public' };
    logger.info('PhotoPrism authenticated');
  }

  private buildSearchParams(limit: number, offset: number): URLSearchParams {
    const p = new URLSearchParams({ count: String(limit), offset: String(offset), order: this.cfg.order });
    // PhotoPrism takes a single album param; prefer `album`, else first of `albums`.
    const album = this.cfg.album ?? this.cfg.albums?.[0];
    if (album) p.set('album', album);
    if (this.cfg.favorites) p.set('favorite', 'true');
    if (this.cfg.quality) p.set('quality', String(this.cfg.quality));
    if (this.cfg.country) p.set('country', this.cfg.country);
    if (this.cfg.state) p.set('state', this.cfg.state);
    if (this.cfg.city) p.set('city', this.cfg.city);
    if (this.cfg.year) p.set('year', String(this.cfg.year));
    if (this.cfg.after) p.set('after', this.cfg.after);
    if (this.cfg.before) p.set('before', this.cfg.before);
    if (this.cfg.color) p.set('color', this.cfg.color);
    if (this.cfg.mono) p.set('mono', 'true');
    if (this.cfg.panorama) p.set('panorama', 'true');
    // PhotoPrism exposes a `portrait` boolean; there is no landscape/square flag.
    if (this.cfg.orientation === 'portrait') p.set('portrait', 'true');
    if (this.cfg.people?.length) p.set('subject', this.cfg.people.join(' '));
    if (this.cfg.labels?.length) p.set('label', this.cfg.labels.join(' '));
    if (this.cfg.keywords?.length) p.set('keywords', this.cfg.keywords.join(' '));
    if (this.cfg.mediaType) p.set('type', this.cfg.mediaType);
    if (this.cfg.memories) p.set('day', String(new Date().getDate()));
    if (this.cfg.query) p.set('q', this.cfg.query);
    if (!this.cfg.includePrivate) p.set('public', 'true');
    if (!this.cfg.includeArchived) p.set('archived', 'false');
    return p;
  }

  private toMeta(p: PrismPhoto): PhotoMeta {
    return {
      id: `photoprism:${p.UID}`,
      sourceName: 'photoprism',
      filename: p.FileName,
      title: p.Title || undefined,
      album: p.Albums?.[0]?.Title,
      takenAt: p.TakenAt,
      width: p.Width,
      height: p.Height,
      favorite: p.Favorite,
      contentHash: p.Hash,
      extra: { hash: p.Hash },
    };
  }

  private async doFetch(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<SourceResponse> {
    const headers: Record<string, string> = { 'X-Auth-Token': this.session?.id ?? '', ...(init?.headers ?? {}) };
    return sourceFetch(
      url,
      { method: init?.method, headers, body: init?.body },
      { skipTlsVerify: this.cfg.skipTlsVerify, timeoutSecs: this.cfg.requestTimeoutSecs }
    );
  }
}
