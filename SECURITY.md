# Security model

Localbox has four trust boundaries: the sandbox (a Linux or macOS VM) against
the Mac that runs it, your account against everyone else's, the hosted relay
between a remote agent and your Macs, and the direct connection two of your Macs
open to copy an image. This document says what each one holds, what it does not,
and what is out of scope.

## The VM is the boundary

Each sandbox is its own Linux or macOS VM under Apple Virtualization, with its
own disk (a copy-on-write clone of its image), MAC address and machine
identifier. A sandbox made from an image regenerates its machine identity and SSH
host keys on first boot, so sandboxes from one image never share them.
The agent, its tools and everything it installs inside the VM share one trust
domain and one filesystem. Shell is the authority; browser, filesystem,
screenshot and desktop operations are convenience adapters over that same
authority.

Do not create per-tool capability splitting, payload allowlists, or approval
prompts for actions that an authorized agent can already cause through shell.
Those layers would add complexity without creating a meaningful boundary inside
the VM.

Authorization grants access to the VM as a whole. The CLI and MCP enforce the
same authorization decision and the same operation permissions, because both
come from one operation catalog.

The host keeps the guest agent inside every VM current: when a guest's agent
build differs from the one the host ships, older or newer, the host pushes its
own build over the VM's private channel and the agent replaces itself.

## macOS guests run with SIP off

System Integrity Protection is disabled inside every macOS sandbox, never on the
Mac that runs it. The guest agent needs Screen Recording, Accessibility and
input-posting permission for the desktop and browser operations, and macOS grants
those only through a person clicking prompts or a write to its permission
database that SIP forbids. With SIP off, the agent grants them to itself, and
again after each update, with no human step.

This costs nothing at the VM boundary. Inside the guest the agent already runs as
root, and everything in the VM is one trust domain (above); SIP would protect the
guest's system files from that same root. The Mac's own SIP, and the
Virtualization framework between the guest and the Mac, are untouched.

Building the macOS base is the one time a macOS guest is reachable other than
through its agent:

- macOS comes from Apple: the base is installed on the Mac from Apple's restore
  image, downloaded from Apple. Chrome comes from Google's own installer.
  Localbox adds only its guest agent, its vsock forwarder and its desktop
  helper, shipped inside the signed app.
- The build turns on Remote Login in the guest with a random password that lives
  only in the building process's memory, installs the agent over SSH, then turns
  Remote Login off and discards the password before the image is saved. The
  guest's one user logs in automatically; nobody knows its password.
- To disable SIP, the build types into the guest's Recovery screen through the
  Virtualization framework's VNC server. That server listens on the Mac's
  network interfaces for the length of that step, behind a one-time VNC
  password.

## Images

An image is a sandbox's disk and boot settings, saved on the Mac that holds it
under `~/Library/Application Support/Localbox/images`. Convex keeps the image's
name, OS, size, source and which Macs hold it, never its contents.

- An image carries everything that was on the sandbox's disk: installed tools,
  files, browser sessions and any tokens left there. Every sandbox made from it
  starts with all of that. Images stay inside the account, but anything signed
  in when the image was saved is signed in again in each new sandbox.
- Deleting an image removes its files from every Mac holding it (a Mac that is
  offline removes them when it next connects) and its row from Convex. Sandboxes
  made from it keep their own disks. Deleted files are removed, not securely
  erased; blocks a sandbox still shares with the image stay until that sandbox
  is deleted too.
- The built-in `linux` image comes from the signed release
  ([releases](#releases-and-updates)).

## The host remains outside the VM boundary

A sandbox does not get access to the Mac's files, processes, credentials or
screen. No host folder is shared with any sandbox today. Host integration is an
explicit product feature and must go through a narrow, reviewed interface;
audited shared folders are the planned one and are not built yet.

Networking is Apple's NAT: a sandbox reaches the internet through the Mac, and
nothing outside the Mac can connect in. The sandboxes on one Mac share that NAT
network. Localbox does not firewall them from each other, or from services the
Mac itself listens on, on that network.

On the Mac, the CLI talks to the host daemon over a Unix socket and must present
an owner-only token (`ipc-token`, mode 0600). That token has no account meaning;
it only proves the caller is the Mac's user.

## Accounts and email codes

An account is one person, identified by a verified email address. There are no
passwords. Signing in sends a 6-digit code to the email:

- Codes come from a cryptographic random source, are stored only as a SHA-256
  hash, expire after 10 minutes, and are deleted once used. Sending a new code
  replaces the old one.
- Five wrong guesses delete the code, and a replacement code inherits the
  count. Wrong guesses also count per email across codes: past 10 in an hour or
  20 in a day, verification is refused, even for the right code. Asking for
  fresh codes therefore buys an attacker no extra guesses; the cost is that
  someone guessing at an email can hold its owner out for up to a day.
- Sends are limited to 5 an hour per email and 20 an hour per client IP;
  verifications to 50 an hour per client IP. An IPv6 client counts by its /64
  prefix, so rotating addresses inside one allocation does not reset the
  limit. A send over the limit still answers
  "code sent", so the response never reveals whether a code went out. The client
  IP comes from Vercel's own headers, not a caller-supplied `x-forwarded-for`.
- Codes are delivered by Resend from `login@mail.localbox.sh`.

Whoever controls the email inbox controls the account. That is the trust
anchor, and it is out of Localbox's hands.

## The machine credential

Signing a Mac in creates a machine in the account and gives it a long random
secret. Convex stores only its SHA-256 hash. On the Mac the secret lives in one
file, `~/.config/localbox/credentials.json`, mode 0600 (not the Keychain); the
CLI and the connector both read it.

The connector exchanges the secret at `POST /api/relay/machine-token` for a
24-hour machine token, and that token is the only way the Mac talks to Convex.

Revocation: `localbox logout` on the Mac, or `localbox machine remove` from any
machine or agent in the account, marks the machine revoked. Every Convex call
checks that mark, so a removed machine is refused at once, even while its
24-hour token has not expired. The token route then refuses the secret, and the
connector on the removed Mac stops and exits. The machine's sandboxes leave the
account catalog with it; their disks stay on that Mac, which is never told to
delete them. A Mac removed elsewhere can still run `localbox logout` to delete
its credential file. The sign-in code page names no account, so it reveals
nothing about an email before its code is verified.

## Agent tokens (MCP and the agent API)

Remote agents sign in with OAuth 2.1 against `api.localbox.sh`:

- Clients register dynamically; redirect URIs must match exactly.
- PKCE with S256 is required; a request without it is refused.
- The sign-in page names the client and its redirect host, and says plainly that
  the agent gets **full access to the account**: it can create, use and delete
  sandboxes on every machine in it. There is one scope, `account`.
- Access tokens last 15 minutes. Refresh tokens last 30 days and rotate on
  every use; replaying the refresh token a client last rotated away revokes the
  whole token family, including the newest tokens (older ones are deleted at
  rotation and simply refused). Tokens can also be revoked at the revocation
  endpoint. Convex stores token hashes only.
- An agent token reaches only its own account's machines and sandboxes; another
  account's sandbox is reported as not found, by name or by ID.

## Convex is an authenticated boundary

The Convex deployment URL ships to every Mac, so Convex cannot rely on being
hidden. Every public Convex function requires a token signed (ES256) by the
Vercel functions' private key and checked against the public key set Convex is
configured with. There are three identities:

| Identity | Who | Lifetime |
| --- | --- | --- |
| service | the Vercel routes (sign-in, OAuth, the agent API) | 5 minutes |
| machine | one Mac's connector | 24 hours |
| agent | one OAuth token family | 5 minutes |

Each function demands the identity it serves, and machine and agent revocation
is checked on every call, not only when a token is issued. Operator functions
such as `admin:wipe` are internal and run only through `npx convex run`.
Functions take time from the server, never from the caller.

## Relay trust

The relay is the path a request takes when the agent is not on the same Mac as
the sandbox: the agent API on Vercel writes the request into a Convex mailbox,
the target Mac's connector claims it over its outbound subscription, runs it
through the local daemon and writes the result back. The relay never needs an
inbound port on the Mac; the one inbound flow Localbox accepts is an image copy
between two of your Macs ([below](#direct-image-copies)).

What the relay can see: requests and results are stored in Convex rows as
plain JSON. There is no end-to-end encryption, so whoever operates the Vercel
project or the Convex deployment, and those providers, can read the commands an
agent sends and the output and file contents that come back. Requests between
the CLI and a sandbox on the same Mac never go through the relay.

Limits and retention:

- Relay rows older than 24 hours are deleted by a daily cleanup, so a row lives
  at most about two days.
- Each response is capped at 900 KiB; longer output is trimmed and the result
  says so.
- Each account may relay 500 requests and 25 MB of results a day; past that,
  requests are refused with the limit and the reset time.
- A request no Mac claims within 3 seconds is answered `machine_offline` and is
  never run later. A mutation whose result was lost is reported as
  `operation_uncertain` and never retried silently.

## Direct image copies

Images move straight from one of your Macs to another, never through the relay,
Convex or any cloud storage. A copy is set up through the account and then runs
peer to peer:

- **Rendezvous.** The relay writes a one-time copy row in Convex naming the image,
  the sending Mac and the receiving Mac, with a fresh random key for this copy
  only. Only those two Macs' machine credentials can read the key. Each Mac
  publishes where it can be reached through that row: its local network addresses
  and, for the internet, its public address and port.
- **Transport.** Each Mac opens a UDP port for this copy and accepts only
  datagrams sealed (ChaCha20-Poly1305) under the copy's key; anything else is
  dropped, so the only peer either one talks to is the one named in the
  rendezvous. Every
  chunk is checked against the sender's sealed manifest, and the receiver refuses
  manifest paths that would write outside the copy's own temporary folder. The
  port closes when the copy ends. Local network addresses are tried first; across
  the internet the two Macs open the path toward each other at once (UDP hole
  punching), so neither needs port forwarding.
- **Address discovery.** To learn its public address and port, a Mac asks
  Cloudflare's public STUN server (`stun.cloudflare.com`). STUN sees only that
  the Mac asked, from which address; no image bytes, names or account details go
  through it.
- **Failure.** If neither path connects, the copy fails, says which paths were
  tried and what to try next. There is no relayed fallback.

The key lives in the Convex row, so whoever can read the Convex deployment (see
[relay trust](#relay-trust)) could read it while the copy runs. Copy rows expire
after 24 hours.

## What runs on the Mac

Localbox is one menu bar app, `Localbox.app`, running as the logged-in user. It
starts the host daemon (the only process holding the virtualization
entitlement) and the connector as its own children; nothing runs as root, and
there is no launchd job or background helper outside the app. While a sandbox
runs, the daemon holds a power assertion that keeps the Mac from idle-sleeping
(`pmset -g assertions` lists it); it changes nothing else. The installation
procedure opens it, and it then opens at login (a login item the user can turn
off in System Settings or with `localbox app login-item off`). Quitting it takes
this Mac offline: its sandboxes hibernate, the relay can no longer reach it,
and nothing serves them until the app opens again, which any `localbox` command
does by itself.

## Releases and updates

A release is trusted through its manifest: `release.json` lists every artifact's
SHA-256 and carries an Ed25519 signature checked against the release public key
pinned in the Localbox skill. The manifest never supplies its own key.

- **A first install** has nothing installed to verify with. Its trust rests on
  GitHub's TLS and on the public key printed in the installation procedure. The
  procedure checks the signature itself, with the JavaScriptCore shell every Mac
  has, before anything from the download runs, then checks the app's zip against
  the signed digest. Anyone who can change both the procedure and the release
  can change what is installed.
- **Updates** come through Sparkle, patched and built from pinned source. The app
  reads a feed that must be signed (`SURequireSignedFeed`) and installs only an
  archive whose signature verifies before it is unpacked, both with the release
  key's public half sealed in the installed bundle as `SUPublicEDKey`. The
  feed's address is
  `localbox.sh/mac/appcast.xml`, redirected to the latest GitHub release; whoever
  controls that redirect or the release can withhold updates but cannot make the
  app accept one not signed with the release key. Reinstalling with the
  procedure is verified as a first install is.
- The app and everything in it that runs (the menu bar app, the daemon, the CLI
  launcher and the bundled Node) are code-signed with a self-signed Localbox
  identity, not an Apple Developer ID, and are not notarized; macOS itself
  vouches for nothing here. The download is never quarantined (`curl` does not
  mark it), and the procedure stops rather than strip a quarantine flag it
  finds. Only the daemon holds the virtualization entitlement.
- The guest agent binaries the app pushes into sandboxes are sealed by the app's
  signature as they were built, never re-signed, so their digests are the ones
  the daemon checks guests against.
- The built-in `linux` image is outside the code signature. The manifest covers
  it instead: each compressed part's checksum and the expanded disk's SHA-256 and
  size.

## Non-security limits

Uniform rate, bandwidth, disk, execution-time and relay-cost limits are sanity
and operations controls. They apply to every authorized caller and do not split
the VM's trust domain.

## Out of scope

- An agent you signed in can do anything your account can, on every machine in
  it. Localbox does not try to limit an authorized agent inside its sandboxes.
- A compromised Mac, or an administrator on it, can read that Mac's machine
  credential, IPC token and sandbox disks.
- A compromised email inbox gives its holder the account.
- The relay's providers (Vercel, Convex) and the email provider (Resend) are
  trusted with what passes through them, as described above.
- Isolation between sandboxes on the same NAT network, and from services the
  Mac exposes on it, is not enforced.
- Sandbox disks and images are not encrypted by Localbox at rest, beyond what
  macOS provides for the user's files.
- macOS guests are licensed by Apple for the Mac owner's own development,
  testing and personal use, at most two running per Mac. Localbox does not
  support offering them to anyone else.
