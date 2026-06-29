import type { Readable } from 'stream';
import type { PhotoMeta, AuthStatus } from '@pico/shared';

export interface GetOriginalResult {
  stream: Readable;
  contentType: string;
  contentHash: string;
}

export interface PhotoSource {
  readonly name: string;
  readonly displayName: string;
  init(cfg: unknown): Promise<void>;
  authStatus(): Promise<AuthStatus>;
  authenticate(): Promise<AuthStatus>;
  listPhotos(limit: number, offset: number): Promise<PhotoMeta[]>;
  getOriginal(meta: PhotoMeta, w: number, h: number): Promise<GetOriginalResult>;
  setFavorite?(meta: PhotoMeta, favorite: boolean): Promise<void>;
  search?(q: string, limit: number, offset: number): Promise<PhotoMeta[]>;
  dispose(): Promise<void>;
}
