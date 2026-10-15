# 06 Email identity

**Unlocks:** a person signs in with an email and a code; each Mac gets one
non-expiring machine credential; the CLI shows the account and its machines
(map Q8–Q13, L8). Removes the Keychain/PKCE login (seam T5).

## Seam

- Vercel routes in the relay function (talking to Convex with a service JWT):
  - `POST /api/auth/email/start {email}` → always "code sent".
  - `POST /api/auth/email/verify {email, code, machine_name}` →
    `{account_id, account_name, machine_id, machine_name, secret, machine_count}`.
  - `POST /api/auth/logout` revokes the calling machine's credential.
  - `POST /api/v1/ops`: the **one agent API route**. In this slice it runs
    account-executor catalog operations inside Convex; slice 07 extends the same
    route to machine-bound operations. There are no per-resource REST routes.
- Catalog (`packages/contract`): entries gain `executor: "account" | "host" |
  "guest"`; new account-executor operations `account.status`, `account.rename`,
  `machine.list`, `machine.rename`, `machine.remove`. Snapshots regenerated.
  - Client IP from `x-real-ip`/`x-vercel-forwarded-for`, never caller
    `x-forwarded-for` (L8).
- Convex `signin` owns codes and limits: 6 digits, 10 min, one active per email
  (a new request replaces it), 5 guesses; 5 sends per email per hour, 20 sends per
  IP per hour, 50 verifies per IP per hour (Q9). Codes and secrets are stored
  hashed.
- `packages/mail`: `Mailer.sendCode({to, code, idempotencyKey})`.
  `ResendMailer` → `POST https://api.resend.com/emails` from
  `Localbox <login@mail.localbox.sh>`, plain text, no links, `Idempotency-Key`.
  `DevLogMailer` writes `{"event":"localbox.dev.email_code",…}` only when
  `LOCALBOX_LOCAL_SERVICES=1` and `LOCALBOX_DEV_PRINT_CODES=1`. Neither available →
  the handler refuses to start (Q11).
- `packages/names`: `accountName()` (`brave-walrus-482`), `sandboxName()`
  (`quiet-otter`), `machineName(hostname)`, `validateLabel()` (3–40 of
  `[a-z0-9-]`) (Q12).
- `packages/credentials`: read/write `credentials.json` (mode 0600, atomic write,
  refuses looser modes) holding `{api_origin, convex_url, account_id,
  account_name, machine_id, machine_name, secret}` (Q8). Convex stores the
  secret's hash only.
- CLI, non-interactive because the reader is an agent:
  `localbox login --email x` → "Code sent to x. Ask the user for the 6-digit code,
  then run: localbox login --email x --code NNNNNN". The second step prints the
  account name, this machine's name and the machine count (S2). `logout` revokes
  then deletes. `machines list|rename|remove`, `account show|rename`. Text by
  default, the same facts with `--json` (S3). Signing in on a Mac already signed
  in to another account refuses and names that account.
- Delete `loginWithPkce`, Keychain and `auth.json` code, `LOCALBOX_TOKEN`,
  `auth login`, `packages/client/src/auth.ts`, `tests/client-auth.test.ts`.

## See it

`npm run proof -- 06 --tier u,l`: machine A logs in with a code read from the dev
log; B logs in with the same email and the reply says 2 machines; credential mode
is 0600; `machines list` shows both; `machines remove b` from A makes B's next
call fail "this machine was removed; run localbox login"; a sixth send in the
hour still says "code sent" with no code issued; five wrong guesses kill the code;
a spoofed `x-forwarded-for` does not change the rate key. Tier u pins the Q9
numbers with mocked timers. Tier x (real Resend) exits 2 until the key and DNS
exist.

## Gates

New `tests/signin.test.ts`, `tests/names.test.ts`,
`tests/credentials-file.test.ts`, `tests/mailer.test.ts`.

## Delegated

Word lists, secret hash function, text layout.

## Placeholder contract

Resend arrives later: setting `RESEND_API_KEY` in Vercel switches delivery with
no code change.

## Feedback that would change it

Wanting an interactive code prompt as well; email wording.
