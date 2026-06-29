import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import https from 'node:https';
import type { Duplex } from 'node:stream';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { join, normalize, extname } from 'node:path';
import type { Logger } from 'pino';

/** Resolved backend target plus the transport agent to reach it. */
export interface BackendTarget {
  url: URL;
  rejectUnauthorized: boolean;
  /** Optional token forwarded as Authorization: Bearer (interactive login via cookies also works). */
  token?: string;
}

export interface HostOptions {
  /** Directory holding the built PhotoPrism SPA (frontend/dist). */
  distDir: string;
  /** Current backend, or null when the appliance is not yet provisioned. */
  getBackend: () => BackendTarget | null;
  /** Dynamic config.json body served to the SPA bootstrap. */
  getServedConfig: () => Record<string, unknown>;
  /** Inject a "Device Setup" deep link into index.html without touching vendored source. */
  injectSetupLink?: boolean;
  logger: Logger;
}

const PROXY_TIMEOUT_MS = 15000;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp4': 'video/mp4',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

const SETUP_LINK_SNIPPET =
  '<a href="/setup" id="pico-setup-link" style="position:fixed;right:12px;bottom:12px;z-index:99999;' +
  'background:#1d2733;color:#fff;font:600 12px/1 system-ui,sans-serif;padding:8px 12px;border-radius:8px;' +
  'text-decoration:none;opacity:.65;box-shadow:0 2px 8px rgba(0,0,0,.4)">Device&nbsp;Setup</a>';

/**
 * Static SPA server + reverse proxy for a vendored PhotoPrism build, ported from
 * scripts/photoprism-host.mjs. Operates on raw Node req/res so it can be mounted
 * via Fastify's serverFactory alongside the control API.
 */
export class PhotoPrismHost {
  private indexHtml: string | null = null;

  constructor(private readonly opts: HostOptions) {}

  private agentFor(b: BackendTarget) {
    return b.url.protocol === 'https:' ? https : http;
  }

  /** Reverse-proxy an /api/* request to the backend. */
  handleApiProxy(req: IncomingMessage, res: ServerResponse): void {
    const backend = this.opts.getBackend();
    if (!backend) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'NOT_PROVISIONED', message: 'No backend configured. Visit /setup.' } }));
      return;
    }
    const target = new URL(req.url ?? '/', backend.url);
    const headers: Record<string, string | string[] | undefined> = { ...req.headers, host: backend.url.host };
    delete headers['accept-encoding']; // avoid double-compression surprises
    if (backend.token) headers['authorization'] = `Bearer ${backend.token}`;

    const upstream = this.agentFor(backend).request(
      target,
      { method: req.method, headers, rejectUnauthorized: backend.rejectUnauthorized },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      }
    );
    upstream.on('error', (err: NodeJS.ErrnoException) => {
      const code = err.code ?? err.message;
      this.opts.logger.warn({ method: req.method, url: req.url, code }, 'proxy upstream failed');
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(`Bad gateway: backend ${backend.url.origin} unreachable (${code})`);
    });
    upstream.setTimeout(PROXY_TIMEOUT_MS, () => upstream.destroy(new Error('ETIMEDOUT')));
    req.pipe(upstream);
  }

  /** Proxy a websocket upgrade (PhotoPrism uses /api/v1/ws via sockette). */
  handleWsUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const backend = this.opts.getBackend();
    if (!backend) {
      socket.destroy();
      return;
    }
    const target = new URL(req.url ?? '/', backend.url);
    const headers = { ...req.headers, host: backend.url.host };
    const upstream = this.agentFor(backend).request(target, {
      method: req.method,
      headers,
      rejectUnauthorized: backend.rejectUnauthorized,
    });
    upstream.on('upgrade', (upRes, upSocket, upHead) => {
      const lines = [
        `HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage}`,
        ...Object.entries(upRes.headers).map(([k, v]) => `${k}: ${v as string}`),
        '\r\n',
      ];
      socket.write(lines.join('\r\n'));
      if (upHead?.length) socket.write(upHead);
      upSocket.pipe(socket);
      socket.pipe(upSocket);
      upSocket.on('error', () => socket.destroy());
      socket.on('error', () => upSocket.destroy());
    });
    upstream.on('error', () => socket.destroy());
    if (head?.length) upstream.write(head);
    upstream.end();
  }

  /** Serve the SPA, the dynamic config.json, and static assets with history fallback. */
  handleStatic(req: IncomingMessage, res: ServerResponse): void {
    const dist = this.opts.distDir;
    let urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]!);

    // SPA relative-path resilience: a deep route like /library/browse may request
    // /library/config.json or /library/static/... — normalize those back to root.
    if (urlPath.endsWith('/config.json')) {
      urlPath = '/config.json';
    } else if (urlPath.includes('/static/')) {
      urlPath = urlPath.substring(urlPath.indexOf('/static/'));
    }

    if (urlPath === '/config.json') {
      res.writeHead(200, { 'content-type': MIME['.json']!, 'cache-control': 'no-store' });
      res.end(JSON.stringify(this.opts.getServedConfig()));
      return;
    }

    const rel = normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
    let filePath = join(dist, rel);
    if (!filePath.startsWith(dist)) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    let stat = existsSync(filePath) ? statSync(filePath) : null;
    if (stat?.isDirectory()) {
      filePath = join(filePath, 'index.html');
      stat = existsSync(filePath) ? statSync(filePath) : null;
    }

    if (!stat) {
      if (extname(urlPath) === '') {
        filePath = join(dist, 'index.html'); // history-mode fallback
      } else {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
        return;
      }
    }

    // index.html: optionally inject the setup deep link, served from a small cache.
    if (filePath === join(dist, 'index.html')) {
      res.writeHead(200, { 'content-type': MIME['.html']!, 'cache-control': 'no-cache' });
      res.end(this.renderIndexHtml(filePath));
      return;
    }

    const type = MIME[extname(filePath)] ?? 'application/octet-stream';
    const cache = filePath.includes(`${join('static', 'build')}`)
      ? 'public, max-age=31536000, immutable'
      : 'no-cache';
    res.writeHead(200, { 'content-type': type, 'cache-control': cache });
    createReadStream(filePath).pipe(res);
  }

  private renderIndexHtml(filePath: string): string {
    if (this.indexHtml == null) {
      let html = readFileSync(filePath, 'utf-8');
      if (this.opts.injectSetupLink && !html.includes('id="pico-setup-link"')) {
        html = html.includes('</body>')
          ? html.replace('</body>', `${SETUP_LINK_SNIPPET}</body>`)
          : html + SETUP_LINK_SNIPPET;
      }
      this.indexHtml = html;
    }
    return this.indexHtml;
  }

  /** One-shot backend reachability probe used by /health and post-deploy gating. */
  async probeBackend(): Promise<{ ok: boolean; status?: number; code?: string }> {
    const backend = this.opts.getBackend();
    if (!backend) return { ok: false, code: 'NOT_PROVISIONED' };
    return new Promise((resolve) => {
      const target = new URL('/api/v1/config', backend.url);
      const reqp = this.agentFor(backend).request(
        target,
        { method: 'GET', headers: { host: backend.url.host }, rejectUnauthorized: backend.rejectUnauthorized },
        (up) => {
          up.resume();
          resolve({ ok: (up.statusCode ?? 500) < 500, status: up.statusCode });
        }
      );
      reqp.on('error', (err: NodeJS.ErrnoException) => resolve({ ok: false, code: err.code ?? err.message }));
      reqp.setTimeout(8000, () => reqp.destroy(new Error('ETIMEDOUT')));
      reqp.end();
    });
  }
}
