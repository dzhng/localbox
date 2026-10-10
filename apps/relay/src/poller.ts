import type { RequestEnvelope, ResponseEnvelope } from "../../../packages/contract/src/index.js";

export interface HostPollerFrame {
  request_id: string;
  operation: string;
  vm_id: string;
  mutation_id?: string | null;
  deadline_ms?: number;
  payload: unknown;
  lease_owner?: string;
}

export interface HostPollerOptions {
  relayUrl: string;
  channelId: string;
  channelToken: string;
  channelEpoch: number;
  vmId: string;
  leaseOwner: string;
  dispatch: (request: RequestEnvelope) => Promise<ResponseEnvelope>;
  fetchImpl?: typeof fetch;
  pollMs?: number;
  leaseMs?: number;
  batchSize?: number;
}

/**
 * Mac-side outbound poller. It only dials HTTPS and hands frames to the
 * already-authenticated guest channel supplied by `dispatch`.
 */
export class RelayHostPoller {
  private readonly options: Required<Pick<HostPollerOptions, "pollMs" | "leaseMs" | "batchSize">> & HostPollerOptions;
  private readonly fetchImpl: typeof fetch;
  private stopped = true;
  private loop?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(options: HostPollerOptions) {
    this.options = { ...options, pollMs: options.pollMs ?? 250, leaseMs: options.leaseMs ?? 30_000, batchSize: options.batchSize ?? 20 };
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async pollOnce(signal?: AbortSignal): Promise<number> {
    const response = await this.fetchImpl(`${this.options.relayUrl.replace(/\/$/, "")}/host/poll`, {
      method: "POST",
      headers: this.channelHeaders(),
      body: JSON.stringify({ lease_owner: this.options.leaseOwner, lease_ms: this.options.leaseMs, limit: this.options.batchSize }),
      signal,
    });
    if (!response.ok) throw new Error(`relay poll failed (${response.status}): ${await response.text()}`);
    const result = await response.json() as { epoch?: number; frames?: HostPollerFrame[] };
    if (result.epoch !== undefined && result.epoch !== this.options.channelEpoch) throw new Error("relay returned a stale channel epoch");
    const frames = result.frames ?? [];
    for (const frame of frames) await this.complete(frame, signal);
    return frames.length;
  }

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.loop;
    this.loop = undefined;
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      try { await this.pollOnce(); }
      catch { /* reconnect/backoff is bounded by the next poll; daemon owns logging */ }
      if (!this.stopped) await new Promise<void>((resolve) => { this.timer = setTimeout(resolve, this.options.pollMs); this.timer.unref?.(); });
    }
  }

  private async complete(frame: HostPollerFrame, signal?: AbortSignal): Promise<void> {
    if (frame.vm_id !== this.options.vmId) throw new Error("relay frame is bound to another VM");
    const candidate = frame.payload as Partial<RequestEnvelope>;
    const request: RequestEnvelope = candidate && typeof candidate === "object" && candidate.protocol_version === "v1" && "input" in candidate
      ? candidate as RequestEnvelope
      : {
        protocol_version: "v1",
        request_id: frame.request_id,
        operation: frame.operation,
        vm_id: frame.vm_id,
        deadline_ms: frame.deadline_ms ?? 30_000,
        mutation_id: frame.mutation_id ?? null,
        input: frame.payload as RequestEnvelope["input"],
      };
    if (request.request_id !== frame.request_id || request.vm_id !== this.options.vmId) throw new Error("relay frame request identity mismatch");
    const response = await this.options.dispatch(request);
    const result = await this.fetchImpl(`${this.options.relayUrl.replace(/\/$/, "")}/host/responses/${encodeURIComponent(frame.request_id)}`, {
      method: "POST",
      headers: { ...this.channelHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ lease_owner: this.options.leaseOwner, response }),
      signal,
    });
    if (!result.ok) throw new Error(`relay response failed (${result.status}): ${await result.text()}`);
  }

  private channelHeaders(): Record<string, string> {
    return { "content-type": "application/json", "x-channel-id": this.options.channelId, "x-channel-token": this.options.channelToken, "x-channel-epoch": String(this.options.channelEpoch), "x-vm-id": this.options.vmId };
  }
}

