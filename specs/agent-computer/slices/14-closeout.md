# Slice 14 — Acceptance and closeout

## Contract unlocked

The complete local-agent-computer journey is measured, reviewed, and ready to
ship.

## Acceptance journey

On a clean Apple-silicon Mac:

1. Install the skill, app, and CLI from release assets.
2. Boot the default VM and verify health, persistence, and observed egress.
3. Run shell and filesystem operations through the CLI.
4. Use browser and desktop conveniences, including a screenshot and exact tab.
5. Complete OAuth and invoke the same operations through remote CLI.
6. Optionally connect MCP and compare its catalog/results with the CLI.
7. Sleep/wake or change networks, recover, and resolve an uncertain operation.
8. Reprovision, verify persistence, then perform an explicit destructive reset.

## Verification

- Run all focused contract, guest, image, relay, OAuth, MCP, recovery, and
  packaging suites plus one full repository run.
- Run adversarial checks for path traversal, malformed frames, stale VM IDs,
  expired/replayed OAuth, mutation replay, and secret logging.
- Run `refactor-clean`, `code-review`, and docs review over the final shape.
- Run screenshot-critique and compare-screenshots gates required by visual slices.
- Store immutable probe/release reports under the feature spec; never retain
  bearer tokens, capability URLs, cookies, or host credentials.

## Done condition

The README, SECURITY.md, consumer skill, CLI help, MCP tool list, and shipped
behavior all describe one operation catalog and one VM trust boundary. Only
then should `close-spec` archive this plan to `specs/done/`.
