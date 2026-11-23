# GitHub Actions runners

The user's Macs can run their GitHub Actions jobs as self-hosted runners, each
inside a sandbox, so a workflow never touches the real Mac. A runner is GitHub's
`actions-runner` program running as a Localbox job in a sandbox: Linux arm64 in
a Linux sandbox, macOS (Xcode builds, iOS tests) in a macOS one. The GitHub side
is GitHub's documented self-hosted runner flow; Localbox supplies the sandbox.

Read the limits at the end before offering this, and tell the user the ones
that apply to their workflows.

## 1. A registration token

Registering a runner needs a token from GitHub, valid for an hour. With `gh`
installed and signed in on the user's Mac (`gh auth status`), get one yourself:

```sh
gh api -X POST repos/OWNER/REPO/actions/runners/registration-token --jq .token
```

(For every repository in an organisation the user owns, `orgs/ORG/...` instead
of `repos/OWNER/REPO/...`, and the organisation's URL below.) Without `gh`, ask
the user to open the repository's Settings › Actions › Runners › New
self-hosted runner and copy the token from the `config.sh` line it shows. Never
write a token into an image or a file you keep.

## 2. A runner image, once

Set up a sandbox with the runner installed but not registered, and save it, so
every runner starts from it. Linux:

```sh
localbox sandbox create --name runner-setup
```

Look up the latest runner version, `V` below (no `v`):
`gh api repos/actions/runner/releases/latest --jq .tag_name`, or read
https://github.com/actions/runner/releases/latest. Then, in the sandbox
(`localbox shell exec --sandbox runner-setup --background -- sh -c '...'`, then
`localbox job wait`; downloads and `apt` take minutes):

```sh
mkdir -p /opt/actions-runner && cd /opt/actions-runner
curl -fsSLO https://github.com/actions/runner/releases/download/vV/actions-runner-linux-arm64-V.tar.gz
sha256sum actions-runner-linux-arm64-V.tar.gz   # compare with the SHA-256 in the release notes
tar xzf actions-runner-linux-arm64-V.tar.gz && rm actions-runner-linux-arm64-V.tar.gz
apt-get update && ./bin/installdependencies.sh
apt-get install -y sudo                          # many workflows call sudo
```

The built-in `linux` image has no Docker. If the user's workflows use
container jobs, service containers or `docker` steps, add it:
`apt-get install -y docker.io && systemctl enable --now docker`. Add any other
toolchain their workflows expect rather than installing it in every job.

For macOS, start from the account's macOS base (`--image macos`) or an image
with Xcode already in it ([images](images.md#xcode-in-a-macos-sandbox)), take
`actions-runner-osx-arm64-V.tar.gz` instead, check it with
`shasum -a 256`, and skip `installdependencies.sh` and `apt`.

Save it, then delete the setup sandbox with the user's go-ahead:

```sh
localbox image create --from runner-setup --name actions-runner
localbox sandbox delete runner-setup --confirm runner-setup
```

## 3. A runner sandbox

Create one sandbox per runner from the image. A running runner keeps its
sandbox awake by itself; a long `--sleep-after` keeps it up while the runner is
restarted or reconnects. By default a sandbox is sized to the whole Mac; give a
runner less if the user works on that Mac too (the sizes below are an example).

```sh
localbox sandbox create --image actions-runner --sleep-after 30d --cpus 4 --memory 8G
```

Use the name it reports, `NAME` below, as the runner's name. Register it
(Localbox shell commands run as root, and the runner refuses root unless told
otherwise; the sandbox is the boundary):

```sh
localbox shell exec --sandbox NAME --cwd /opt/actions-runner -- env RUNNER_ALLOW_RUNASROOT=1 ./config.sh --unattended --url https://github.com/OWNER/REPO --token TOKEN --name NAME --labels localbox
```

GitHub adds `self-hosted`, the OS (`Linux` or `macOS`) and `ARM64` itself, so
`localbox` is the only label to give. Then run it as a Localbox job, which is
what keeps the sandbox from sleeping under it:

```sh
localbox shell exec --sandbox NAME --background --cwd /opt/actions-runner -- env RUNNER_ALLOW_RUNASROOT=1 ./run.sh
```

Note the `job_id`. Never save a registered runner sandbox as an image: every
sandbox made from it would claim the same registration.

## 4. Check it

- GitHub lists it as Idle (or Active, running a job) under Settings › Actions ›
  Runners, or:
  `gh api repos/OWNER/REPO/actions/runners --jq '.runners[] | {name, status, busy}'`.
- `localbox job status JOB_ID --sandbox NAME` says `running`;
  `localbox job output JOB_ID --sandbox NAME` shows `Listening for Jobs` and
  each job it takes.
- `unknown job` means the sandbox booted fresh (its last result reported
  `cold_booted`) and the runner is gone: start `run.sh` again as above. The
  registration is on the sandbox's disk and needs no new token.

## 5. What workflows say

```yaml
runs-on: [self-hosted, localbox, linux, arm64]   # or [self-hosted, localbox, macos, arm64]
```

Changing a workflow is the user's call: show them the line, and say which jobs
would move.

## 6. Stop and remove

Stop the job, unregister with a removal token, then delete the sandbox with the
user's go-ahead:

```sh
localbox job cancel JOB_ID --sandbox NAME
gh api -X POST repos/OWNER/REPO/actions/runners/remove-token --jq .token
localbox shell exec --sandbox NAME --cwd /opt/actions-runner -- env RUNNER_ALLOW_RUNASROOT=1 ./config.sh remove --token REMOVAL_TOKEN
localbox sandbox delete NAME --confirm NAME
```

Without `gh`, the user removes it under Settings › Actions › Runners. A runner
whose sandbox is already gone shows offline there until removed.

## Limits

- **Linux is arm64 only.** Actions and container images published only for
  amd64 (x86_64) fail; GitHub's hosted `ubuntu-latest` tools are not there
  unless the image installs them.
- **Jobs run as root**, like every Localbox shell command. Homebrew refuses
  root, so `brew` steps in a macOS workflow fail.
- **One job at a time per runner.** More parallel jobs need more runner
  sandboxes, each registered as above.
- **State persists between jobs.** The runner's work folder, installs and
  anything a job leaves behind are there for the next job. Use it for the
  user's private repositories; never for a public repository's pull requests
  from forks, where anyone's code would run in it.
- **macOS: at most two sandboxes per Mac** (Apple's licence), and a runner holds
  one for as long as it runs. macOS runners are for the user's own repositories
  and work only.
- **The Mac must be on, with Localbox running.** Its jobs wait in GitHub's
  queue otherwise. The Mac does not idle-sleep while the sandbox runs; closing
  the lid or choosing Sleep still sleeps it, and the runner carries on when it
  wakes, and through Localbox updating itself. Across a restart it keeps
  running only where `localbox host check` reports `hibernate` as `available`
  ([why](installation.md#prepare-the-mac-so-sandboxes-can-hibernate));
  otherwise the sandbox boots fresh and `run.sh` needs starting again.
- GitHub removes a self-hosted runner that has not connected for 14 days.
