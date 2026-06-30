import type { SlideshowState, ControlAction, DisplayConfig } from '@pico/shared';

const BASE = '/api/v1';

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...init?.headers },
    ...init,
  });
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({})) as { error?: { message?: string } };
    throw new Error(body?.error?.message ?? `HTTP ${resp.status}`);
  }
  return resp.json() as Promise<T>;
}

export function imageUrl(id: string, w: number, h: number, fit = 'contain'): string {
  return `${BASE}/photos/${encodeURIComponent(id)}/image?w=${w}&h=${h}&fit=${fit}&fmt=auto`;
}

export const api = {
  getState: () => apiFetch<SlideshowState>('/slideshow/state'),
  control: (action: ControlAction) => apiFetch<{ ok: true }>('/control', { method: 'POST', body: JSON.stringify(action) }),
  getConfig: () => apiFetch<DisplayConfig>('/config'),
};
