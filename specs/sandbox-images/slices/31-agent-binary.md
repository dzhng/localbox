# 31 Single-binary guest agent

**Unlocks:** L4's first half. The guest agent ships as one self-contained
executable per OS, so no image depends on its own Node.

## Seam

- `apps/guest-agent` build (new script `scripts/build-guest-agent.ts`) emits
  `dist/guest-agent/localbox-agent-linux-arm64`,
  `dist/guest-agent/localbox-agent-darwin-arm64` and `agent-version.json`
  (`{ version, sha256: { linux, darwin } }`). The version is the release version
  plus the binary digest, so any change is a new version.
- The host app bundle carries both binaries under `Contents/Resources/guest-agent/`;
  the host is the authority on the current agent.
- `Dockerfile.arm64`'s unit (`:131`) runs `/usr/local/localbox/localbox-agent`
  instead of `/usr/bin/node /opt/localbox/dist/...`; `/opt/localbox/dist` is no
  longer copied. Node stays installed in the full image as a user tool, not a
  dependency.
- The darwin binary builds and starts under the process fixture but has no darwin
  handlers until slice 33.

## See it

`npm run build:guest-agent`, then run the linux binary under the process-fixture
backend (stdin/stdout mode, `apps/guest-agent/README.md`) and send a `system.info`.

## Gates

- Tier `u`: `tests/agent-binary.test.ts` drives the built linux binary through the
  fixture (`shell.exec`, `fs.read`, `job.wait`).
- Tier `v`: probe 10 boots an image whose unit runs the binary.

## Delegated

The packager (Node single executable application or `bun build --compile`), as long
as the output runs on a clean Ubuntu 24.04 arm64 and macOS 27 with no runtime
installed.

## Stays green

`tests/guest-agent-persistent.test.ts`, `tests/guest-service.test.ts`,
`tests/vm-image-guest-protocol.test.ts`.
