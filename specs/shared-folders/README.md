# Shared folders with an access log

> Placeholder. Not designed or scheduled. The README and site already market this
> (positioning use case 5), so it is a launch commitment, but nothing here is a
> settled design.

## Intent

A sandbox sees nothing on the host by default. The user, or their agent, shares
one named host folder with one sandbox, read-only unless read-write is asked for,
and Localbox records every access the sandbox makes through that share.

## Scope for the first version

- Audit only what passes through a share. Everything else on the host stays
  invisible to the sandbox, so there's nothing else to audit.
- Log each operation with time, sandbox, path relative to the share root, the
  operation (open, read, write, create, rename, delete, list, stat) and its
  result. Content is not logged.
- The log is readable through a catalog operation, so CLI and MCP see the same
  thing.

## Questions a design must answer

- **Mechanism.** Apple's `VZSharedDirectory` (virtio-fs) is served inside
  Virtualization.framework and exposes no per-file events, so an audited share
  likely means the host daemon serves the folder itself (for example a file
  server over vsock that the guest mounts). Compare throughput and latency
  against virtio-fs for a typical repo build before committing.
- **Granularity and volume.** A build can do millions of stats. Decide what is
  recorded individually, what is aggregated (for example per-path counts per
  minute), and how long logs are kept.
- **Path safety.** Symlinks, `..`, hard links and case-insensitive APFS must not
  let a guest reach outside the share root. Resolve on the host, never trust guest
  paths.
- **Read-only enforcement** happens on the host, not by a guest mount flag.
- **Lifecycle.** Shares belong to one sandbox; deleting the sandbox ends them. A
  durable sandbox's shares survive restarts. Decide whether a share can be
  added to a running sandbox.
- **Operations.** Likely share, unshare, list and read-log. Sharing a host path is
  a host-boundary change, so decide who may request it: any authorized agent, or
  only a local CLI session on the host itself.
- **Security model.** Update [SECURITY.md](../../SECURITY.md): shared folders are
  the first explicit host interface, and its review belongs there.

## Depends on

Create and delete for sandboxes, so a share has a clear owner and lifetime.
