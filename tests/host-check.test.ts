import assert from "node:assert/strict";
import { test } from "node:test";
import { checkHost } from "../apps/cli/src/host-check.js";

const host = (lock: string, lockedNow: boolean, autoLogin: string) => checkHost({
  runBoth: () => `2026-10-15 sysadminctl[1:1] ${lock}\n`,
  run: (command) => command.endsWith("ioreg") ? (lockedNow ? '"CGSSessionScreenIsLocked"=Yes' : "") : autoLogin,
});

test("a Mac that logs in automatically and never locks its screen hibernates", () => {
  const check = host("screenLock is off", false, "server\n");
  assert.equal(check.hibernate, "available"); assert.deepEqual(check.fixes, []); assert.equal(check.auto_login_user, "server");
});

test("a Mac whose screen locks only hibernates while unlocked, and says which settings to change", () => {
  const check = host("screenLock delay is 300 seconds", true, "The domain/default pair of (/Library/Preferences/com.apple.loginwindow, autoLoginUser) does not exist");
  assert.equal(check.hibernate, "only_while_unlocked"); assert.equal(check.screen_lock, "on"); assert.equal(check.auto_login_user, null);
  assert.equal(check.fixes.length, 2); assert.match(check.fixes[0], /Lock Screen/); assert.match(check.fixes[1], /automatic login/);
  assert.match(check.explanation, /pause in memory/);
});

test("with no password on the lock, a sleeping display (the locked flag) does not stop hibernation", () => {
  const check = host("screenLock is off", true, "server");
  assert.equal(check.hibernate, "available"); assert.deepEqual(check.fixes, []); assert.equal(check.screen_locked_now, true);
});
