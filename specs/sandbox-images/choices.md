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
