export type HostStatus = "first-run" | "starting" | "ready" | "disconnected" | "paused" | "resetting";
export interface HostStatusSnapshot { status: HostStatus; vmId: string; relayConnected: boolean; detail?: string; updatedAt: string; }
export class HostStatusModel {
  private snapshot: HostStatusSnapshot;
  constructor(vmId = "vm_01") { this.snapshot = { status: "first-run", vmId, relayConnected: false, updatedAt: new Date().toISOString() }; }
  get value(): HostStatusSnapshot { return { ...this.snapshot }; }
  set(status: HostStatus, relayConnected = this.snapshot.relayConnected, detail?: string): HostStatusSnapshot { this.snapshot = { ...this.snapshot, status, relayConnected, detail, updatedAt: new Date().toISOString() }; return this.value; }
}
