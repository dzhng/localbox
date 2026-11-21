import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { adoptSandboxIdentity, setGuestClock, type GuestPlatform, type IdentitySystem } from "../apps/guest-agent/src/identity.js";

/** A guest root cloned from an image: its machine-id and SSH host keys, and the commands run against it. */
async function clonedRoot(withSsh: boolean, platform: GuestPlatform = "linux"): Promise<IdentitySystem & { ran: string[] }> {
  const root = await mkdtemp(join(tmpdir(), "localbox-identity-"));
  await mkdir(join(root, "etc/ssh"), { recursive: true });
  await mkdir(join(root, "var/lib/dbus"), { recursive: true });
  await writeFile(join(root, "etc/machine-id"), "image\n");
  await writeFile(join(root, "var/lib/dbus/machine-id"), "image\n");
  if (withSsh) await writeFile(join(root, "etc/ssh/ssh_host_ed25519_key"), "image key");
  const ran: string[] = [];
  return {
    platform, root, ran,
    run: (command, args) => {
      ran.push([command, ...args].join(" "));
      if (command === "systemd-machine-id-setup") assert.ok(!existsSync(join(root, "var/lib/dbus/machine-id")), "setup must not copy the image's D-Bus id");
    },
  };
}

test("a clone takes its own machine-id and SSH host keys the first time it serves a sandbox, then only follows the name", async () => {
  const system = await clonedRoot(true);
  assert.equal(adoptSandboxIdentity("sandbox_1", "quiet-otter", system), true);
  assert.deepEqual(system.ran, ["systemd-machine-id-setup", "ssh-keygen -A", "hostname quiet-otter"]);
  assert.deepEqual(await readdir(join(system.root, "etc/ssh")), [], "the image's host keys are gone before ssh-keygen -A");
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

test("a Linux clock steps to the host's wall clock with millisecond precision", async () => {
  const system = await clonedRoot(false);
  setGuestClock(Date.UTC(2026, 10, 21, 9, 5, 7, 250), system);
  assert.deepEqual(system.ran, ["date -u -s @1795251907.250"]);
});

test("a macOS clone takes its own SSH host keys and names itself through scutil; it has no machine-id", async () => {
  const system = await clonedRoot(true, "darwin");
  assert.equal(adoptSandboxIdentity("sandbox_3", "quiet-otter", system), true);
  assert.deepEqual(system.ran, ["ssh-keygen -A", "scutil --set HostName quiet-otter", "scutil --set LocalHostName quiet-otter", "scutil --set ComputerName quiet-otter"]);
  assert.equal(await readFile(join(system.root, "etc/machine-id"), "utf8"), "image\n", "macOS has no machine-id to replace");
  assert.equal((await readFile(join(system.root, "var/db/localbox/sandbox-id"), "utf8")).trim(), "sandbox_3");
  system.ran.length = 0;
  assert.equal(adoptSandboxIdentity("sandbox_3", "calm-heron", system), false);
  assert.deepEqual(system.ran, ["scutil --set HostName calm-heron", "scutil --set LocalHostName calm-heron", "scutil --set ComputerName calm-heron"]);
});

test("a macOS clone without sshd keys only takes the name", async () => {
  const system = await clonedRoot(false, "darwin");
  adoptSandboxIdentity("sandbox_4", "brave-fox", system);
  assert.deepEqual(system.ran, ["scutil --set HostName brave-fox", "scutil --set LocalHostName brave-fox", "scutil --set ComputerName brave-fox"]);
});

test("a macOS clock steps with BSD date's UTC format, to the second", async () => {
  const system = await clonedRoot(false, "darwin");
  setGuestClock(Date.UTC(2026, 10, 21, 9, 5, 7, 900), system);
  assert.deepEqual(system.ran, ["date -u 112109052026.07"]);
});
