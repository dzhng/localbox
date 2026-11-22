# 04 · Spike: built-in image fetch

No dependencies. Throwaway code under `specs/menu-bar-app/spikes/04/`.

## Question

Can the roughly 2 GB built-in Linux image be fetched after install with resume,
verified, and installed with the code that exists, and what does it cost in
time and disk?

## Probe

A local HTTP server with fault injection, serving the output of `packImage`
(`scripts/release.ts`) for a small fixture image and for the real dev image:
drop the connection at 40%, serve a truncated part, flip one byte in a part.

A fetcher script that:

1. reads `release.json` and runs `verifyManifestSignature` against a pinned
   public key (a scratch key pair here);
2. downloads each part with an HTTP `Range` request, resuming a partial file,
   and checks its SHA-256 against the manifest's `artifacts`;
3. runs `expandImage`, then `installLinuxImage`;
4. prints `{ "phase": "downloading"|"expanding"|"installing"|"ready",
   "done_bytes": n, "total_bytes": n }` as JSON lines.

**Real leg:** one run against an actual GitHub release asset of
`dzhng/localbox`, cut and resumed once, to confirm `Range` survives GitHub's
redirect to its asset host.

## Verdict

**Go:**

- an interrupted fetch resumes without re-downloading finished parts;
- a truncated or tampered part, or a bad signature, fails closed with nothing
  written to `images/linux`;
- peak disk is at most the parts plus the expanded image;
- the real leg resumes.

**Fallback:** no `Range` through the redirect: restart the interrupted part
only. Parts are capped under 2 GiB, so the worst case is one part. Record it.

## What the human can see

`spikes.md` section "04": the four outcomes, time and peak disk for the real
image, and a note on whether the staging directory survives
`ImageStore`'s temp sweep at daemon start (read `ImageStore.swift`; slice 11
needs the answer).

## Delegated to the implementer

The fault server; chunk size; whether progress is per part or per byte.

## Must stay green

Nothing in the product changes. `tests/release.test.ts` is untouched.

## Feedback that would change this slice

The user wanting the image inside the app after all (brief, decision 2 says
no): this spike would be dropped.
