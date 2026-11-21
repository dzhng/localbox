import { spawnSync } from "node:child_process";

/** What the darwin desktop role needs: capture the screen, read the UI, post input. */
export const TCC_SERVICES = ["kTCCServiceScreenCapture", "kTCCServiceAccessibility", "kTCCServicePostEvent"] as const;
export const SYSTEM_TCC_DATABASE = "/Library/Application Support/com.apple.TCC/TCC.db";

export interface CommandOutcome { status: number | null; stdout: string; stderr: string }
export type TccRunner = (command: string, args: string[]) => CommandOutcome;

const realRunner: TccRunner = (command, args) => {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return { status: result.error ? null : result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? result.error?.message ?? "" };
};

/**
 * Grants `binary` (by path) the three desktop services in the system TCC database and the desktop user's live one, as
 * root with SIP off. macOS 27 keeps the user database in a per-user container; the files the user's
 * `tccd` holds open name it. A replaced binary loses its screen-capture grant, so this runs after every
 * agent swap and once when an image is built (`localbox-agent --grant-tcc`). Returns the databases written.
 */
export function grantDarwinTcc(binary: string, user: string, run: TccRunner = realRunner): string[] {
  const uid = check(run("/usr/bin/id", ["-u", user]), `id -u ${user}`).stdout.trim();
  if (!/^\d+$/.test(uid)) throw new Error(`no uid for the desktop user ${user}`);
  const open = run("/usr/sbin/lsof", ["-a", "-u", uid, "-c", "tccd", "-Fn"]).stdout;
  const userDatabase = open.match(/^n(\/private\/var\/containers\/Data\/ProtectedSystem\/.*\/com\.apple\.TCC\/TCC\.db)$/m)?.[1];
  if (!userDatabase) throw new Error(`no live TCC database for ${user} (uid ${uid}): is the desktop session up?`);
  const client = binary.replaceAll("'", "''");
  const rows = TCC_SERVICES.map((service) => `('${service}', 1, '${client}', 2, 0, 1, NULL, 'UNUSED')`).join(", ");
  const insert = `INSERT OR REPLACE INTO access (service, client_type, client, auth_value, auth_reason, auth_version, indirect_object_identifier_type, indirect_object_identifier) VALUES ${rows};`;
  const written: string[] = [];
  for (const database of [SYSTEM_TCC_DATABASE, userDatabase]) {
    check(run("/usr/bin/sqlite3", [database, insert]), `writing ${database}`);
    written.push(database);
  }
  return written;
}

function check(outcome: CommandOutcome, what: string): CommandOutcome {
  if (outcome.status !== 0) throw new Error(`${what} failed (${outcome.status ?? "not run"}): ${outcome.stderr.trim()}`);
  return outcome;
}
