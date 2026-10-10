export type LifecycleState = "stopped" | "starting" | "running" | "paused" | "stopping" | "error";
export type RecoveryEventKind = "sleep" | "wake" | "network_changed" | "channel_lost" | "channel_restored" | "guest_crashed" | "demand_changed" | "transition" | "retry" | "mutation_resolved";
export interface RecoveryEvent { at: number; kind: RecoveryEventKind; state: LifecycleState; detail?: string; epoch: number; }
export interface DemandState { work: number; viewers: number; graceMs: number; desktop: LifecycleState; }
export interface RecoveryOptions { now?: () => number; graceMs?: number; onTransition?: (state: LifecycleState) => void; }

/** Host-owned lifecycle/reconnect supervisor. Mutations are never retried implicitly. */
export class RecoverySupervisor {
  state: LifecycleState = "stopped";
  channelEpoch = 0;
  demand: DemandState;
  readonly timeline: RecoveryEvent[] = [];
  private readonly now: () => number;
  private readonly onTransition?: (state: LifecycleState) => void;
  private lastDemandAt = 0;
  constructor(options: RecoveryOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.onTransition = options.onTransition;
    this.demand = { work: 0, viewers: 0, graceMs: options.graceMs ?? 30_000, desktop: "stopped" };
  }
  private event(kind: RecoveryEventKind, detail?: string): void { this.timeline.push({ at: this.now(), kind, state: this.state, detail, epoch: this.channelEpoch }); }
  transition(next: LifecycleState, detail?: string): void { if (next === this.state) return; this.state = next; this.event("transition", detail); this.onTransition?.(next); }
  onSleep(): void { this.event("sleep"); if (this.state === "running") this.transition("paused", "host sleep"); }
  onWake(): void { this.event("wake"); if (this.state === "paused") { this.transition("starting", "wake reconnect"); this.transition("running", "channel restored"); } }
  onNetworkChanged(): void { this.event("network_changed"); this.channelLost("network changed"); }
  channelLost(reason = "channel lost"): void { this.channelEpoch++; this.event("channel_lost", reason); if (this.state === "running") this.transition("starting", "reconnect supervision"); }
  channelRestored(): void { this.event("channel_restored"); if (this.state === "starting" || this.state === "error") this.transition("running", "channel restored"); }
  guestCrashed(detail = "guest gateway crashed"): void { this.channelEpoch++; this.event("guest_crashed", detail); this.transition("error", detail); }
  updateDemand(work: number, viewers: number): void {
    if (work < 0 || viewers < 0) throw new RangeError("demand cannot be negative");
    this.demand.work = work; this.demand.viewers = viewers; this.lastDemandAt = this.now(); this.event("demand_changed", `${work} work, ${viewers} viewers`);
    if (work + viewers > 0 && this.demand.desktop === "stopped") this.demand.desktop = "running";
  }
  tick(): void { if (this.demand.work + this.demand.viewers === 0 && this.demand.desktop === "running" && this.now() - this.lastDemandAt >= this.demand.graceMs) { this.demand.desktop = "stopped"; this.event("transition", "desktop reaped after grace"); } }
  recordRetry(operation: string): void { this.event("retry", operation); }
  resolveMutation(mutationId: string, outcome: "applied" | "not_applied" | "unknown"): void { this.event("mutation_resolved", `${mutationId}:${outcome}`); }
  async executeRead<T>(read: () => Promise<T>, retries = 1): Promise<T> { let last: unknown; for (let attempt = 0; attempt <= retries; attempt++) { try { return await read(); } catch (error) { last = error; if (attempt < retries) this.recordRetry(`read attempt ${attempt + 1}`); } } throw last; }
}

export function recoveryProbe(now = (() => Date.now())): { timeline: RecoveryEvent[]; finalState: LifecycleState; desktop: DemandState } {
  const s = new RecoverySupervisor({ now, graceMs: 1000 }); s.transition("starting"); s.transition("running"); s.updateDemand(1, 0); s.onSleep(); s.onWake(); s.onNetworkChanged(); s.channelRestored(); s.guestCrashed(); s.transition("starting"); s.channelRestored(); s.updateDemand(0, 0); s.tick(); return { timeline: s.timeline, finalState: s.state, desktop: s.demand };
}
