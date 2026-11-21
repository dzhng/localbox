# Sandbox images: choices ledger

Decisions made where the spec was silent, appended per pass. Verdicts: **sound**,
**provisional** (revisit at the named slice), **user** (needs the user's call;
the recorded provisional call stands meanwhile).

- **15 — GRUB, not systemd-boot, with a fixed config reading the kernel symlinks.**
  Sound. GRUB reads the kernel from the ext4 root, so a kernel install only has to
  repoint `/boot/vmlinuz` (which Ubuntu's kernel packages already do); systemd-boot
  would need every kernel copied onto the EFI partition by kernel-install hooks.
  Alternative: systemd-boot with kernel-install.
- **15 — `update-grub` is replaced by `true` in the image.** Sound. grub-mkconfig
  would overwrite the fixed config with device-specific entries; nothing in the
  image needs it. Alternative: let it run and depend on its device detection in a VM.
- **15 — the kernel-upgrade test installs the HWE kernel.** Sound. The image already
  has the newest GA kernel, so "a newer kernel" is only reliably available as the
  HWE series; it proves the same thing (a different version boots). Alternative:
  pin the image to an older GA kernel.
- **15 — `AppleVirtualizationBackend` takes an optional configuration closure.**
  Provisional — slice 23 replaces it with `VMSpec`. It let vmlab boot an EFI
  configuration through the real backend (channel, save, restore) without copying
  the backend. Alternative: a parallel lab-only backend.
- **20 — the throughput gate's denominator is `iperf3` UDP with 1400-byte datagrams on
  the same path; `iperf3` TCP is recorded, not gated.** User — the gate failed against
  both. Loopback TCP (60–100 Gbps) is memory copies with segmentation offload; no
  datagram transport can approach it, so it doesn't separate one transport from another.
  Alternative: gate on TCP, which fails every UDP design by 30×.
- **20 — `iperf3` installed with Homebrew for the baseline.** Sound. The slice names it,
  and it was missing on this Mac. The probe reports `blocked:` without it.
  Alternative: a home-made TCP blast.
- **20 — one AEAD seal per datagram; the clear 12-byte header is the nonce.** Sound.
  The slice says "nonce per chunk", but sealing whole chunks would turn one lost or
  tampered datagram into a refetch of 1 MiB. The header (process session, kind,
  stream, chunk, fragment or sequence) is the ChaChaPoly nonce, so it is authenticated
  without being sent twice. A retransmission repeats a nonce only with byte-identical
  plaintext. Alternative: seal 1 MiB chunks and fragment the ciphertext.
- **20 — 1 MiB chunks, 1400-byte datagrams (1372 bytes of payload).** Provisional —
  revisit in 37 if tier `x` shows fragmentation. 1400 fits an Ethernet MTU with room
  for a tunnel header. Alternative: 1200 for any IPv6 path, or 1472 for LAN-only paths.
- **20 — the receiver drives everything.** Sound. The sender answers HELLO with the
  manifest digest and sends exactly the fragment ranges each REQUEST names, in order.
  Loss detection (per lane: 256 behind the newest arrival, or a timeout), retransmission,
  resume and verification all live in the receiver, so the sender holds no per-receiver
  state and a restarted receiver simply asks again. Alternative: sender-side ACK
  windows like TCP.
- **20 — pacing: the sender's rate grows 25% per 20 ms epoch until the first loss, then
  10%, only while the receiver keeps up; loss above 1% cuts it by 15%. The receiver's
  window is twice delivery rate × unqueued round trip (at least 2 ms).** Provisional —
  delegated congestion control; revisit on tier `x`. A 40 ms window built a deep queue
  in the sender's Network.framework output, and that queue overflowed into loss.
  Alternative: fixed rate, or BBR.
- **20 — two flows (local ports) on a local path, one on a punched path.** Provisional.
  Two flows cut loss somewhat; the ceiling is Network.framework's per process pair, not
  per flow. Each extra port on a punched path would need its own NAT mapping.
  Alternative: one flow everywhere (simpler, a little more loss).
- **20 — zero chunks.** Sound. They are found with SEEK_DATA plus a word-wise all-zero
  check, listed in `zeroChunks` with an empty hash, and never sent. The receiver
  `ftruncate`s each file to full size, so they stay holes. Alternative: send a marker
  datagram per zero chunk.
- **20 — the resume bitmap is a hint saved without fsync; a resume re-hashes what it
  claims.** Sound. On APFS, fsync blocks concurrent `pwrite` to the same file, and a
  periodic fsync stalled the whole window. Re-hashing also survives power loss and torn
  writes. It costs one read of the already-received data on resume. Alternative: fsync
  before every bitmap save.
- **20 — candidate exchange via files.** Sound. The sender writes `offer.json`
  atomically (with the key) and polls for `answer.json`; a new answer id (a restarted
  receiver) makes it punch again. It idles out after 60 s with nothing authenticated.
  Alternative: stdin/stdout paste.
- **20 — STUN: binding requests to `stun.cloudflare.com` on 3478 and 53 from the
  transfer's own port, retried every 400 ms within 2.5 s. The flows are cancelled
  afterwards.** Sound. The second destination tells endpoint-independent from
  symmetric mapping for tier `x`'s NAT report. A live STUN flow on the shared port
  blocked later flows from it. Alternative: one STUN request, no NAT classification.
- **20 — IPv4 only.** Provisional — revisit if tier `x` meets an IPv6-only network.
  Mixed-family candidates double the punch matrix, for no gain on the networks that
  can be tested here. Alternative: IPv6 candidates alongside.
- **20 — probe tiers: `s` = loopback (transfer, kill at 40% and resume, tamper, wrong
  key); `l` = LAN address (STUN, local candidate wins, three interleaved throughput
  rounds against `iperf3` and a bare Network.framework blast); `x` = blocked.** Sound.
  The source is 8 GiB with 2 GiB of random data in 16 extents, cached under
  `.localbox/proof/punch`. The committed evidence redacts public IPv4 addresses.
  Alternative: one tier for both paths.
