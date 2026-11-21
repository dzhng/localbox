# 20 hole-punch and transfer spike (go/no-go)

**Outcome 2026-11-21: go, with the throughput gate restated (agent's call, choice
20 in the ledger).** The first run failed the gate as written: over this Mac's LAN
address the transfer reached 40–61% of `iperf3` UDP. That baseline measured the
kernel through loopback, not a network. The gate now compares the transfer with
bare Network.framework datagrams on the same path (it reaches 95%) and requires at
least 1 Gbps, so a real gigabit or Wi-Fi link, not the transport, limits a copy.
Option 1 below was taken; slice 37 proceeds as written. The tier `x` run on a real
link confirms it.
Evidence: [20-punch.json](../evidence/20-punch.json).

- Tier `s` (loopback), all pass. An 8 GiB sparse file (2 GiB of data in 16 extents)
  arrives with the same sha256 and the same allocated size, at 1.5–2.7 Gbps over
  three runs. The receiver was SIGKILLed at 41.6%. The restart resumed 0.83 GiB from
  the bitmap (saved every 0.5 s), fetched the other 1.17 GiB, and the sha256 matched. One flipped ciphertext
  byte was refused by AEAD and one corrupted chunk by its sha256; both were fetched
  again. With a wrong key there is no reply within 3 s, and the sender authenticates
  nothing.
- Tier `l`: Cloudflare STUN answers in about 20 ms. This network's NAT maps
  endpoint-independently (the same port toward 3478 and toward 53). With a reflexive
  candidate offered, the local candidate wins and the sha256 matches.
- Throughput: three interleaved rounds per run, medians, on a shared Mac (load
  10–15). In the recorded run punchlab moved 2.37 Gbps of file data. `iperf3` UDP with
  1400-byte datagrams did 4.44 Gbps (punchlab = 53%), and `iperf3` TCP did 77.9 Gbps
  (3%). Bare Network.framework datagrams, open loop, peaked at 2.50 Gbps (punchlab =
  95%). The five runs gave 61, 56, 59, 40 and 53% of `iperf3` UDP; in the 40% run a
  neighbour also cut `iperf3` TCP to 16 Gbps.
- Why: Network.framework delivers each datagram through a callback. In side
  benchmarks of bare connected flows, two processes on this Mac topped out near
  260–280k datagrams/s (2.8–3.1 Gbps at 1400 bytes), whatever the number of flows. The kernel socket path `iperf3` uses does about
  380k. At steady state the protocol reaches that Network.framework ceiling (about
  280k datagrams/s). Ramp-up, the occasional loss episode and the neighbours bring the
  average down to 1.5–2.9 Gbps. The framing is not the bottleneck: AEAD, sha256 and disk run on other
  threads, and none of them is saturated.
- The LAN address routes through `lo0` here, so both baselines measure the kernel, not
  a wire. A real link up to 2.5 Gbps (gigabit Ethernet, Wi-Fi) would limit the copy
  before the transfer does. 10 GbE would not.
- Tier `x`: blocked (no second Mac on another network).
- Found on the way:
  - A live flow to the STUN server on the shared port stopped every later flow from
    that port. STUN flows are now cancelled after gathering.
  - On APFS, fsync blocks concurrent `pwrite` to the same file, which stalled the
    window. The bitmap is now saved without fsync and is only a hint: a resume
    re-hashes every chunk it claims.
  - An unpaced sender collapses Network.framework's receive rate. Pacing at a rate
    steered by the receiver's loss feedback avoids it.
- The options that were weighed (the stop rule names QUIC; the data points at the socket layer):
  1. **Accept the transport.** Restate the gate as "≥ 70% of a real LAN link", proved
     in tier `x`, or "≥ 70% of the Network.framework ceiling"; slice 37 proceeds as
     written. My read: this one, since every Mac's real LAN link is slower than this
     ceiling except 10 GbE.
  2. **Move only the data path to BSD sockets** (about 1.35× Network.framework here),
     keeping the framing, punching and resume as built.
  3. **QUIC with a pre-shared key on Network.framework** (the stop rule's fallback).
     Unmeasured; it shares the datagram path but may batch better inside it. Reslice
     37 around it.

**Unlocks:** Q4, Q5 and L6 as a transport: two Macs find each other through
Cloudflare's public STUN server, connect over UDP (local network first, then hole
punching), and move an 8 GiB sparse disk with chunking, resume and authentication.
Confirm item 6.

## Seam

- New executable target `localbox-punchlab` in `apps/macos/HostDaemon/Package.swift`,
  Network.framework UDP only. Commands: `punchlab offer` prints a JSON candidate
  set (local addresses plus the STUN-reflected address and port from
  `stun.cloudflare.com:3478`) and a one-time key; `punchlab answer <offer.json>`
  replies; both sides then punch, preferring local candidates.
- Transfer: fixed-size chunks with sha256 per chunk, a resume bitmap persisted
  beside the temp file, AEAD with the one-time key (CryptoKit ChaChaPoly), sparse
  holes sent as "zero chunk" markers.
- Candidate exchange is a pasted file; no Convex in this spike.
- Probe `20-punch-spike.ts`, tiers `s`, `l`, `x`.

## See it

- `npm run proof -- 20 --tier s,l`: two punchlab processes on this Mac over
  loopback and the LAN address: an 8 GiB sparse file transfers, the receiver is
  killed at ~40%, restarted, resumes from the bitmap, sha256 matches; a tampered
  chunk is rejected; throughput against an `iperf3` baseline on the same path.
- `npm run proof -- 20 --tier x`: the same between this Mac and a second Mac on
  another network. Exits 2 (`blocked: no second Mac on another network`) until the
  user runs it; report whether the punch succeeded and, if not, the NAT type each
  side's STUN responses suggest.

## Gates

Tier `s,l`: resume, integrity, tamper rejection, LAN throughput ≥ 70% of `iperf3`.
Tier `x` is advisory (P13).

## Stop rule

Resume, integrity or throughput failing reopens the transport choice (QUIC with a
pre-shared key instead of custom framing): record and reslice 37. A failed punch
alone is accepted; Q5 says the copy fails with why.

## Delegated

Chunk size, congestion and pacing, STUN retry budget, the "zero chunk" encoding.

## Feedback that would change it

The user wanting a fallback after seeing tier `x` fail (that is a new decision,
not a fix here).
