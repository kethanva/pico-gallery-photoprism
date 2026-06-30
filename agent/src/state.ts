import { isProvisioned, renderKioskConfig, type ApplianceConfig } from './config/schema.js';
import type { BackendTarget } from './http/proxy.js';

/**
 * Mutable runtime holder for the current appliance config. The proxy/static host
 * reads backend()/servedConfig() through this so a PUT /api/agent/config or a
 * deploy takes effect without restarting the process.
 */
export class AgentState {
  constructor(private cfg: ApplianceConfig) {}

  get config(): ApplianceConfig {
    return this.cfg;
  }

  setConfig(cfg: ApplianceConfig): void {
    this.cfg = cfg;
  }

  /** Backend target for the proxy, or null when not yet provisioned. */
  backend(): BackendTarget | null {
    if (!isProvisioned(this.cfg)) return null;
    return {
      url: new URL(this.cfg.backendUrl),
      rejectUnauthorized: !this.cfg.ignoreCertificateErrors,
      token: this.cfg.backendToken,
    };
  }

  /** Body served at GET /config.json to bootstrap the SPA. */
  servedConfig(): Record<string, unknown> {
    return renderKioskConfig(this.cfg) as unknown as Record<string, unknown>;
  }

  get provisioned(): boolean {
    return isProvisioned(this.cfg);
  }
}
