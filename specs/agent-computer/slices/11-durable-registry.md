# Slice 11 — Durable registry, reset, and optional multiple VMs

## Contract unlocked

The default VM preserves user state, reset is explicit, and a second VM can be
modeled without a new security boundary if the low-cost path is proven.

## API seam and ownership

The host registry owns `vm_id`, name, image digest, disk path, lifecycle state,
and selected/default VM. The VM disk owns guest files, packages, browser profile,
and desktop state. OAuth and every operation carry the selected `vm_id`.

## Runnable artifact

Create a default VM, install a package, write a file and browser cookie, stop and
reprovision it, then verify persistence. Run explicit `vm.reset --discard-state`
and verify the empty-state report. If the implementation cost is low, create a
second VM and select it through CLI/OAuth; otherwise record the one-VM fallback.

## Verification

- Reprovision preserves state unless discard is explicit.
- Reset requires an explicit destructive confirmation and reports what changed.
- Concurrent calls route to the exact VM ID.
- Live Chrome state is never copied mid-write.
- Multiple VMs, if shipped, do not introduce per-tool scopes or a second trust
  model.
