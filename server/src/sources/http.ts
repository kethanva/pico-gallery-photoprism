import { fetch as undiciFetch, Agent } from 'undici';

// Shared HTTP client for remote sources (PhotoPrism, WebDAV). Adds two things the
// global fetch can't express portably:
//   • TLS opt-out for self-signed LAN servers (skipTlsVerify) via a dispatcher
//   • a hard per-request timeout so a hung backend can't wedge playlist building
//
// We use undici's fetch (not Node's global fetch) so the Agent dispatcher is
// guaranteed compatible with the client issuing the request.

// One reusable insecure dispatcher; building an Agent per request leaks sockets.
const insecureAgent = new Agent({ connect: { rejectUnauthorized: false } });

export type SourceFetchInit = Parameters<typeof undiciFetch>[1];
export type SourceResponse = Awaited<ReturnType<typeof undiciFetch>>;

export interface SourceFetchOpts {
  skipTlsVerify?: boolean;
  /** Hard timeout for the whole request. Defaults to 30s. */
  timeoutSecs?: number;
}

export function sourceFetch(
  url: string,
  init: SourceFetchInit = {},
  opts: SourceFetchOpts = {}
): Promise<SourceResponse> {
  const { skipTlsVerify = false, timeoutSecs = 120 } = opts;
  return undiciFetch(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutSecs * 1000),
    ...(skipTlsVerify ? { dispatcher: insecureAgent } : {}),
  });
}
