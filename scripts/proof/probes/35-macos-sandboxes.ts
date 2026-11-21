import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Check, ProofContext } from "../run.js";
import { cachedIpsw, vmlab } from "../lib/macos-lab.js";
import { realDaemon, screenLocked } from "../lib/real-daemon.js";
import { buildGuestAgent } from "../../build-guest-agent.js";

export const id = "35";
export const tiers = ["s", "m"];

const GIB = 1024 ** 3;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * macOS sandboxes end to end. Tier s: admission's two-running-macOS-sandboxes limit (`AdmissionMacCapTests`, which
 * live in `HostDaemonCoreTests`) and resize's report on darwin. Tier m: a real daemon on this Mac builds (or reuses) a
 * macOS image, makes a sandbox from it and runs every operation a user would: desktop screenshots (one with a menu
 * open), the browser, the shell, sleep and wake with a process surviving, saving it as an image, a second sandbox from
 * that image with its own machine identifier, and a third macOS sandbox that admission handles.
 *
 * `LOCALBOX_MACOS_IMAGE=<images>/<id>` reuses a built image (APFS-cloned in, never changed) instead of building one.
 */
export async function run(ctx: ProofContext): Promise<Check[]> {
  if (ctx.tier === "s") {
    return [await ctx.check("AdmissionMacCapTests (in HostDaemonCoreTests): a third macOS sandbox sleeps the LRU idle one or is refused with macOS's limit; resize on darwin reports only user processes", async () => {
      const result = await ctx.exec("swift", ["test", "--package-path", "apps/macos/HostDaemon", "--filter", "HostDaemonCoreTests.testThirdMacOSSandboxSleepsOneOrIsRefused|HostDaemonCoreTests.testResizeOnDarwinReportsOnlyUserProcesses"]);
      assert.equal(result.code, 0, (result.stdout + result.stderr).slice(-2500));
      assert.match(result.stdout + result.stderr, /testThirdMacOSSandboxSleepsOneOrIsRefused.*passed/);
    })];
  }
  return await realSandboxes(ctx);
}

interface Shot { file: string; width: number; height: number; luminance_stddev: number; distinct_colours: number; text: string; picker_prompt: boolean }

async function realSandboxes(ctx: ProofContext): Promise<Check[]> {
  const version = execFileSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).trim();
  if (Number(version.split(".")[0]) < 27) throw new Error(`blocked: macOS sandboxes need a macOS 27 host; this Mac runs ${version}`);
  if (screenLocked()) throw new Error("blocked: the screen is locked, and sleeping a sandbox needs it unlocked (Apple's VM service keeps the saved-state key in the keychain)");
  const reuse = process.env.LOCALBOX_MACOS_IMAGE;
  const ipsw = cachedIpsw();
  if (!reuse && !ipsw) throw new Error("blocked: no cached IPSW and no LOCALBOX_MACOS_IMAGE; run npm run proof -- 16 --tier m");
  const directory = join(ctx.root, "specs/sandbox-images/evidence"); mkdirSync(directory, { recursive: true });
  const agents = join(ctx.root, "dist/guest-agent");
  const daemon = realDaemon(ctx, { probe: "35", env: { LOCALBOX_GUEST_AGENT: agents } });
  const { ok, call, sh, record } = daemon;
  const evidence: Record<string, unknown> = { host_macos: version };
  const checks: Check[] = [];
  let bin = "";
  const inspect = async (file: string): Promise<Shot> => {
    const result = await ctx.exec(join(bin, "localbox-vmlab"), ["shot-inspect", "--file", file, "--json"]);
    const shot = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}");
    assert.equal(shot.ok, true, result.stdout + result.stderr);
    return { file: file.slice(ctx.root.length + 1), ...shot };
  };
  /** One `desktop.screenshot`, written to `file` (a JPEG, or a PNG when the agent answers one) and inspected. */
  const screenshot = async (sandboxId: string, file: string): Promise<Shot> => {
    const result = await ok("desktop.screenshot", sandboxId);
    const data = String(result.data); const comma = data.indexOf(",");
    assert.ok(data.startsWith("data:image/") && comma > 0, `desktop.screenshot answered ${data.slice(0, 80)}`);
    writeFileSync(file, Buffer.from(data.slice(comma + 1), "base64"));
    const shot = await inspect(file);
    assert.deepEqual([shot.width, shot.height], [result.width, result.height], "the frame is the display size the agent reports");
    return shot;
  };
  /** A real desktop frame: varied pixels, readable text, and not macOS's window-picker prompt. */
  const realFrame = (shot: Shot) => {
    assert.ok(shot.luminance_stddev > 10 && shot.distinct_colours > 200, `a blank or flat frame: ${JSON.stringify(shot)}`);
    assert.ok(shot.text.length > 20, `no readable text in the frame: ${JSON.stringify(shot)}`);
    assert.equal(shot.picker_prompt, false, `the window-picker prompt is on screen: ${shot.text}`);
  };
  const kinds = (result: any) => (result.actions ?? []).map((action: any) => action.kind);
  const create = async (sandboxId: string, name: string, image: string) => {
    const started = Date.now();
    const response = await call("sandbox.create", sandboxId, { name, image, cpus: 4, memory_bytes: 4 * GIB, sleep_after_ms: 3_600_000 });
    return { response: response as any, seconds: Math.round((Date.now() - started) / 1000) };
  };
  const desktopUp = async (sandboxId: string) => {
    let last: any;
    for (let attempt = 0; attempt < 60; attempt++) { last = await call("desktop.status", sandboxId, {}, false); if (last.ok) return last.result; await sleep(1_000); }
    throw new Error(`the desktop role never answered: ${JSON.stringify(last).slice(0, 800)}`);
  };
  const platformUUID = async (sandboxId: string) => (await sh(sandboxId, "ioreg -rd1 -c IOPlatformExpertDevice | awk -F'\"' '/IOPlatformUUID/ {print $4}'"));

  let image = ""; const captured = `image_p35c${Date.now().toString(36)}`;
  const a = "sandbox_p35_a", b = "sandbox_p35_b", c = "sandbox_p35_c";
  const jobs: Record<string, string> = {};
  try {
    checks.push(await ctx.check(reuse ? "the daemon starts and takes the given macOS image (an APFS clone)" : "the daemon starts and builds a macOS image (image create --macos, the IPSW cache seeded by APFS clone)", async () => {
      await buildGuestAgent(agents);
      await vmlab(ctx, ["macos-latest", "--json"]).then(({ verdict }) => { evidence.ipsw = verdict; });
      bin = (await ctx.exec("swift", ["build", "--package-path", "apps/macos/HostDaemon", "--show-bin-path"])).stdout.trim();
      mkdirSync(join(daemon.machine, "images", "linux"), { recursive: true });
      if (reuse) {
        image = reuse.replace(/\/+$/, "").split("/").at(-1)!;
        execFileSync("cp", ["-c", "-R", reuse, join(daemon.machine, "images", image)]);
        await daemon.start(bin);
      } else {
        await daemon.start(bin);
        const cache = join(daemon.machine, "images", ".ipsw"); mkdirSync(cache, { recursive: true });
        execFileSync("cp", ["-c", ipsw!, join(cache, String((evidence.ipsw as any).file_name))]);
        image = `image_p35m${Date.now().toString(36)}`;
        const started = Date.now();
        let built = await ok("image.create", null, { macos: true, image });
        while (built.state === "running") {
          const waited = await call("image.wait", null, { image, timeout_ms: 110_000 }, false);
          assert.equal(waited.ok, true, JSON.stringify(waited).slice(0, 1500));
          built = (waited as any).result;
          if (Date.now() - started > 60 * 60_000) throw new Error(`the build is still in ${built.progress?.phase} after an hour`);
        }
        assert.equal(built.state, "succeeded", JSON.stringify(built).slice(0, 2000));
        evidence.build_seconds = Math.round((Date.now() - started) / 1000);
      }
      const manifest = JSON.parse(readFileSync(join(daemon.machine, "images", image, "image.json"), "utf8"));
      assert.equal(manifest.os, "macos");
      evidence.base = { reused: Boolean(reuse), min_macos: manifest.min_macos, size_bytes: manifest.size_bytes, agent_version: manifest.agent_version };
    }));

    let sourceIdentifier = "", sourceUUID = "", createdAt = 0;
    checks.push(await ctx.check("sandbox create from the macOS image boots; shell exec -- sw_vers says macOS 27", async () => {
      createdAt = Date.now();
      const { response, seconds } = await create(a, "mac-one", image);
      assert.equal(response.ok, true, JSON.stringify(response).slice(0, 1500));
      assert.equal(response.result.produced.state, "running");
      const versions = await sh(a, "sw_vers");
      assert.match(versions, /ProductName:\s+macOS/); assert.match(versions, /ProductVersion:\s+27\./);
      sourceIdentifier = record(a).machine_identifier; sourceUUID = await platformUUID(a);
      assert.ok(sourceIdentifier && sourceUUID, "a machine identifier on the record and a platform UUID in the guest");
      evidence.first_sandbox = { create_seconds: seconds, sw_vers: versions, actions: response.result.actions, hostname: await sh(a, "scutil --get LocalHostName"), sandbox_id_marker: await sh(a, "cat /var/db/localbox/sandbox-id") };
      assert.equal((evidence.first_sandbox as any).sandbox_id_marker, a, "the guest took its identity from the hello");
    }));

    checks.push(await ctx.check("desktop screenshot is a real frame (not blank) with no window-picker prompt, then and for 15 s after", async () => {
      evidence.desktop_status = await desktopUp(a);
      const first = await screenshot(a, join(directory, "35-desktop.jpg"));
      const later: Shot[] = [];
      for (let index = 1; index <= 3; index++) { await sleep(5_000); later.push(await screenshot(a, join(ctx.evidence, `35-desktop-${index}.jpg`))); }
      // The desktop role logs each prompt it answered: before the first capture (the settle) or later (the guard).
      const answered = await sh(a, "grep -h 'window-picker bypass prompt' /tmp/localbox-desktop.log 2>/dev/null | tail -5; true");
      // macOS records the prompt's approval for 30 days; the build answers it, so the image carries the record.
      const approval = await sh(a, "plutil -p '/Users/localbox/Library/Group Containers/group.com.apple.replayd/ScreenCaptureApprovals.plist' 2>&1 | grep -A6 localbox-agent; true");
      const alerted = approval.match(/kScreenCaptureApprovalLastAlerted" => (\S+) (\S+) \+0000/);
      evidence.desktop = { first, later: later.map(({ picker_prompt, luminance_stddev }) => ({ picker_prompt, luminance_stddev })), prompts_answered: answered.split("\n").filter(Boolean), capture_approval: approval };
      assert.ok(alerted && Date.parse(`${alerted[1]}T${alerted[2]}Z`) < createdAt, `the image carries no capture approval from its build: ${approval}`);
      realFrame(first); for (const shot of later) realFrame(shot);
      assert.match(first.text, /Finder/, "the menu bar of a logged-in desktop");
    }));

    checks.push(await ctx.check("with the Apple menu open, desktop screenshot still captures (one SCStream frame) and shows the menu", async () => {
      let shot: Shot | undefined; let clicks = 0;
      while (clicks < 2 && !shot?.text.includes("About This Mac")) {
        clicks += 1;
        await ok("desktop.click", a, { x: 18, y: 10 });
        await sleep(1_500);
        shot = await screenshot(a, join(directory, "35-menu-open.jpg"));
      }
      evidence.menu_open = { clicks, ...shot };
      realFrame(shot!);
      assert.match(shot!.text, /About This Mac/, `the Apple menu is not in the frame: ${shot!.text}`);
      await ok("desktop.key", a, { key: "Escape" });
    }));

    checks.push(await ctx.check("browser open https://example.com, then a desktop screenshot shows the page, and browser screenshot answers", async () => {
      const opened = await ok("browser.open", a, { url: "https://example.com" });
      await sleep(3_000);
      const shot = await screenshot(a, join(directory, "35-browser.jpg"));
      const page = await ok("browser.screenshot", a, { tab_id: opened.tab_id });
      evidence.browser = { opened, desktop: shot, browser_screenshot: { mime: String(page.data ?? "").slice(0, 22), bytes: String(page.data ?? "").length } };
      realFrame(shot);
      assert.match(shot.text, /Example Domain/, `the page is not on screen: ${shot.text}`);
      assert.ok(String(page.data ?? "").startsWith("data:image/"), JSON.stringify(page).slice(0, 300));
    }));

    checks.push(await ctx.check("sandbox sleep hibernates it; sandbox start restores it and a process started before is still running", async () => {
      // Not `nohup`: under the darwin agent (a LaunchDaemon, no console session) macOS's nohup exits at once.
      const pid = await sh(a, "(sleep 100000 </dev/null >/dev/null 2>&1 & echo $!)");
      assert.equal(await sh(a, `kill -0 ${pid} && echo alive`), "alive", "running before the sleep");
      assert.match(pid, /^\d+$/);
      const slept = await ok("sandbox.sleep", a);
      assert.equal(slept.produced.state, "sleeping", JSON.stringify(slept));
      assert.match(slept.actions[0].detail, /^hibernated /, JSON.stringify(slept));
      const woke = await ok("sandbox.start", a);
      assert.deepEqual(kinds(woke), ["woke"], JSON.stringify(woke));
      assert.match(woke.actions[0].detail, /^restored mac-one from its saved state$/);
      const alive = await sh(a, `kill -0 ${pid} && echo alive`);
      evidence.sleep_wake = { pid, slept: slept.actions, woke: woke.actions, alive };
      assert.equal(alive, "alive", `PID ${pid} survived`);
    }));

    checks.push(await ctx.check("image create --from the running macOS sandbox saves it (sync-only freeze), the stall reported, and it keeps running", async () => {
      await sh(a, "echo written-before-capture > /Users/Shared/p35-marker");
      const created = await call("image.create", null, { from: a, image: captured });
      assert.equal(created.ok, true, JSON.stringify(created).slice(0, 1500));
      const operation = (created as any).result;
      assert.equal(operation.state, "succeeded", JSON.stringify(operation).slice(0, 1500));
      assert.equal(typeof operation.result.stall_ms, "number", "the stall is reported");
      assert.equal(operation.result.disk, "cloned");
      const manifest = JSON.parse(readFileSync(join(daemon.machine, "images", captured, "image.json"), "utf8"));
      assert.deepEqual([manifest.os, typeof manifest.hardware_model, manifest.min_macos], ["macos", "string", (evidence.base as any).min_macos]);
      const status = await ok("sandbox.status", a);
      assert.equal(status.lifecycle, "ready", "running again after the thaw");
      evidence.capture = { stall_ms: operation.result.stall_ms, result: operation.result, size_bytes: manifest.size_bytes, freeze: "sync only on darwin (slice 27): the guest flushes, the host pauses the VM around the clone" };
    }));

    checks.push(await ctx.check("a second sandbox from the captured image boots with the file, a different machine identifier and its own identity", async () => {
      const { response, seconds } = await create(b, "mac-two", captured);
      assert.equal(response.ok, true, JSON.stringify(response).slice(0, 1500));
      const identifier = record(b).machine_identifier, uuid = await platformUUID(b);
      const marker = await sh(b, "cat /Users/Shared/p35-marker");
      const identity = await sh(b, "cat /var/db/localbox/sandbox-id; scutil --get LocalHostName");
      evidence.second_sandbox = { create_seconds: seconds, platform_uuid_differs: uuid !== sourceUUID, identifier_differs: identifier !== sourceIdentifier, identity };
      assert.equal(marker, "written-before-capture");
      assert.notEqual(identifier, sourceIdentifier, "a new VZMacMachineIdentifier on the record");
      assert.ok(uuid && uuid !== sourceUUID, `the guest's platform UUID is the source's: ${uuid}`);
      assert.equal(identity.split("\n")[0], b, "the identity marker regenerated");
    }));

    checks.push(await ctx.check("a third macOS sandbox, with two running and idle, sleeps the least recently used one; never more than two macOS VMs run", async () => {
      const { response, seconds } = await create(c, "mac-three", image);
      evidence.third = { create_seconds: seconds, response: response.ok ? response.result.actions : response.error };
      assert.equal(response.ok, true, `refused although both are idle: ${JSON.stringify(response).slice(0, 1500)}`);
      const room = response.result.actions.filter((action: any) => action.kind === "made_room");
      assert.deepEqual(room.map((action: any) => action.detail), ["slept mac-one (4 GiB) to make room"], "mac-one is the least recently used");
      assert.equal((await ok("sandbox.status", a)).lifecycle, "asleep");
      assert.equal(daemon.vmRSS().size, 2, "two macOS VM services run");
    }));

    checks.push(await ctx.check("with both running sandboxes busy, waking the third answers machine_full with macOS's limit as the reason, not a Virtualization error", async () => {
      for (const id of [b, c]) {
        const job = await ok("shell.exec", id, { command: "sleep 600", background: true, cwd: "/" });
        assert.ok(job.job_id, JSON.stringify(job)); jobs[id] = job.job_id;
      }
      const refused = await call("sandbox.start", a);
      evidence.refused = (refused as any).error ?? (refused as any).result;
      assert.equal(refused.ok, false, JSON.stringify(refused).slice(0, 1500));
      const error = (refused as any).error;
      assert.equal(error.code, "machine_full", JSON.stringify(error));
      assert.match(error.message, /already runs 2 macOS sandboxes, the most macOS allows/);
      assert.doesNotMatch(JSON.stringify(error), /Virtualization|VZError|virtualMachineLimit/i);
      assert.deepEqual(error.details.sandboxes.map((holder: any) => holder.name).sort(), ["mac-three", "mac-two"]);
      assert.equal((await ok("sandbox.status", a)).lifecycle, "asleep", "and mac-one stays asleep");
    }));

    checks.push(await ctx.check("once mac-two is idle again, waking mac-one sleeps mac-two and restores mac-one from the state it was slept with", async () => {
      await ok("job.cancel", b, { job_id: jobs[b] });
      const woke = await ok("sandbox.start", a);
      evidence.woke_after_room = woke.actions;
      assert.deepEqual(woke.actions.map((action: any) => action.detail), ["slept mac-two (4 GiB) to make room", "restored mac-one from its saved state"]);
      assert.equal(await sh(a, "cat /Users/Shared/p35-marker"), "written-before-capture");
      assert.equal(daemon.vmRSS().size, 2, "still two macOS VM services");
    }));

    checks.push(await ctx.check("everything the probe made is removed: sandboxes, the captured image, the base", async () => {
      for (const id of [c, b, a]) await ok("sandbox.delete", id);
      assert.equal((await call("image.delete", null, { image: captured })).ok, true);
      if (!reuse) assert.equal((await call("image.delete", null, { image })).ok, true);
      for (const name of [a, b, c]) assert.ok(!existsSync(join(daemon.sandboxes, name)), `${name} is gone`);
      assert.ok(!existsSync(join(daemon.machine, "images", captured)), "the captured image is gone");
    }));
  } finally {
    writeFileSync(join(directory, "35-macos-sandboxes.json"), `${JSON.stringify({ checks: checks.map(({ name, ok, detail }) => ({ name, ok, detail })), ...evidence }, null, 2)}\n`);
    await daemon.cleanup();
  }
  return checks;
}
