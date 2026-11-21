# Two-Mac runbook

The user's own end-to-end test on two real Macs. Everything here was proven on
one Mac with a simulated second one (`npm run proof -- 13 --tier l,v`); this run
checks what a simulation cannot: two real machines on different networks, real
sign-in email, a cloud agent on the internet, and an image copied directly
between the two Macs across the internet (step 8, the sandbox-images plan's
tier `x`).

**Before you start** (the orchestrator confirms these):

- The first signed release is published on GitHub Releases.
- Production is cut over: `api.localbox.sh` runs this version, and its Convex
  deployment holds the new tables.
- Resend is set up for `mail.localbox.sh`, so sign-in codes arrive by email.
  Without it, step 2 stops at "email delivery is not configured"; report that
  and stop.
- For step 8: the release's host daemon carries the direct copy transport, so
  `image copy` doesn't answer `unsupported`.

You need two Apple Silicon Macs on macOS 14 or newer, called **A** and **B**
below, one email address you can read, and a cloud agent that can add a remote
MCP server (for example Claude on the web with a custom connector). Run commands
in Terminal on the Mac named in each step. Where a command prints a generated
name (`quiet-otter`), use the name you got in later steps.

Write down for each Mac, before you start: its macOS version
(`sw_vers -productVersion`), and whether its screen lock asks for a password
(System Settings > Lock Screen). For step 8 the Macs must be on **different
networks** (for example B at another address, or on a phone's hotspot); write
down what each one is on (home Wi-Fi, office, hotspot) and its router if known.

## 1. Install on both Macs

On A, then on B, open Claude Code or Codex and say:

> Install Localbox for me by following https://localbox.sh/llms.txt

Expected: the agent downloads one release, verifies it, runs the installer, and
reports a checklist. Then check in Terminal:

```sh
~/.local/bin/localbox skill status     # state: installed, managed: true
~/.local/bin/localbox cli status       # state: linked
~/.local/bin/localbox host check       # hibernate: available, or the fixes
```

The installer printed a `Sleep:` line if `host check` is anything but
`available`. Leave the settings as they are for now; step 7 compares both. The
connector is installed but idle until the Mac signs in.

## 2. Sign in both Macs with one email

On A:

```sh
localbox login --email you@example.com
# check your inbox for "Your Localbox sign-in code", then:
localbox login --email you@example.com --code NNNNNN
```

Expected: `Signed in to <account-name> as <this Mac's name>. 1 machine.
Connector started.` Then:

```sh
launchctl print gui/$(id -u)/com.localbox.connector | grep 'state ='   # state = running
```

Repeat on B with the same email. Expected: the same account name,
`2 machines.` and `Connector started.`

Then, on either Mac, give them readable names and check both are there:

```sh
localbox machine list               # two machines, with their IDs
localbox machine rename <A's machine_id> mac-a
localbox machine rename <B's machine_id> mac-b
localbox machine list               # mac-a and mac-b, each with its room
```

## 3. Create a sandbox on each Mac

On A:

```sh
localbox sandbox create --sleep-after 2m
```

Expected: a generated name, `machine: mac-a`, a `placement_reason` that starts
`on mac-a, this machine`, its size and why, and actions `created` and
`cold_booted`.

On B:

```sh
localbox sandbox create
```

Expected: `machine: mac-b`, `on mac-b, this machine`.

Then from A, place one by name and one automatically:

```sh
localbox sandbox create --machine mac-b       # machine: mac-b
localbox sandbox create --placement auto      # the Mac with the most free memory; the reason says so
localbox sandbox list                         # every sandbox, its machine and state
```

## 4. Run across machines

On A, using the name of a sandbox that lives on B:

```sh
localbox shell exec --sandbox <B's sandbox> -- uname -a
localbox shell exec --sandbox <B's sandbox> -- sh -c 'echo from-a > /tmp/marker'
```

Expected: `Linux … aarch64 GNU/Linux`, exit code 0. On B:

```sh
localbox shell exec --sandbox <B's sandbox> -- cat /tmp/marker    # from-a
```

Time one cross-machine call so we know the real round trip:

```sh
time localbox shell exec --sandbox <B's sandbox> -- true
```

## 5. MCP from a cloud agent

On either Mac, `localbox mcp install` prints the server URL
(`https://api.localbox.sh/api/mcp`). Add it to the cloud agent as a remote MCP
server. When it opens the Localbox sign-in page:

- Expected page text: "Signing in gives <client> (<redirect host>) full access
  to account <account-name>: it can create, use and delete sandboxes on all your
  machines."
- Enter the same email and the code from your inbox.

Then ask the cloud agent:

> Use the Localbox shell.exec tool to run `uname -m` in sandbox <A's sandbox>.

Expected: `aarch64`, run in A's sandbox while A sits behind its own router with
no port forwarding. If A's sandbox was asleep, the result also reports `woke`.

## 6. Offline behaviour

Put B to sleep (Apple menu > Sleep), wait 10 seconds, then on A:

```sh
localbox shell exec --sandbox <B's sandbox> -- true
```

Expected within about 3 seconds: an error `machine_offline`, "the machine did
not pick up the request within 3 s; last seen <time>". Nothing runs on B later.

Wake B, wait about 10 seconds, and repeat: it runs again. When B wakes, its
sandboxes come back; the first result from each may report `woke`.

## 7. Sleep when idle

On A, in the sandbox created with `--sleep-after 2m`, start a small server and
note the PID it prints:

```sh
localbox shell exec --sandbox <A's sandbox> -- sh -c \
  'nohup node -e "require(\"http\").createServer((q,s)=>s.end(String(process.pid))).listen(8713)" >/dev/null 2>&1 & echo $!'
```

Leave it alone for 3 minutes, then:

```sh
localbox sandbox status <A's sandbox> --json      # state: sleeping
localbox shell exec --sandbox <A's sandbox> -- \
  node -e 'fetch("http://127.0.0.1:8713").then(r=>r.text()).then(console.log)'
```

Expected: the second command reports `woke` and prints the same PID: the server
survived the sleep.

Run this step twice on A, both times putting the display to sleep right after
starting the server (`pmset displaysleepnow`) and leaving it asleep for the
3 minutes:

- **Lock asks for a password** (`host check` says `only_while_unlocked`): the
  status detail reads "paused in memory: hibernate needs an unlocked screen";
  the sandbox kept its RAM.
- **Lock asks for no password** (set "Require password after screen saver
  begins or display is turned off" to Never; `host check` says `available`):
  the status detail reads "hibernated: state saved, memory released". This is
  proven on one Mac; this run checks it on yours.

## 8. Copy an image across networks

With A and B on different networks, save an image on A and copy it to B. On A:

```sh
localbox sandbox create --name copy-src
localbox shell exec --sandbox copy-src -- sh -c 'echo copied-from-a > /var/tmp/marker'
localbox image create --from copy-src --name netcopy
localbox image copy netcopy mac-b
localbox image wait netcopy      # repeat until it prints ready or failed
```

Expected: `image create` reports the save (a pause of about a second) and the
next command; `image copy` answers at once with `copying`; `image wait` shows
progress and ends with `copied image netcopy from mac-a to mac-b (SIZE,
DURATION, internet)`. Time it, and note the size. Then on B:

```sh
localbox image list                          # netcopy held by mac-a and mac-b
localbox sandbox create --image netcopy      # on mac-b, no copy needed
localbox shell exec --sandbox <that sandbox> -- cat /var/tmp/marker    # copied-from-a
```

**A restart mid-copy resumes.** On A, save a second image and ask for a sandbox
from it on B; restart B's daemon while it copies:

```sh
localbox shell exec --sandbox copy-src -- sh -c 'echo second > /var/tmp/marker'
localbox image create --from copy-src --name netcopy2
localbox sandbox create --image netcopy2 --machine mac-b
```

Expected: a `waiting` action ("sandbox … on mac-b is waiting for image netcopy2
to copy (SIZE); localbox image wait netcopy2"). On B, while
`localbox sandbox status <that sandbox>` shows `copying` with progress:

```sh
launchctl kickstart -k gui/$(id -u)/com.localbox.hostd
```

Then on A, `localbox image wait netcopy2` until done. Expected: the progress
picks up where it was, not from zero; the result prints the copy line, then
`created sandbox … on mac-b`, and `cat /var/tmp/marker` in that sandbox prints
`second`.

**If the copy fails:** expected is `copy_unreachable` listing every path tried
and the next step. That is an allowed outcome on some networks (a symmetric NAT
on both sides, or a firewall dropping UDP). Send the full output, then, from a
Localbox checkout on each Mac, collect the NAT report:

```sh
swift build --package-path apps/macos/HostDaemon --product localbox-punchlab
# on A: a test file to send, then the offer
mkfile -n 1g /tmp/punch.bin
.build/debug/localbox-punchlab offer --send /tmp/punch.bin --offer offer.json --answer answer.json
# copy offer.json to B (AirDrop is fine; it holds a one-time key), then on B:
.build/debug/localbox-punchlab answer offer.json --receive /tmp/punch-in --answer answer.json
# copy answer.json back to A, next to offer.json
```

(`.build` is under `apps/macos/HostDaemon`.) Send both commands' full output:
it names each side's STUN mapping and whether the punch connected.

**Same network, for comparison.** Put B on A's network, then on A:

```sh
localbox image copy netcopy2 mac-a      # already on mac-a: nothing to copy
localbox image delete netcopy --confirm netcopy --machine mac-b
localbox image copy netcopy mac-b
localbox image wait netcopy
```

Expected: the second copy ends `(SIZE, DURATION, local network)` and is faster.

## 9. Remove a machine

On A:

```sh
localbox machine remove <B's machine_id>
localbox machine list                    # only mac-a
```

On B:

```sh
localbox machine list                    # refused: this Mac was removed or must sign in again
launchctl print gui/$(id -u)/com.localbox.connector | grep -E 'state =|last exit code'
```

Expected on B, within a few seconds of the removal: the connector stopped on its
own (`state = not running`, `last exit code = 0`) and
`~/Library/Logs/Localbox/connector.log` ends with "machine credential revoked".
Sign B in again with step 2 to keep using it; the login starts the connector.

## 10. Clean up

On each Mac, `localbox sandbox list`, then delete what you made:

```sh
localbox sandbox delete <name> --confirm <name>
localbox image delete netcopy --confirm netcopy
localbox image delete netcopy2 --confirm netcopy2
```

## What to send back

1. Both Macs' macOS versions, the `host check` output from step 1, and for
   step 7 which run had the password lock.
2. The full text output of steps 2, 3 and 4 (with the `time` line), 6, 8 and 9,
   with which network each Mac was on in step 8.
3. A screenshot of the MCP sign-in page and the cloud agent's tool result (step 5).
4. For both runs of step 7: the `sandbox status --json` output while asleep, and
   the wake command's output.
5. Anything that differed from "Expected", with the command and its full output.
   Also attach `~/Library/Logs/Localbox/connector.log` and `hostd.log` from
   the Mac involved.
