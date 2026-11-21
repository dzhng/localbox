import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The guest OSes whose agent owns the system it runs on (a VM's root, as root). */
export type GuestPlatform = "linux" | "darwin";

export interface IdentitySystem {
  platform: GuestPlatform;
  /** The guest's filesystem root ("/" in a VM). */
  root: string;
  run(command: string, args: string[]): void;
}

export function realSystem(platform: GuestPlatform): IdentitySystem {
  return { platform, root: "/", run: (command, args) => { spawnSync(command, args, { stdio: "ignore" }); } };
}

/** What differs per OS: where the marker lives, what a clone must make its own, how the name and clock are set. */
interface PlatformIdentity {
  marker: string;
  /** Replaces the template's machine identity (SSH host keys are common to both and handled apart). */
  regenerate(system: IdentitySystem): void;
  setHostname(system: IdentitySystem, hostname: string): void;
  setClock(system: IdentitySystem, wallClockMs: number): void;
}

const platforms: Record<GuestPlatform, PlatformIdentity> = {
  linux: {
    marker: "var/lib/localbox/sandbox-id",
    regenerate: (system) => {
      // systemd-machine-id-setup would copy D-Bus's id, which the template also carries.
      for (const path of ["etc/machine-id", "var/lib/dbus/machine-id"]) rmSync(join(system.root, path), { force: true });
      system.run("systemd-machine-id-setup", []);
    },
    setHostname: (system, hostname) => system.run("hostname", [hostname]),
    setClock: (system, wallClockMs) => system.run("date", ["-u", "-s", `@${(wallClockMs / 1000).toFixed(3)}`]),
  },
  darwin: {
    marker: "var/db/localbox/sandbox-id",
    // macOS has no machine-id; the hardware identity is the VM's (a new VZMacMachineIdentifier per clone).
    regenerate: () => undefined,
    setHostname: (system, hostname) => { for (const key of ["HostName", "LocalHostName", "ComputerName"]) system.run("scutil", ["--set", key, hostname]); },
    // BSD date takes [[[mm]dd]HH]MM[[cc]yy][.SS] and has no sub-second precision.
    setClock: (system, wallClockMs) => {
      const at = new Date(wallClockMs), two = (value: number) => String(value).padStart(2, "0");
      system.run("date", ["-u", `${two(at.getUTCMonth() + 1)}${two(at.getUTCDate())}${two(at.getUTCHours())}${two(at.getUTCMinutes())}${at.getUTCFullYear()}.${two(at.getUTCSeconds())}`]);
    },
  },
};

/**
 * Every sandbox's disk is a clone of one image, so it boots with the image's identity (machine-id on Linux, SSH host
 * keys on both). The host's hello names the sandbox: the first time this disk serves a given sandbox id it makes those
 * its own, then the hostname follows the sandbox's name on every hello. Returns whether the identity was regenerated.
 */
export function adoptSandboxIdentity(sandboxId: string, hostname: string, system: IdentitySystem): boolean {
  const platform = platforms[system.platform];
  const marker = join(system.root, platform.marker);
  let current = "";
  try { current = readFileSync(marker, "utf8").trim(); } catch {}
  const fresh = current !== sandboxId;
  if (fresh) {
    platform.regenerate(system);
    // Images without sshd have no host keys to replace.
    const ssh = join(system.root, "etc/ssh");
    let keys: string[] = [];
    try { keys = readdirSync(ssh).filter((name) => name.startsWith("ssh_host_")); } catch {}
    if (keys.length) {
      for (const key of keys) rmSync(join(ssh, key), { force: true });
      system.run("ssh-keygen", ["-A"]);
    }
    mkdirSync(join(marker, ".."), { recursive: true });
    writeFileSync(marker, `${sandboxId}\n`);
  }
  platform.setHostname(system, hostname);
  return fresh;
}

/** Steps the guest clock to the host's wall clock (after a restore the guest's is behind by the time it slept). */
export function setGuestClock(wallClockMs: number, system: IdentitySystem): void {
  platforms[system.platform].setClock(system, wallClockMs);
}
