import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.PICO_SMOKE_ROOT ? resolve(process.env.PICO_SMOKE_ROOT) : join(HERE, "../../..");
const HOST_SCRIPT = join(ROOT, "scripts/photoprism-host.mjs");
const GATEWAY_TOKEN = "browser-smoke-gateway-token-32-chars";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

async function waitFor(url, attempts = 60) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // Process is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${url}`);
}

describe("built display host browser smoke", { timeout: 45000 }, () => {
  let backend;
  let backendPort;
  let host;
  let hostPort;
  let configPath;
  let browser;
  const upstreamRequests = [];

  before(async () => {
    backend = createServer((req, res) => {
      upstreamRequests.push(`${req.method} ${req.url}`);
      if (req.method === "POST" && req.url === "/api/v1/session") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "browser-smoke-session" }));
        return;
      }
      if (req.method === "GET" && req.url === "/api/v1/config") {
        assert.equal(req.headers["x-auth-token"], "browser-smoke-session");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ mode: "user", previewToken: "preview-token" }));
        return;
      }
      if (req.method === "GET" && req.url?.startsWith("/api/v1/photos?")) {
        assert.equal(req.headers["x-auth-token"], "browser-smoke-session");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify([{ UID: "photo-1", Title: "Production smoke photo", Hash: "abc123" }]));
        return;
      }
      if (req.method === "GET" && /^\/api\/v1\/t\/abc123\/preview-token\/fit_(720|1280)$/.test(req.url || "")) {
        assert.equal(req.headers["x-auth-token"], "browser-smoke-session");
        res.writeHead(200, { "content-type": "image/png", "content-length": PNG.length });
        res.end(PNG);
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end("{}");
    });
    await new Promise((resolve) => backend.listen(0, "127.0.0.1", resolve));
    backendPort = backend.address().port;

    configPath = join(tmpdir(), `pico-browser-smoke-${process.pid}.toml`);
    writeFileSync(configPath, [
      "[http]",
      'host = "127.0.0.1"',
      "[[sources]]",
      'name = "photoprism"',
      `url = "http://127.0.0.1:${backendPort}"`,
      'username = "frame-viewer"',
      'app_password = "app-password"',
    ].join("\n"), { mode: 0o600 });

    hostPort = 22000 + Math.floor(Math.random() * 1000);
    host = spawn(process.execPath, [HOST_SCRIPT], {
      cwd: ROOT,
      env: {
        ...process.env,
        PICO_CONFIG: configPath,
        PICO_PP_PORT: String(hostPort),
        PICO_PP_AUTH_TOKEN: GATEWAY_TOKEN,
        PICO_PP_PROBE_MS: "100",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await waitFor(`http://127.0.0.1:${hostPort}/api/v1/health`);
    browser = await chromium.launch({ executablePath: chromium.executablePath(), headless: true });
  });

  after(async () => {
    await browser?.close();
    if (host && host.exitCode === null) {
      host.kill("SIGTERM");
      await Promise.race([
        new Promise((resolve) => host.once("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
    }
    backend?.closeIdleConnections?.();
    backend?.closeAllConnections?.();
    await new Promise((resolve) => backend?.close(resolve));
    try {
      rmSync(configPath); 
    } catch { /* best effort */ }
  });

  it("boots the built SPA, exchanges gateway auth, renders a photo, and opens its preview", async () => {
    const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
    const pageErrors = [];
    const consoleErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") {
        consoleErrors.push(message.text());
      }
    });

    // The app deliberately performs background image prefetches, so networkidle
    // is not a valid readiness signal. DOM load plus the rendered card proves
    // boot completion without coupling the test to background scheduling.
    await page.goto(`http://127.0.0.1:${hostPort}/library/photos?token=${GATEWAY_TOKEN}`, {
      waitUntil: "domcontentloaded",
      timeout: 10000,
    });
    await page.locator(".pg-card").waitFor({ state: "attached", timeout: 10000 });
    assert.equal(await page.locator(".pg-card").getAttribute("title"), "Production smoke photo");
    assert.equal(new URL(page.url()).searchParams.has("token"), false);

    // The default Pi profile starts the slideshow automatically; opening the
    // preview intentionally hides the underlying grid to release image memory.
    await page.locator(".pg-overlay.is-open").waitFor({ state: "visible", timeout: 10000 });
    await page.waitForFunction(() => {
      const image = document.querySelector(".pg-preview");
      return image?.complete && image.naturalWidth > 0;
    }, undefined, { timeout: 10000 });
    assert.match(await page.locator(".pg-overlay-caption").textContent(), /Production smoke photo/);

    assert.deepEqual(pageErrors, []);
    assert.deepEqual(consoleErrors, []);
    assert.ok(upstreamRequests.some((entry) => entry.startsWith("GET /api/v1/photos?")));
    assert.ok(upstreamRequests.some((entry) => entry.includes("/api/v1/t/abc123/preview-token/fit_")));
    assert.equal(upstreamRequests.some((entry) => entry === "GET /api/v1/session"), false);
    await page.close();
  });
});
