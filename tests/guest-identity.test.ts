import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { adoptSandboxIdentity, type IdentitySystem } from "../apps/guest-agent/src/identity.js";

/** A guest root cloned from the template: its machine-id and SSH host keys, and the commands run against it. */
async function clonedRoot(withSsh: boolean): Promise<IdentitySystem & { ran: string[] }> {
  const root = await mkdtemp(join(tmpdir(), "localbox-identity-"));
  await mkdir(join(root, "etc/ssh"), { recursive: true });
  await mkdir(join(root, "var/lib/dbus"), { recursive: true });
  await writeFile(join(root, "etc/machine-id"), "template\n");
  await writeFile(join(root, "var/lib/dbus/machine-id"), "template\n");
  if (withSsh) await writeFile(join(root, "etc/ssh/ssh_host_ed25519_key"), "template key");
  const ran: string[] = [];
  return {
    root, ran,
    run: (command, args) => {
      ran.push([command, ...args].join(" "));
      if (command === "systemd-machine-id-setup") assert.ok(!existsSync(join(root, "var/lib/dbus/machine-id")), "setup must not copy the template's D-Bus id");
    },
  };
}

test("a clone takes its own machine-id and SSH host keys the first time it serves a sandbox, then only follows the name", async () => {
  const system = await clonedRoot(true);
  assert.equal(adoptSandboxIdentity("sandbox_1", "quiet-otter", system), true);
  assert.deepEqual(system.ran, ["systemd-machine-id-setup", "ssh-keygen -A", "hostname quiet-otter"]);
  assert.deepEqual(await readdir(join(system.root, "etc/ssh")), [], "the template's host keys are gone before ssh-keygen -A");
  assert.equal((await readFile(join(system.root, "var/lib/localbox/sandbox-id"), "utf8")).trim(), "sandbox_1");
  system.ran.length = 0;
  assert.equal(adoptSandboxIdentity("sandbox_1", "calm-heron", system), false, "a reconnect or rename keeps the identity");
  assert.deepEqual(system.ran, ["hostname calm-heron"]);
});

test("an image without sshd skips host keys", async () => {
  const system = await clonedRoot(false);
  adoptSandboxIdentity("sandbox_2", "brave-fox", system);
  assert.deepEqual(system.ran, ["systemd-machine-id-setup", "hostname brave-fox"]);
});
