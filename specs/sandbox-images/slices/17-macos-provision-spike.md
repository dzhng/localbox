# 17 macOS provisioning, bootstrap and SIP spike (go/no-go)

**Unlocks:** L2 and Q3. A macOS 27 guest reaches an auto-logged-in desktop with
no Setup Assistant, the host gets code into it with no human step (P3), and one
scripted Recovery session disables SIP. Confirm item 3.

## Seam

- `localbox-vmlab macos-provision --json`, on a fresh clone of 16's base:
  1. First boot with `VZMacGuestProvisioningOptions`: user `localbox`, a random
     password, auto-login on, Remote Login on.
  2. Wait for SSH on the guest's NAT address (learned from the DHCP lease file
     `/var/db/dhcpd_leases` keyed by the clone's MAC). Copy and run a probe
     LaunchDaemon (a script that writes `/var/localbox/probe` at boot).
  3. Restart into Recovery (`VZMacOSVirtualMachineStartOptions.startUpFromMacOSRecovery`).
     Drive `csrutil disable` through `_VZVNCServer` keystrokes: open Terminal,
     type the command, confirm, enter the username and password.
  4. Reboot normally, read `csrutil status` and the probe file over SSH, then turn
     Remote Login off.
- `HostDaemonCore/RecoveryVNC.swift`: the only file allowed to touch private API.
  Screen detection uses framebuffer captures and Vision text recognition, never
  fixed sleeps alone.
- Built and run as release-signed (`scripts/release.sh` signing identity,
  self-signed, not notarized; see the README's correction to the map).
- Probe `17-macos-provision-spike.ts`, tiers `m`.

## See it

`npm run proof -- 17 --tier m`: a desktop screenshot with no Setup Assistant pane,
the probe file's timestamp, `csrutil status` output, the VNC transcript with a
capture per step. Saved as the cached provisioned base
`$LOCALBOX_VMLAB_DIR/macos-provisioned/` for 18 and 19.

## Gates

No human input at any step; auto-login desktop; probe LaunchDaemon ran; SIP
reports disabled; Remote Login off at the end.

## Stop rules

- Provisioning options fail (no user, no auto-login or no SSH): L2 reopens, an
  agent decision. Fallback to record and continue with: type through Setup
  Assistant with the same `RecoveryVNC` driver, one script for macOS 27 only.
- `csrutil` can't be driven: Q3 and Q12 reopen, a user decision. Stop and ask.

## Delegated

Keystroke timing, text-recognition thresholds, the lease-file parsing, password
generation.

## Feedback that would change it

The user accepting SIP on (desktop then needs a human permission click), or
preferring the Setup Assistant script over provisioning options.
