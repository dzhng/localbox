# 09 Sandbox catalog and CLI

**Unlocks:** sandboxes become an account catalog with generated names, driven by
`localbox sandbox …` (map S1–S3, Q3; plan decisions D8, D10). Removes seam T6.

## Seam

- Contract cutover: `RequestEnvelope.vm_id` → `sandbox_id` (null for account and
  machine operations); `requestFromInvocation`'s `"vm_01"` default goes. `vm.*`
  becomes `sandbox.create|list|status|rename|resize|delete|start|stop|sleep|logs`;
  `vm.pause` becomes `sandbox.sleep`; `vm.reset` is removed. The `executor` field
  and the account/machine operations already exist from slice 06. Errors gain `sandbox_ambiguous`,
  `sandbox_not_found` (was `vm_not_found`), `name_conflict`, `machine_offline`,
  `machine_full`, `quota_exceeded`. Snapshots regenerated; no aliases.
  `contract generate-snapshots` also writes the Swift host-operation constants so
  the daemon routes on generated IDs.
- Result facts (P1) as one `packages/contract` type: `{requested, produced,
  actions: [{kind: slept|woke|made_room|restarted|cold_booted|truncated, …}]}`.
- Convex `sandboxes` owns identity: `{sandboxId, accountId, machineId, name
  (unique per account), cpus, memoryBytes, sleepAfterMs, deleteAfterMs?,
  reportedState, reportedAt}`. Create reserves a generated name (`--name`
  overrides; a conflict lists existing names) and enqueues `sandbox.create` to
  the chosen machine, including "this machine" (D8). The daemon mirrors identity
  read-only; runtime state flows back through `host.watch` and the connector,
  written only on change.
- Name resolution: `--sandbox <name>` resolves against the local daemon first,
  then the account; omitted only when the account has exactly one sandbox,
  otherwise `sandbox_ambiguous` listing them (Q3).
- `apps/cli`: commands for `sandbox`, `machines`, `account`, `login`, `shell`,
  `fs`, `job`, `browser`, `desktop`; one `render(result, {json})` so text and
  `--json` carry the same facts (S3); create reports the chosen size and why (S2).
  Help is generated from the catalog; the hand-written usage list goes.
- Delete `localbox vm *`, `vm probe`, `apps/macos/VMProbe` (superseded by vmlab),
  `packages/registry` and its tests, `HostStatus.{swift,ts}`.

## See it

`npm run proof -- 09 --tier u,l` (L-L): two creates on A get distinct
`adjective-animal` names; `--name taken` fails listing names; `shell exec`
without `--sandbox` fails listing both; rename shows on B; delete reports exactly
what was removed; text and `--json` carry identical facts for every command.

## Gates

`tests/contract.test.ts` (regenerated), new `tests/contract-executor.test.ts`,
`tests/sandbox-catalog.test.ts` (convex-test), `tests/cli-output.test.ts`.

## Delegated

Text layout and column order; `ActionReport` field names within the shape above.

## Feedback that would change it

Naming and output wording.
