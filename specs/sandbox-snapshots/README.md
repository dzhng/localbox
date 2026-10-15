# Sandbox snapshots and rollback

> Placeholder. Not scheduled and not designed. Nothing here is a commitment, and
> the README and site do not market it.

## Intent

Let an agent checkpoint a sandbox before a risky step (a migration, a dependency
upgrade, an untrusted install script) and restore it if the step goes wrong.

## Questions a design must answer

- **What is captured.** Disk only, or disk plus memory (a suspended running
  state)? Disk-only is far simpler and probably enough to start.
- **Mechanism.** The template disk and sandbox clones are planned as APFS
  copy-on-write files; a snapshot could be another clone of a stopped sandbox's
  disk. Check whether a running VM must stop or pause for a consistent copy.
- **Operations.** Likely snapshot, list, restore and delete, as catalog
  operations available to CLI and MCP alike. Restore is destructive to current
  state and needs the same explicit confirmation as reset.
- **Lifetime and space.** Who deletes old snapshots, and how disk use is reported.
  Snapshots must not reintroduce the cleanup problem sandboxes are meant to solve.
- **Interaction with shared folders.** A snapshot can't roll back files on the
  host. The operation result must say so plainly.
- **Uncertain mutations.** A lost restore response must surface as uncertain, like
  every other mutation.

## Depends on

Create, delete and clone for sandboxes (positioning use case 1).
