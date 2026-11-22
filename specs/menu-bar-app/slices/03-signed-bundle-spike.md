# 03 · Spike: the whole runtime signed in one bundle

No dependencies. Throwaway assembler under `specs/menu-bar-app/spikes/03/`.

## Question

Does a bundle with the final layout (README, "Contracts") sign inside-out with
a self-signed identity and still work: the CLI's Node keeps its JIT, the daemon
keeps its entitlement, and the guest agent binaries keep their exact bytes?

## Probe

Assemble the layout from today's build outputs (`npm run build`,
`npm run build:guest-agent`, `swift build -c release`) with a stub main
executable. Sign in Bento's order (`scripts/release-signing.mjs` there): every
Mach-O first, then the bundle, `--force --sign <scratch identity>
--timestamp=none`, no `--deep`. Only `localbox-hostd` gets
`localbox-hostd.entitlements`. The launcher and `node` get identifier
`sh.localbox.cli`. Files under `Resources/guest-agent/` are sealed as
resources and never re-signed.

## Checks

1. `codesign --verify --deep --strict` passes on the bundle.
2. The SHA-256 of every file under `Resources/guest-agent/` still equals the
   digest in `agent-version.json` (the darwin agent and helpers are Mach-O; the
   signer must exempt them).
3. The bundled `node` runs `localbox help --json` and a JIT-heavy loop (a few
   million iterations of numeric work) without a code-signing kill.
4. `localbox-hostd` run from inside the bundle boots a VM (tier `v`).
5. Record bundle size, file count and signing wall time.
6. A `ditto -c -k` then `ditto -x -k` round trip still verifies, and the copy
   works from a different directory.

## Verdict

**Go:** checks 1–4 and 6 pass.

**Decision this spike makes (delegated, by this rule):** the CLI ships as the
`dist/` tree plus `node_modules/` unless check 5 shows signing takes over 60 s
or verification is flaky on the tree; then it ships as a single bundled file
(Bento's `node-bundle.mjs` approach) with the `skills` installer kept as a
tree.

**Fallback:** if `codesign` rejects nested guest binaries, ship
`guest-agent/` as one archive resource that the daemon unpacks into the machine
root at start. Record it; slices 06 and 10 inherit it.

## What the human can see

`spikes.md` section "03" with the six checks and the size, count and time.

## Delegated to the implementer

The assembler's language; whether `localbox-hostd` sits in `MacOS/` or
`Helpers/` if one of them signs more cleanly (then update the README's layout).

## Must stay green

Nothing in the product changes.

## Feedback that would change this slice

The user choosing Developer ID after all: then hardened runtime and the JIT
entitlement for `node` join the checks.
