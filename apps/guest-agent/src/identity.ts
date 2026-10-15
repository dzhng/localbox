import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface IdentitySystem {
  /** The guest's filesystem root ("/" in a VM). */
  root: string;
  run(command: string, args: string[]): void;
}

const realSystem: IdentitySystem = { root: "/", run: (command, args) => { spawnSync(command, args, { stdio: "ignore" }); } };

/**
 * Every sandbox's disk is a clone of one template, so it boots with the template's machine-id and SSH host keys.
 * The host's hello names the sandbox: the first time this disk serves a given sandbox id it makes those its own,
 * then the hostname follows the sandbox's name on every hello. Returns whether the identity was regenerated.
 */
export function adoptSandboxIdentity(sandboxId: string, hostname: string, system: IdentitySystem = realSystem): boolean {
  const marker = join(system.root, "var/lib/localbox/sandbox-id");
  let current = "";
  try { current = readFileSync(marker, "utf8").trim(); } catch {}
  const fresh = current !== sandboxId;
  if (fresh) {
    // systemd-machine-id-setup would copy D-Bus's id, which the template also carries.
    for (const path of ["etc/machine-id", "var/lib/dbus/machine-id"]) rmSync(join(system.root, path), { force: true });
    system.run("systemd-machine-id-setup", []);
    // Images without sshd have no host keys to replace.
    const ssh = join(system.root, "etc/ssh");
    let keys: string[] = [];
    try { keys = readdirSync(ssh).filter((name) => name.startsWith("ssh_host_")); } catch {}
    if (keys.length) {
      for (const key of keys) rmSync(join(ssh, key), { force: true });
      system.run("ssh-keygen", ["-A"]);
    }
    mkdirSync(join(system.root, "var/lib/localbox"), { recursive: true });
    writeFileSync(marker, `${sandboxId}\n`);
  }
  system.run("hostname", [hostname]);
  return fresh;
}
