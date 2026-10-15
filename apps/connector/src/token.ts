/** The machine was removed or its credential is no longer valid; retrying cannot help. */
export class RevokedError extends Error {
  constructor(message = "machine credential was revoked") { super(message); this.name = "RevokedError"; }
}

export interface MachineToken { token: string; expiresAt: number; convexUrl?: string }

export interface MachineTokenSourceOptions {
  apiOrigin: string;
  secret: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const REFRESH_MARGIN_MS = 5 * 60_000;

/** `expires_at` may be epoch seconds, epoch milliseconds, or an ISO date. */
function expiryMs(value: unknown): number {
  if (typeof value === "number") return value < 1e12 ? value * 1000 : value;
  if (typeof value === "string") { const parsed = Date.parse(value); if (Number.isFinite(parsed)) return parsed; }
  throw new Error("machine token response has no valid expires_at");
}

/** Exchanges the machine secret for a short-lived Convex JWT and caches it until 5 minutes before expiry. */
export class MachineTokenSource {
  private readonly url: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private cached?: MachineToken;
  private pending?: Promise<MachineToken>;
  constructor(private readonly options: MachineTokenSourceOptions) {
    this.url = `${options.apiOrigin.replace(/\/$/, "")}/api/relay/machine-token`;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async get(forceRefresh = false): Promise<MachineToken> {
    if (!forceRefresh && this.cached && this.now() < this.cached.expiresAt - REFRESH_MARGIN_MS) return this.cached;
    this.pending ??= this.fetchToken().finally(() => { this.pending = undefined; });
    return await this.pending;
  }

  private async fetchToken(): Promise<MachineToken> {
    const response = await this.fetchImpl(this.url, { method: "POST", headers: { authorization: `Bearer ${this.options.secret}` } });
    if (response.status === 401 || response.status === 403) { this.cached = undefined; throw new RevokedError(`machine token refused (${response.status})`); }
    if (!response.ok) throw new Error(`machine token request failed (${response.status})`);
    const body = await response.json() as { token?: unknown; expires_at?: unknown; convex_url?: unknown };
    if (typeof body.token !== "string" || !body.token) throw new Error("machine token response has no token");
    this.cached = { token: body.token, expiresAt: expiryMs(body.expires_at), ...(typeof body.convex_url === "string" ? { convexUrl: body.convex_url } : {}) };
    return this.cached;
  }
}
