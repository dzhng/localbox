# Install Localbox

Use this when `localbox` is missing and the user asked for it, or to reinstall
over a copy that is broken. Localbox is a menu bar app, `Localbox.app`, with
the `localbox` CLI inside it. You install one signed GitHub release into
`~/Applications` and open it; the app sets up everything else, including this
skill and the `~/.local/bin/localbox` command, keeps both matched to itself at
every launch, and updates itself. Do not build from source, do not run
`npx skills add`, and do not copy the skill or the CLI anywhere yourself.

Nothing here needs a click, a password or the host's Node. Each block stands
alone (they share a download folder in your private `$TMPDIR`); run them in
order and stop at the first failure: a network, checksum or signature failure
is a blocker to report, not something to work around.

## 1. Check the Mac

`uname -m` must print `arm64` and `sw_vers -productVersion` must be 14 or newer.
Anything else (Intel, Linux, Docker) cannot run Localbox; say so and stop. Linux
sandboxes need nothing beyond arm64 and macOS 14; macOS sandboxes need macOS 27
or newer on the Mac, so tell the user if theirs is older.

## Prepare the Mac so sandboxes can hibernate

A sleeping sandbox hibernates: its memory is saved to disk, its RAM is freed,
and its processes resume on the next request. Updates and service restarts
hibernate running sandboxes the same way, so their processes survive. Apple's VM
framework encrypts the saved memory with a key from the logged-in user's
session, and refuses while that session is locked with a password. So:

- **Hibernation needs a logged-in session whose screen lock asks for no
  password.** A sleeping display or screen saver is fine (measured). Where the
  lock asks for a password and the screen is locked, a sleeping sandbox pauses
  in memory instead: its processes keep their state, but its RAM is not freed,
  and a sandbox put away to make room boots fresh at its next use.
- **A headless Mac (a Mac mini on a shelf) should be set up like a server:**
  System Settings > Users & Groups > automatic login on (so it comes back
  unlocked after a restart or power loss), and System Settings > Lock Screen >
  "Require password after screen saver begins or display is turned off" set to
  Never. The display may still sleep; only the password matters. No energy
  setting needs changing: Localbox keeps the Mac from idle-sleeping while a
  sandbox runs or an image builds or copies.
- These are the user's settings. Tell them what to change and why; do not change
  them yourself (they need the user's password).

After installing, `localbox host check` reports `hibernate` as `available`,
`only_while_unlocked` or `unknown`; anything but `available` lists the fixes.

## 2. Download the release

Take the three files from the latest release. The app fetches the built-in
linux image itself, after checking it against the same signed manifest.

```sh
set -eu
download="${TMPDIR:-/tmp}/localbox-install"
rm -rf "$download"; mkdir -p "$download"; cd "$download"
release="${LOCALBOX_RELEASE_URL:-https://github.com/dzhng/localbox/releases/latest/download}"
for name in release.json SHA256SUMS Localbox-macos-arm64.zip; do
  curl --fail --location --silent --show-error "$release/$name" -o "$name"
done
```

## 3. Verify it

`release.json` lists every file's SHA-256 and carries an Ed25519 signature. The
key that signs it is pinned here, in this procedure, and nowhere else you can
trust yet: never take a key from the download you are verifying. The check runs
in JavaScriptCore, which every Mac has, and verifies exactly the bytes the
release signed; it also requires `SHA256SUMS` to list exactly the signed
digests. `shasum` then checks the app against them.

```sh
set -eu
cd "${TMPDIR:-/tmp}/localbox-install"
cat > release-public.pem <<'EOF'
-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAMh6Vd0tBiVA5V/maXs8t3SPh6xPNjuPhJqeD3OeFAq8=
-----END PUBLIC KEY-----
EOF
cat > verify-release.js <<'EOF'
// release.json's Ed25519 signature (RFC 8032) over the manifest without its signature, as JSON.stringify writes it,
// checked against the pinned key; then SHA256SUMS must list exactly the signed artifacts.
const [manifestFile, sumsFile, keyFile] = arguments;
const fail = (why) => { throw new Error(`release check failed: ${why}`); };
const p = 2n ** 255n - 19n, L = 2n ** 252n + 27742317777372353535851937790883648493n;
const mod = (a, m = p) => ((a % m) + m) % m;
const pow = (b, e, m = p) => { let r = 1n; for (b = mod(b, m); e > 0n; e >>= 1n, b = b * b % m) if (e & 1n) r = r * b % m; return r; };
const inv = (a) => pow(a, p - 2n);
const D = mod(-121665n * inv(121666n)), SQRT_M1 = pow(2n, (p - 1n) / 4n);
const le = (bytes) => bytes.reduceRight((n, byte) => (n << 8n) | BigInt(byte), 0n);
const add = ([X1, Y1, Z1, T1], [X2, Y2, Z2, T2]) => {
  const A = mod((Y1 - X1) * (Y2 - X2)), B = mod((Y1 + X1) * (Y2 + X2)), C = mod(2n * D * T1 * T2), Z = mod(2n * Z1 * Z2);
  const E = B - A, F = Z - C, G = Z + C, H = B + A;
  return [mod(E * F), mod(G * H), mod(F * G), mod(E * H)];
};
const times = (n, P) => { let Q = [0n, 1n, 1n, 0n]; for (; n > 0n; n >>= 1n, P = add(P, P)) if (n & 1n) Q = add(Q, P); return Q; };
const encode = ([X, Y, Z]) => { const z = inv(Z), x = mod(X * z), y = mod(Y * z); return Array.from({ length: 32 }, (_, i) => Number(((y | ((x & 1n) << 255n)) >> BigInt(8 * i)) & 255n)); };
const point = (y, sign) => {
  if (y >= p) fail("bad point");
  const u = mod(y * y - 1n), v = mod(D * y * y + 1n);
  let x = mod(u * pow(v, 3n) * pow(u * pow(v, 7n), (p - 5n) / 8n));
  if (mod(v * x * x) !== u) { if (mod(v * x * x) !== mod(-u)) fail("bad point"); x = mod(x * SQRT_M1); }
  if (x === 0n && sign) fail("bad point");
  if ((x & 1n) !== sign) x = p - x;
  return [x, y, 1n, mod(x * y)];
};
const decode = (bytes) => point(le(bytes) & ((1n << 255n) - 1n), BigInt(bytes[31] >> 7));
const base64 = (text) => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/", out = [];
  let bits = 0, value = 0;
  for (const c of text.replace(/-/g, "+").replace(/_/g, "/").replace(/[=\s]/g, "")) {
    const index = alphabet.indexOf(c); if (index < 0) fail("bad base64");
    value = ((value << 6) | index) & 0xffff; bits += 6;
    if (bits >= 8) { bits -= 8; out.push((value >> bits) & 255); }
  }
  return out;
};
const sha512 = (bytes) => {
  // The constants are the fractional parts of the first primes' square and cube roots (FIPS 180-4), computed here.
  const M = (1n << 64n) - 1n, K = [], H = [], primes = [];
  for (let n = 2; primes.length < 80; n++) if (primes.every((q) => n % q)) primes.push(n);
  const root = (x, k) => { for (let r = 1n << BigInt(Math.ceil(x.toString(2).length / k)); ;) { const s = ((BigInt(k) - 1n) * r + x / r ** BigInt(k - 1)) / BigInt(k); if (s >= r) return r; r = s; } };
  primes.forEach((q, i) => { K.push(root(BigInt(q) << 192n, 3) & M); if (i < 8) H.push(root(BigInt(q) << 128n, 2) & M); });
  const data = [...bytes, 0x80]; while (data.length % 128 !== 112) data.push(0);
  for (let i = 15; i >= 0; i--) data.push(Number((BigInt(bytes.length) * 8n >> BigInt(8 * i)) & 255n));
  const rotr = (x, k) => ((x >> BigInt(k)) | (x << BigInt(64 - k))) & M;
  for (let at = 0; at < data.length; at += 128) {
    const w = [];
    for (let i = 0; i < 16; i++) w.push(data.slice(at + 8 * i, at + 8 * i + 8).reduce((n, byte) => (n << 8n) | BigInt(byte), 0n));
    for (let i = 16; i < 80; i++) w.push((w[i - 16] + (rotr(w[i - 15], 1) ^ rotr(w[i - 15], 8) ^ (w[i - 15] >> 7n)) + w[i - 7] + (rotr(w[i - 2], 19) ^ rotr(w[i - 2], 61) ^ (w[i - 2] >> 6n))) & M);
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 80; i++) {
      const t1 = (h + (rotr(e, 14) ^ rotr(e, 18) ^ rotr(e, 41)) + ((e & f) ^ (~e & M & g)) + K[i] + w[i]) & M;
      const t2 = ((rotr(a, 28) ^ rotr(a, 34) ^ rotr(a, 39)) + ((a & b) ^ (a & c) ^ (b & c))) & M;
      [a, b, c, d, e, f, g, h] = [(t1 + t2) & M, a, b, c, (d + t1) & M, e, f, g];
    }
    H.forEach((value, i) => { H[i] = (value + [a, b, c, d, e, f, g, h][i]) & M; });
  }
  return H.flatMap((value) => Array.from({ length: 8 }, (_, i) => Number((value >> BigInt(56 - 8 * i)) & 255n)));
};
const manifest = JSON.parse(readFile(manifestFile));
if (manifest.schema !== "agent-computer.release.v1" || manifest.signature?.algorithm !== "ed25519") fail("not a signed Localbox release manifest");
const der = base64(readFile(keyFile).replace(/-----[^-]+-----/g, ""));
if (der.length !== 44 || der.slice(0, 12).join() !== "48,42,48,5,6,3,43,101,112,3,33,0") fail("the pinned key is not an Ed25519 public key");
const key = der.slice(12), signature = base64(manifest.signature.value);
if (signature.length !== 64 || le(signature.slice(32)) >= L) fail("malformed signature");
const message = Array.from(unescape(encodeURIComponent(JSON.stringify({ ...manifest, signature: undefined }))), (c) => c.charCodeAt(0));
const h = mod(le(sha512([...signature.slice(0, 32), ...key, ...message])), L);
const [x, y, z, t] = decode(key), B = point(mod(4n * inv(5n)), 0n);
if (encode(add(times(le(signature.slice(32)), B), times(h, [mod(-x), y, z, mod(-t)]))).join() !== signature.slice(0, 32).join()) fail("release.json is not signed by the pinned Localbox key");
if (readFile(sumsFile) !== manifest.artifacts.map((artifact) => `${artifact.sha256}  ${artifact.name}\n`).join("")) fail("SHA256SUMS does not list exactly the signed artifacts");
print(`Localbox ${manifest.version}: release.json is signed by the pinned key`);
EOF
/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc verify-release.js -- release.json SHA256SUMS release-public.pem
grep ' Localbox-macos-arm64.zip$' SHA256SUMS | shasum -a 256 -c -
```

The check prints `Localbox VERSION: release.json is signed by the pinned key`;
anything else (an exception, or `FAILED` from `shasum`) means stop.

## 4. Put the app in place

Unpack it, then replace any installed copy, keeping the old one as a backup.
Quitting the old copy hibernates its running sandboxes and can take a while; the
loop waits for it. A quarantined app would be held by a Gatekeeper dialog that
nobody can click, and every later launch would hang, so the block stops if the
download carries quarantine. Never remove that attribute; report it.

```sh
set -eu
cd "${TMPDIR:-/tmp}/localbox-install"
ditto -x -k Localbox-macos-arm64.zip unpacked
if xattr -r unpacked/Localbox.app | grep -q com.apple.quarantine; then
  echo "the downloaded app is quarantined; Localbox cannot open it without a click. Stopping." >&2
  exit 1
fi
app="$HOME/Applications/Localbox.app"
if [ ! -e "$app" ] && [ -d /Applications/Localbox.app ] && [ -w /Applications ]; then app=/Applications/Localbox.app; fi
if [ -e "$app" ] || [ -L "$app" ]; then
  if [ "$(osascript -e 'application id "sh.localbox.mac" is running')" = true ]; then
    osascript -e 'quit app id "sh.localbox.mac"'
    while [ "$(osascript -e 'application id "sh.localbox.mac" is running')" = true ]; do sleep 1; done
  fi
  backup=$(mktemp -d)
  mv "$app" "$backup/"
  echo "previous app kept at $backup/Localbox.app"
fi
mkdir -p "$(dirname "$app")"
ditto unpacked/Localbox.app "$app"
```

Use `/Applications` only when a copy is already there and writable; anywhere
else, `~/Applications`, which needs no administrator.

## 5. Open it

This works from SSH too: it opens the app in the user's session without taking
focus.

```sh
app="$HOME/Applications/Localbox.app"
[ -d "$app" ] || app=/Applications/Localbox.app
/bin/launchctl asuser "$(id -u)" /usr/bin/open -g "$app"
```

## 6. Check it

At its first launch the app installs this skill for every agent harness on the
Mac, writes `~/.local/bin/localbox`, and adds `~/.local/bin` to the login
shell's PATH. Wait for the command, then check:

```sh
for second in $(seq 60); do [ -x "$HOME/.local/bin/localbox" ] && break; sleep 1; done
~/.local/bin/localbox app status --json    # the version, daemon and connector running, the login item
~/.local/bin/localbox cli status           # state: installed
~/.local/bin/localbox skill status         # state: installed, managed: true, source_revision: the version
~/.local/bin/localbox host check           # hibernate: available, or the settings to change
```

Call the command by its full path until a new shell has it on PATH. Anything
unexpected in `skill status` means read the [skill lifecycle](skill-lifecycle.md).
Once these pass, remove the download: `rm -rf "${TMPDIR:-/tmp}/localbox-install"`.

## 7. Tell the user

Report a short checklist: the version, the skill's state, the command, signed in
or not, and whether sandboxes can hibernate here (with the settings to change if
not). Then:

- **Localbox runs in the menu bar and opens at login.** Its popover shows this
  Mac's sandboxes and images, the connection and any warning; Settings has
  sign-in, agent setup, open at login and updates. `app status` shows
  `login_item`; if it is `requires_approval`, ask the user to allow Localbox in
  System Settings > General > Login Items. To turn it off:
  `localbox app login-item off`.
- **Quitting Localbox takes this Mac offline** until it opens again; any
  `localbox` command opens it again by itself.
- **It updates itself** from signed releases; `localbox update status` shows
  the updater ([skill lifecycle](skill-lifecycle.md#updates)).
- Sign in with `localbox login --email` when the user wants sandboxes, and
  start a fresh agent session so the installed skill is loaded.

## Removing Localbox

Only when the user asks. `logout` removes this Mac from their account; skip it
to keep the account's record of this Mac.

```sh
~/.local/bin/localbox logout               # optional: this Mac leaves the account
~/.local/bin/localbox agents setup off     # Localbox stops maintaining the skill and the command, and removes its PATH block
~/.local/bin/localbox skill uninstall      # removes the skill from every agent harness
~/.local/bin/localbox app login-item off
osascript -e 'quit app id "sh.localbox.mac"'   # hibernates running sandboxes, then quits
rm -rf "$HOME/Applications/Localbox.app" ~/.local/bin/localbox
```

Run the `localbox` commands before quitting: each would open the app again.
Sandboxes and images stay in `~/Library/Application Support/Localbox` until
the user deletes that folder. To leave nothing behind, also remove the logs,
caches and settings:

```sh
rm -rf ~/Library/Logs/Localbox ~/Library/Caches/sh.localbox.mac ~/Library/HTTPStorages/sh.localbox.mac
defaults delete sh.localbox.mac
```
