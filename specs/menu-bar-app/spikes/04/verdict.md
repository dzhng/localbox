# 04 · Built-in image fetch: verdict

**Go.** The image can be fetched after install with `Range` resume, verified
and installed with `verifyManifestSignature`, `expandImage` and
`installLinuxImage` as they are. One change for slice 11: stage under
`<root>/downloads/`, not `<images>/.linux.fetch/`.

Evidence is in `specs/menu-bar-app/evidence/04/`. All keys were scratch
Ed25519 pairs made in a temp directory; all temp directories were removed.

## The four outcomes

| Outcome | Result | Evidence |
| --- | --- | --- |
| An interrupted fetch resumes without re-downloading finished parts | Met | `fixture-run.log`, "resume across a quit" |
| A truncated or tampered part, or a bad signature, fails closed with nothing written to `images/linux` | Met | `fixture-run.log`, ten scenarios |
| Peak disk is at most the parts plus the expanded image | Met, with a 1.35% transient | `real-image-run.log` |
| The real leg resumes | Met | `github-range.log` |

**Resume.** The server reset the connection at 40% of the second of four
parts and the fetcher exited 2. A second process hashed and kept part 0
without requesting it, asked for part 1 with `Range: bytes=838860-` (exactly
the partial's length), got 206, and finished. Bytes served for image artifacts
over both runs equalled their total, 6293854. The same cut retried inside one
process also passes. A reset can lose bytes the server had already written
(earlier runs, whose logs were overwritten, lost 3,432 and 31,323 bytes; the
kept logs lost none), so the resume offset must come from the file on disk.

**Fails closed.** Each case exits 1 with a `failed` line, never reaches
`expanding`, and leaves `images/linux` absent, or byte-identical when an older
image was seeded:

- truncated part (the server honestly has half): refused on the length, before a byte is written;
- one flipped byte: `checksum mismatch` on the part, and the bad part is deleted;
- manifest signed by another key, edited after signing, or unsigned: refused
  with only `/release.json` requested.

After the flipped byte, a clean server finishes the job re-downloading only
that part.

**Peak disk.** For the real dev image, staging peaked at 1,264,885,760 bytes:
the part (344,965,120) plus the expanded image as `expandImage` wrote it
(919,650,304) plus the two small files. The installed image is 903,024,640, so
the peak is 16.9 MB (1.35%) above "parts + installed image". There is no third
copy: `installLinuxImage` clones, and the volume's free space fell by about the
same figure. Budget parts + expanded + 2%.

**Real leg.** `dzhng/localbox` has a published release, v0.1.1, with a
1,111,714,389-byte asset `localbox-template-0.1.1.img.zst.000`. A 48 MiB
window from its middle, through `releases/download/...`:

- 302 to `release-assets.githubusercontent.com`;
- Node's `fetch` followed it with `Range` intact: 206,
  `content-range: bytes 555857194-606188841/1111714389`;
- cut by the client at 20,142,358 bytes, resumed from byte 575999552: 206 with
  the matching `content-range`;
- the stitched window's SHA-256 equals the same window fetched in one piece by
  `curl -L -r`.

The fallback (restart the interrupted part) is not needed.

## Time and disk, real dev image

`dist/vm-image/images/linux`: 8.10 GiB disk, 0.84 GiB allocated. Two runs;
`real-image-run.log` holds the second, which overwrote the first's log.

| Step | Measured |
| --- | --- |
| `packImage` at its defaults (release side) | 61.8 s, 69.9 s |
| Packed size | 344,961,508 bytes, one part |
| Download | loopback only, 0.24 s; not a network figure |
| `expandImage` | 8.5 s, 9.0 s |
| `installLinuxImage` | 54 ms, 89 ms |
| Peak disk | 1.18 GiB |

Full-size download time over the network was **not measured**. The 48 MiB
window ran at 13 to 34 MiB/s from GitHub on this connection, which would put
the dev image's 345 MB at roughly 10 to 25 s and v0.1.1's 1.11 GB part at
roughly 30 to 80 s; that is an extrapolation.

## Would `ImageStore`'s start-time sweep delete `<images>/.linux.fetch/<version>/`?

**Yes**, on every daemon start, unless a running host operation's subject is
`linux`. `apps/macos/HostDaemon/Sources/localbox-hostd/main.swift:26`:

```swift
for name in images.sweepTemps(keeping: await operations.runningSubjects()) { log("removed \(name), an image write or delete the last run left unfinished") }
```

`ImageStore.swift:225-239`:

```swift
@discardableResult public func sweepTemps(keeping running: Set<String> = []) -> [String] {
    let swept = temps().filter { $0 != ipswDirectory.lastPathComponent && !Self.temp($0, belongsTo: running) }
    for name in swept { try? FileManager.default.removeItem(at: root.appendingPathComponent(name)) }
    return swept
}

private func temps() -> [String] {
    ((try? FileManager.default.contentsOfDirectory(atPath: root.path)) ?? []).filter { $0.hasPrefix(".") && $0 != ".DS_Store" }.sorted()
}

private static func temp(_ name: String, belongsTo images: Set<String>) -> Bool {
    let parts = name.dropFirst().split(separator: ".", maxSplits: 1)
    return parts.count == 2 && images.contains(String(parts[0]))
}
```

`.linux.fetch` is a dot-entry and is not `.ipsw`, so it is a temp. It parses as
subject `linux`, and is spared only while `runningSubjects()` contains `linux`.
The CLI's fetch is not a host operation (README A6), so nothing keeps it. An
app relaunch starts the daemon, which would delete the partial download just
before `ensure` tried to resume it.

## What changes slice 11

1. **Stage under `<root>/downloads/<version>/`**, the slice's own fallback. Keep
   it on the images volume: `installLinuxImage` falls back to a plain `cp` when
   it cannot clone.
2. **The published v0.1.1 manifest is the older shape**: a `template` entry and
   `localbox-template-*.img.zst.000`, with no `image` entry, boot store or
   `image.json` artifact. The fetcher needs a release cut with `packImage`
   (slice 10) before its manual run against a real release can happen.
3. **`verifyRelease` cannot check the staging directory**: it hashes every
   artifact, including the app zip the fetcher never downloads, and
   `checkManifest` is not exported. The fetcher validates artifact names
   (basename only) and hashes parts itself.
4. **`expandImage` reports no progress.** The spike polled the length of its
   private temporary (`images/.linux.partial-<pid>/disk.img`), which gave 20
   lines over 9 s. Slice 11 either accepts that coupling, shows `expanding`
   without bytes, or adds a callback to `expandImage`.
5. **Clear `<staging>/images/` at start.** `expandImage`'s temporary is named
   after its pid, so one left by a crash is never reused or removed.
6. **`installLinuxImage`'s `.linux.installing-<pid>` sits in the images
   directory** and is swept by a daemon start that lands in its 54 to 89 ms
   window. The install would fail and the supervisor's retry covers it.
7. **Two failure kinds**, which the spike exits 2 and 1 for: interrupted (keep
   the partial, retry) and refused (delete that part; retrying without a new
   release will not help a bad signature).

Not probed: step 3 of the slice (skip when the installed `image.json` digest
already matches), and the lock for a second `ensure`.

## Rerun

```
node_modules/.bin/tsx specs/menu-bar-app/spikes/04/run-fixture.ts
node_modules/.bin/tsx specs/menu-bar-app/spikes/04/run-real-image.ts
node_modules/.bin/tsx specs/menu-bar-app/spikes/04/run-github-range.ts <asset url> <asset size>
```
