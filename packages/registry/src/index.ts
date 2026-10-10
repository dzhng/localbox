import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { dirname } from "node:path";

export type RegistryLifecycle = "stopped" | "starting" | "running" | "paused" | "stopping" | "error";
export interface VMRecord { vmId: string; name: string; imageDigest: string; diskPath: string; lifecycle: RegistryLifecycle; createdAt: string; updatedAt: string; }
export interface RegistryDocument { version: 1; selectedVmId: string; vms: VMRecord[]; }

export class DurableVMRegistry {
  private doc: RegistryDocument = { version: 1, selectedVmId: "", vms: [] };
  constructor(public readonly path: string) {}
  async load(): Promise<this> {
    try { this.doc = JSON.parse(await readFile(this.path, "utf8")) as RegistryDocument; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return this;
  }
  private async save(): Promise<void> { await mkdir(dirname(this.path), { recursive: true }); await writeFile(this.path, `${JSON.stringify(this.doc, null, 2)}\n`, { mode: 0o600 }); }
  list(): VMRecord[] { return this.doc.vms.map((v) => ({ ...v })); }
  selected(): VMRecord | undefined { return this.doc.vms.find((v) => v.vmId === this.doc.selectedVmId); }
  async create(input: { vmId?: string; name?: string; imageDigest: string; diskPath: string }): Promise<VMRecord> { const now = new Date().toISOString(); const vm: VMRecord = { vmId: input.vmId ?? `vm_${Math.random().toString(36).slice(2, 10)}`, name: input.name ?? "Default VM", imageDigest: input.imageDigest, diskPath: input.diskPath, lifecycle: "stopped", createdAt: now, updatedAt: now }; if (this.doc.vms.some((v) => v.vmId === vm.vmId)) throw new Error(`VM already exists: ${vm.vmId}`); await mkdir(vm.diskPath, { recursive: true }); this.doc.vms.push(vm); if (!this.doc.selectedVmId) this.doc.selectedVmId = vm.vmId; await this.save(); return { ...vm }; }
  async select(vmId: string): Promise<VMRecord> { const vm = this.require(vmId); this.doc.selectedVmId = vmId; await this.save(); return { ...vm }; }
  async updateLifecycle(vmId: string, lifecycle: RegistryLifecycle): Promise<VMRecord> { const vm = this.require(vmId); vm.lifecycle = lifecycle; vm.updatedAt = new Date().toISOString(); await this.save(); return { ...vm }; }
  async reprovision(vmId: string): Promise<VMRecord> { const vm = this.require(vmId); vm.updatedAt = new Date().toISOString(); await this.save(); return { ...vm }; }
  async reset(vmId: string, options: { discardState: boolean; confirm: string }): Promise<{ vm: VMRecord; discarded: boolean }> { if (!options.discardState || options.confirm !== "RESET") throw new Error("reset requires discardState and confirmation RESET"); const vm = this.require(vmId); await rm(vm.diskPath, { recursive: true, force: true }); await mkdir(vm.diskPath, { recursive: true }); vm.lifecycle = "stopped"; vm.updatedAt = new Date().toISOString(); await this.save(); return { vm: { ...vm }, discarded: true }; }
  private require(vmId: string): VMRecord { const vm = this.doc.vms.find((v) => v.vmId === vmId); if (!vm) throw new Error(`VM not found: ${vmId}`); return vm; }
}
