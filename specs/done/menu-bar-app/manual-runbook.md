# Manual runbook

The legs of [Open verification](README.md#open-verification) that no agent
session can run: each logs out, restarts or needs a second machine. Run them on
a Mac with a published release installed through the
[installation procedure](../../../skills/localbox/references/installation.md)
unless a leg says otherwise. Record every answer in a copy of this file under
`evidence/manual/`, with the date, the Mac (model, RAM, macOS version) and the
Localbox version (`localbox app status --json | grep '"version"'`).

A failure is fixed where its owner lives, not patched here: `Lifetime` and
`ChildProcess` for logout and shutdown, `LoginItem` for the headless login
item, `installation.md` for the install, the daemon's restore path for the
cold boot. The [choices ledger](choices.md) names what each leg settles (V1,
V2, V4).

## Before every leg

```sh
localbox app status --json      # daemon "running", connector "connected", warnings []
localbox host check             # hibernate: available (else fix the lock settings it names first)
```

Record both outputs. A leg that needs hibernation is void while `host check`
says anything but `available`.

## 1. Logout and shutdown with two sandboxes running

Proves that a quit macOS asks for (logout, restart, shutdown) hibernates
running sandboxes, and how long macOS waits.

1. Create two sandboxes and give each a process that counts in memory:

   ```sh
   localbox sandbox create --name rb-one --memory 4G
   localbox sandbox create --name rb-two --memory 4G
   for s in rb-one rb-two; do
     localbox shell exec --sandbox $s -- sh -c 'nohup sh -c "i=0; while :; do i=\$((i+1)); echo \$i > /run/rb-counter; sleep 1; done" >/dev/null 2>&1 &'
   done
   localbox shell exec --sandbox rb-one -- cat /run/rb-counter
   ```

   Record each counter and the wall-clock time.

2. **Logout:** Apple menu > Log Out, confirm. Note the time you clicked and the
   time the login window appears. Log back in.
3. After logging in (the login item opens Localbox), wait for
   `localbox app status` to show the daemon running, then:

   ```sh
   localbox sandbox status rb-one --json   # last_boot.kind: woke, not cold_booted
   localbox shell exec --sandbox rb-one -- cat /run/rb-counter
   grep -E 'stopping|hibernated|stopped ' ~/Library/Logs/Localbox/hostd.log | tail -5
   grep -E 'quit|logout' ~/Library/Logs/Localbox/app.log | tail -5
   ```

   Record: each sandbox's `last_boot.kind` and `detail`; whether each counter
   continued from its old value (it keeps counting from where it stopped, so
   it is near the recorded value, not near 0); the `hibernated NAME` lines and
   their timestamps; the seconds from the click to the login window.
4. **Shutdown:** repeat steps 1 to 3 with Apple menu > Shut Down. Power on,
   log in (or let automatic login do it) and record the same facts. Also
   record whether macOS showed "Localbox is preventing shutdown" or similar,
   and for how long.
5. Clean up: `localbox sandbox delete rb-one --confirm rb-one` and the same
   for `rb-two`.

**Pass:** both sandboxes `woke` after both legs, counters continuous, no
dialog. Record the logout and shutdown waits even when they pass.

## 2. A headless Mac after a reboot

Proves the login item brings Localbox up with no display and no click.

1. On a Mac set up as `installation.md` asks for a headless one (automatic
   login on, screen lock password Never), with Localbox installed and signed
   in, check `localbox app status --json` shows `login_item.state: enabled`.
2. Disconnect the display (or use a Mac mini with none). From another machine:

   ```sh
   ssh USER@HEADLESS 'sudo shutdown -r now'
   ```

3. Wait for SSH to answer again, then, with no other action:

   ```sh
   ssh USER@HEADLESS '~/.local/bin/localbox app status --json'
   ssh USER@HEADLESS '~/.local/bin/localbox host check'
   ```

   Record: the seconds from reboot to the first answer; `daemon`,
   `connector`, `login_item` and `warnings`; `hibernate`. If `app status`
   answered only because the CLI started the app (check
   `ssh USER@HEADLESS "grep -c 'launch' ~/Library/Logs/Localbox/app.log"` and
   the app's start time with `ps -o lstart= -p $(pgrep -x Localbox)` against
   the boot time from `sysctl -n kern.boottime`), the login item did not work:
   record that.
4. From a different machine signed in to the same account:
   `localbox machine list` shows the headless Mac online.

**Pass:** the app was already running before the first `localbox` call, the
daemon is running, the connector connected, the Mac online in the account.

## 3. A first install from a published release

Proves the procedure on a Mac that never had Localbox, against the real
release on GitHub (not a local feed).

1. On a Mac with no `~/Applications/Localbox.app`, no `~/.local/bin/localbox`,
   no `~/Library/Application Support/Localbox` (record `ls` of each), open
   Claude Code or Codex and say exactly:

   > Install Localbox for me by following https://localbox.sh/llms.txt

2. Record: every command the agent ran (its transcript), any prompt or dialog
   macOS showed (there should be none; a Gatekeeper or Local Network prompt is
   a failure), and the total time.
3. Record the outputs of step 6's checks (`app status`, `cli status`,
   `skill status`, `host check`) and the built-in image's arrival:

   ```sh
   cat ~/Library/Application\ Support/Localbox/builtin-image.json
   du -sh ~/Library/Application\ Support/Localbox/downloads ~/Library/Application\ Support/Localbox/images
   ```

   Record the minutes from launch to `phase: ready` and the peak of the two
   folders' sizes while it ran.
4. Let the agent sign in (the code arrives by email) and create a sandbox:
   `localbox sandbox create` then `localbox shell exec -- uname -a`.
5. In a new terminal, check `localbox --help` works from `PATH`.

**Pass:** no click beyond reading the email code, every check as step 6
says, a sandbox running a command.

## 4. A true SSH install from another machine

Spike 01 and the real-account proof ran the install from a detached, stripped-environment
shell on the same Mac; SSH key login to localhost was not set up. This leg is
the real thing.

1. From another machine with key login to the target Mac (which is logged in
   at its console, screen may be locked), run each block of
   `installation.md` steps 1 to 6 over SSH, one `ssh` per block:

   ```sh
   ssh USER@TARGET 'sh -s' < step2.sh    # likewise step3.sh, step4.sh, step5.sh, step6.sh
   ```

   (cut each `sh` block from the procedure into its own file first).
2. Record each block's output and exit code, whether step 5 returned at once,
   and whether the app appears in the target's menu bar.
3. Record `ssh USER@TARGET '~/.local/bin/localbox app status --json'`:
   `login_item.state` must be `enabled` (or `requires_approval`, recorded with
   what System Settings shows).
4. Repeat step 5 with the target's screen locked and record the same.

**Pass:** every block exits 0, the app runs in the target's GUI session, the
login item registered, no dialog on the target's screen.

## 5. The rare cold boot after a restore

Spike 02 saw one restore in about 40 come back `cold_booted` with "guest
channel is unavailable" after 125 s; a later soak's 520 restores never did. What
is known is in [choices.md](choices.md) (V1). This leg keeps the evidence if
it happens on a real install.

1. Whenever any sandbox reports `cold_booted` with "guest channel is
   unavailable" (in a command's actions, or `localbox sandbox status NAME
   --json` under `last_boot`), immediately copy before anything restarts it:

   ```sh
   d=~/Desktop/localbox-coldboot-$(date +%Y%m%d-%H%M%S); mkdir -p "$d"
   id=$(localbox sandbox status NAME --json | sed -n 's/.*"sandbox_id": *"\([^"]*\)".*/\1/p')
   cp ~/Library/Application\ Support/Localbox/sandboxes/$id/console.log "$d/"
   cp ~/Library/Application\ Support/Localbox/sandboxes/$id/sandbox.json "$d/"
   cp ~/Library/Logs/Localbox/hostd.log ~/Library/Logs/Localbox/app.log "$d/"
   localbox host check > "$d/host-check.txt"
   vm_stat > "$d/vm_stat.txt"; sysctl vm.swapusage > "$d/swap.txt"
   ```

2. Record: what preceded the restore (an update, a logout, a quit, sleep to
   make room), how many sandboxes and how much memory were saved, whether the
   Mac was swapping, and whether the screen was locked.
3. In `console.log`, look for `localbox-guest.service` failing or hitting
   `start-limit-hit`; in `hostd.log`, the lane attempts around the restore.

**Pass:** none needed; this leg collects evidence. Attach the folder to the
issue that reopens V1.
