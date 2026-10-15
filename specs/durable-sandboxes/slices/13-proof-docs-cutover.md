# 13 Proof, agent docs and cutover

**Unlocks:** the whole scenario passes on this Mac; agent-facing docs describe
exactly the shipped CLI; production is cut over (map Q14); a two-Mac runbook
exists for the user.

## Seam

- `scripts/proof/probes/13-scenario.ts` (V-L topology): log in A and B (machine
  count 2); create locally on A; `--machine b`; `--placement auto`; remote `shell
  exec` on B from A; an MCP call; kill B's connector → `machine_offline`;
  `machines remove b` → B's connector exits; idle sleep with a short policy;
  hibernate/wake with a Node server surviving on the real A. Writes
  `evidence/13-scenario.json` including Convex calls per request.
- Agent docs: `skills/localbox/SKILL.md` and its references (the only usage
  reference) and the README's Agent setup describe only shipped commands.
  `llms.txt` stays a pitch plus install steps (see `apps/site/README.md`). `tests/skill-commands.test.ts` runs every command they name with
  `--help` and fails on unknown commands.
- Requirements: installer refuses macOS below 14 (`scripts/install-release.sh`);
  `com.localbox.connector.plist` installed and loaded; README, site and positioning
  "Today" lines updated to what shipped.
- `DEVELOPMENT.md` settings: add `LOCALBOX_JWT_PRIVATE_KEY`, `LOCALBOX_JWKS`,
  `RESEND_API_KEY`, `LOCALBOX_DEV_PRINT_CODES`, `LOCALBOX_MACHINE_ROOT`, the limit
  knobs; remove `LOCALBOX_OWNER_SUBJECT` and `BLOB_*`. Recipe for the simulated
  second machine.
- `SECURITY.md`: accounts and email codes, the machine credential, Convex as an
  authenticated boundary, relay trust.
- `specs/durable-sandboxes/two-mac-runbook.md` for the user's real test.
- Production cutover (Q14): `scripts/convex-wipe.ts --deployment prod`, deploy the
  schema, then functions; set Vercel env; delete `LOCALBOX_OWNER_SUBJECT` and
  `BLOB_*`. Gate: `npx convex data` shows only the new tables, empty, and a
  production `login` round trip works (real email once Resend is set up;
  otherwise blocked with exit 2).

## See it

`npm run proof -- all --tier u,l` and `npm run proof -- 13 --tier v`.

## Gates

Everything; `apps/site` tests; `tests/skill-commands.test.ts`.

## Afterwards

When every slice has shipped, run close-spec to archive this folder to
`specs/done/` as a rationale record.
