import { execFileSync } from "node:child_process";

/** What this Mac's settings mean for sleeping sandboxes; `localbox host check`, `status` and the installer show it. */
export interface HostCheck {
  hibernate: "available" | "only_while_unlocked" | "unknown";
  screen_lock: "off" | "on" | "unknown";
  screen_locked_now: boolean;
  auto_login_user: string | null;
  explanation: string;
  fixes: string[];
}

type Run = (command: string, args: string[]) => string;
const run: Run = (command, args) => { try { return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); } catch (error) { return String((error as { stderr?: string; stdout?: string }).stderr ?? (error as { stdout?: string }).stdout ?? ""); } };
/** sysadminctl prints its answer on stderr, so capture both streams. */
const runBoth: Run = (command, args) => { try { return execFileSync("/bin/sh", ["-c", `${command} ${args.join(" ")} 2>&1`], { encoding: "utf8" }); } catch (error) { return String((error as { stdout?: string }).stdout ?? ""); } };

/**
 * Apple's VM framework encrypts a sandbox's saved memory with a key it creates in the logged-in user's session,
 * which refuses while the session is locked with a password. So hibernation (sleep that frees RAM) needs a screen
 * lock that asks for no password; where it does, a locked screen pauses idle sandboxes in memory instead (their
 * processes keep running, their RAM is not freed). A headless Mac should log in automatically and never require a
 * password on its lock.
 */
export function checkHost(exec: { run: Run; runBoth: Run } = { run, runBoth }): HostCheck {
  const lock = exec.runBoth("/usr/sbin/sysadminctl", ["-screenLock", "status"]);
  const screenLock = /screenLock is off/.test(lock) ? "off" : /screenLock (delay is|is immediate|is on)/.test(lock) ? "on" : "unknown";
  const lockedNow = /"CGSSessionScreenIsLocked"=Yes/.test(exec.run("/usr/sbin/ioreg", ["-n", "Root", "-d1"]));
  const autoLogin = exec.run("/usr/bin/defaults", ["read", "/Library/Preferences/com.apple.loginwindow", "autoLoginUser"]).trim();
  const autoLoginUser = autoLogin && !/does not exist/.test(autoLogin) ? autoLogin.split("\n")[0] : null;
  const fixes: string[] = [];
  if (screenLock !== "off") fixes.push('System Settings > Lock Screen: set "Require password after screen saver begins or display is turned off" to Never');
  if (!autoLoginUser) fixes.push("System Settings > Users & Groups: turn on automatic login, so the Mac comes back to an unlocked session after a restart or power loss");
  // With no password on the lock, a screen saver or a sleeping display sets the "locked" flag without locking the
  // session, and saves still work (measured); only the password requirement decides.
  const hibernate = screenLock === "off" ? "available" : screenLock === "unknown" ? "unknown" : "only_while_unlocked";
  const explanation = hibernate === "available"
    ? "Idle sandboxes hibernate: their memory is saved to disk and the RAM is freed; processes resume on the next request."
    : "This Mac's lock screen asks for a password, so idle sandboxes hibernate only while it is unlocked. While it is locked they pause in memory instead: processes keep their state but the RAM is not freed.";
  return { hibernate, screen_lock: screenLock, screen_locked_now: lockedNow, auto_login_user: autoLoginUser, explanation, fixes };
}
