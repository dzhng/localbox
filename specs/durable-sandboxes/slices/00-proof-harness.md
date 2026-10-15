# 00 Proof harness

**Unlocks:** every later slice is judged by one command with a JSON verdict.

## Seam

- `scripts/proof/run.ts`: `npm run proof -- <slice|all> [--tier u,s,l,v,x] [--through NN] [--keep] [--json]`.
  Each probe is `scripts/proof/probes/<NN>-<name>.ts` exporting
  `{ id, tiers, run(ctx): Promise<Check[]> }`. Output: one line
  `{slice, tier, ok, ms, checks:[{name, ok, ms, detail?}], evidence}`. A failed
  check always carries `detail` (actual vs expected). Exit 0 pass, 1 fail,
  2 blocked (detail names the missing input). Evidence goes to
  `.localbox/proof/runs/<ts>-<slice>/`.
- `scripts/proof/stack.ts up|down|status|logs [--machines a,b]`: starts local
  Convex (`npx convex dev --local --typecheck disable --codegen disable`),
  `npm run dev:local` with `LOCALBOX_DEV_PRINT_CODES=1` teed to
  `.localbox/proof/dev-local.log`, and per-machine processes from slice 03 on.
  Pidfiles; refuses to start when a port is held by a stranger (exit 2 with the
  pid); `down` leaves no orphans.
- `scripts/proof/lib/`: `as-machine.ts` (run the CLI as machine `m`),
  `codes.ts` (`waitForCode(email, {sinceByte})`, tails the dev log from an offset
  taken before the request), `convex-admin.ts` (`npx convex data|run` only; no
  product test endpoints), `sign-dev.sh` (ad-hoc codesign with the
  virtualization entitlement).
- `packages/config/src/machine-paths.ts`: `machinePaths(env)` →
  `{root, credentials, ipcToken, socket, sandboxes, logs}`. Defaults:
  `~/.config/localbox/credentials.json` and `~/Library/Application Support/Localbox/`.
  `LOCALBOX_MACHINE_ROOT` relocates everything. Replaces `LOCALBOX_SOCKET_PATH`,
  `LOCALBOX_IPC_TOKEN_FILE`, `LOCALBOX_AUTH_FILE`. The Swift daemon is handed
  explicit paths in its environment and derives none.
- `scripts/local-vercel.ts` overwrites `x-forwarded-for`, `x-real-ip` and
  `x-vercel-forwarded-for` with the socket address, as Vercel does.
  `LOCAL_VERCEL_TRUST_CLIENT_IP=1` (dev server only) lets probes send TEST-NET
  addresses to exercise per-IP limits.
- `.gitignore` gains `.localbox/`.

## See it

`npm run proof -- 00 --tier u,l`: tier u checks `machinePaths` defaults and
relocation and the verdict schema; tier l brings the stack up, gets a
fail-closed 401 from `/api/relay/status`, sees a spoofed `x-forwarded-for`
recorded as `127.0.0.1`, and tears down with no orphan pids.

## Gates

`tests/machine-paths.test.ts`, `tests/local-vercel-ip.test.ts`; the probe passes
twice in a row.

## Delegated

Log tailing implementation, pidfile format, terminal colours.

## Must stay green

Standing gates in the README.

## Feedback that would change it

Preferring a different test runner or evidence location.
