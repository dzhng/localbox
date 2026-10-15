# Security model

Localbox has three trust boundaries: the sandbox (a Linux VM) against the Mac
that runs it, your account against everyone else's, and the hosted relay
between a remote agent and your Macs. This document says what each one holds,
what it does not, and what is out of scope.

## The VM is the boundary

Each sandbox is its own Linux VM under Apple Virtualization, with its own disk
(a copy-on-write clone of the template), MAC address and machine identifier.
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
- Five wrong guesses delete the code.
- Sends are limited to 5 an hour per email and 20 an hour per client IP;
  verifications to 50 an hour per client IP. A send over the limit still answers
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

Revocation: `localbox logout` on the Mac, or `localbox machines remove` from any
machine or agent in the account, marks the machine revoked. Every Convex call
checks that mark, so a removed machine is refused at once, even while its
24-hour token has not expired. The token route then refuses the secret, and the
connector on the removed Mac stops and exits.

## Agent tokens (MCP and the agent API)

Remote agents sign in with OAuth 2.1 against `api.localbox.sh`:

- Clients register dynamically; redirect URIs must match exactly.
- PKCE with S256 is required; a request without it is refused.
- The sign-in page names the client and its redirect host, and says plainly that
  the agent gets **full access to the account**: it can create, use and delete
  sandboxes on every machine in it. There is one scope, `account`.
- Access tokens last 15 minutes. Refresh tokens last 30 days and rotate on
  every use; replaying an old refresh token revokes the whole token family,
  including the newest tokens. Tokens can also be revoked at the revocation
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
through the local daemon and writes the result back. The Mac opens no inbound
port.

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
- Sandbox disks are not encrypted by Localbox beyond what macOS provides for
  the user's files.
