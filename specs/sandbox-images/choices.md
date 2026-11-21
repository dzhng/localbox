# Sandbox images: choices ledger

Decisions made where the spec was silent, appended per pass. Verdicts: **sound**,
**provisional** (revisit at the named slice), **user** (needs the user's call;
the recorded provisional call stands meanwhile).

- **15 — GRUB, not systemd-boot, with a fixed config reading the kernel symlinks.**
  Sound. GRUB reads the kernel from the ext4 root, so a kernel install only has to
  repoint `/boot/vmlinuz` (which Ubuntu's kernel packages already do); systemd-boot
  would need every kernel copied onto the EFI partition by kernel-install hooks.
  Alternative: systemd-boot with kernel-install.
- **15 — `update-grub` is replaced by `true` in the image.** Sound. grub-mkconfig
  would overwrite the fixed config with device-specific entries; nothing in the
  image needs it. Alternative: let it run and depend on its device detection in a VM.
- **15 — the kernel-upgrade test installs the HWE kernel.** Sound. The image already
  has the newest GA kernel, so "a newer kernel" is only reliably available as the
  HWE series; it proves the same thing (a different version boots). Alternative:
  pin the image to an older GA kernel.
- **15 — `AppleVirtualizationBackend` takes an optional configuration closure.**
  Provisional — slice 23 replaces it with `VMSpec`. It let vmlab boot an EFI
  configuration through the real backend (channel, save, restore) without copying
  the backend. Alternative: a parallel lab-only backend.
- **21 — every `image.*` op has executor `account` and names no sandbox.** Convex owns the image record (single-owner table), so the CLI always sends image ops to the agent API; `image.create`'s source sandbox travels as input `from`, because the op is about an image, not about acting on that sandbox. Alternative: `host` executor for create/copy/wait, which would let the CLI try the local daemon first and split ownership of the record.
- **21 — `image.delete` input is `{ image, confirm? }`; `--machine` stays on the envelope.** The slice's input column lists `machine?` while its note says `--machine` is the routing selector, not input; the CLI never puts a control flag into input anyway. Alternative: a `machine` input field, which would make the one op that routes by machine differ from every other.
- **21 — "exactly one of `from`/`macos`" lives in `validateInput` (contract), not a JSON Schema `oneOf`; `macos` only accepts `true`.** A top-level `oneOf` in a tool input schema is refused by common model tool APIs that read the MCP tool list. `validateRequest` and the relay both call `validateInput`. Alternative: two ops (`image.capture`, `image.build`), which renames commands the user chose (Q10).
- **21 — `hostOperationIds` = host executor ∪ account ops routed to machines or holders ∪ the named `sandbox.list`.** `sandbox.list` is the one account read the daemon also answers (a signed-out CLI lists local sandboxes), so it is listed by name rather than by a prefix. Alternative: a fourth per-op flag, which would restate what routing already says for every other op.
- **21 — HostDaemon answers the four relayed image ops `unsupported` until the daemon slices build them.** Regenerating `GeneratedOperations.swift` adds them to `HostOperation`, and `SandboxHost`'s exhaustive switch must name them to compile; that is the only Swift change. Alternative: keep image ops out of the generated enum until slice 26, which needs a special case in `hostOperationIds` and contradicts slice 21's "See it".
- **21 — `tests/contract-executor.test.ts` becomes `tests/catalog-routing.test.ts`.** The new literal routing table covers the old executor and scope lists, so keeping both would state each op's route twice; probe 09 now runs the renamed file. Alternative: two tests asserting overlapping tables.
- **21 — `ImageOperationState.error` is `{ code, message, next_step }`.** The failed state must carry the reason and the next step (Q5, output standard); `code` reuses the contract's error codes so the CLI renders it like any other error. Alternative: free text only.
- **22 — `images.sizeBytes` is optional: absent until a holder reports the image `ready`, and `setHolder` carries `sizeBytes` with that report.** A capture or build doesn't know its size at reserve time, and 0 would read as a real size in `image list`. Alternative: a separate `setSize` function, a second write path for one field.
- **22 — `reserve` takes the building machine and writes its `building` holder row in the same mutation, deduped on `createMutationId`.** A reserved image with no holder would list as orphaned until the connector's first report. Alternative: reserve the row only and let slice 26's connector report create the holder.
- **22 — `setHolder` is machine-only (the caller's own holding); `dropHolder` is an account call naming the machine.** Holder state is what a Mac reports about itself (connector), while `image delete --machine` runs as the agent or CLI caller (slice 30). Alternative: both machine-only, which would make the relay call as a machine it isn't.
- **22 — the synthesized `linux` row has `image_id: "linux"`, `source: { kind: "release" }`, `size_bytes: null`, `created_at: null`.** It isn't a row (P1), so it has no id, size or creation time; `release` says where it comes from without widening the stored `source` union. Alternative: a fake id and size per machine.
- **22 — built-in names refuse with `invalid_input`, taken names with `name_conflict`; `setDefault linux` clears `defaultImageId`.** Absent already means `linux`, so storing it would be a second spelling of the same state. Alternative: store `"linux"` explicitly.
- **22 — generated image names reuse `sandboxName()` (adjective-animal).** The map's samples (`brave-walrus`) use that shape; a second generator would be the same lists. Alternative: rename it to a neutral name in `packages/names`.
- **22 — the `images`, `imageHolders` validators live in `schema.ts`.** `images.ts` imports `lib/relay.ts`, which imports `schema.ts`, so defining them in `images.ts` would make the schema import a function module. Alternative: a separate validators file.
- **36 — the per-machine image fields (`holds`, `heldAt`, `freeDiskBytes`, `macOSVersion`, `macVMsRunning`) are optional, each with a cautious reading when absent.** No disk reported means no copy goes there (`disk_full` says it wasn't reported); no macOS version means no macOS image goes there. Capacity gains disk and version only in slice 24, and the create route has no image yet. Alternative: required fields that the relay fills with made-up values until then.
- **36 — auto/remote copies to a non-holder only when that machine has room; when no holder has room and no roomy machine can take a copy, a holder makes room as today.** Copying gigabytes to a machine that must then also make room is worse than making room where the image already is. Alternative: the slice's literal rule (roomiest non-holder with disk, whether or not it fits).
- **36 — a Mac already running `MAC_VM_LIMIT` (2) macOS guests counts as having no room for a macOS image.** Auto then prefers a Mac with a free slot; a named or own Mac is still used, and its admission sleeps a guest or answers `machine_full` (E11). Alternative: ignore the count in placement and leave it all to admission.
- **36 — a copy comes only from an online holder (most recent `heldAt`, then name).** A copy needs the source to answer. Offline holders only give `machine_offline` naming them; no holder at all gives `image_not_found`. Alternative: plan from an offline holder and let the copy wait for it.
- **36 — `BUILT_IN_IMAGE = "linux"` lives in the contract, shared by `images.ts` and `place()`; the create route places that image until slice 29 resolves `image`.** One spelling of the built-in name across Convex, placement and the relay. Alternative: the literal repeated in each package.
- **36 — `minMacOS` and `macOSVersion` are dotted strings compared numerically (`atLeast`).** That's how macOS reports versions, and "27.10" must beat "27.9". Alternative: store major/minor as numbers.
