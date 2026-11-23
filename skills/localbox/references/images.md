# Images

An image is a sandbox's disk (and its boot settings) saved under a name, never its
memory: a sandbox made from one cold boots with the files and installs it had, and
gets its own machine identity, SSH host keys and network address. Images belong
to the account; `localbox image list` shows every image, its OS, size, disk size,
where it came from, the Macs holding it and which one is the default.

An image's disk size is the least every sandbox made from it gets: `sandbox
create --image IMAGE` gives that size, `--disk` more, and less is refused. A
saved image keeps its sandbox's disk size, so one saved from a grown sandbox
starts every new sandbox at least that large; `--disk` on `image create` raises
it further (never below the sandbox's).

Every `image` command reports what it did and the next command. Long work (a macOS
build, a copy) answers at once with a state (`building`, `copying`, `ready`,
`failed`) and its progress: follow it with `localbox image wait IMAGE`, which
returns within two minutes, and call it again until `ready` or `failed`.

## Save a setup

Set a sandbox up, then save it:

```sh
localbox image create --from NAME --name IMAGE
localbox sandbox create --image IMAGE
```

The sandbox keeps running; it pauses for about a second while its disk is cloned,
and the result says how long. A sleeping sandbox is woken first; a stopped one is
cloned as it is. Without `--name` the image gets a generated name. Before saving,
remove what shouldn't travel to every sandbox made from it: tokens, signed-in
browser sessions, the user's Apple ID.

`localbox image default IMAGE` makes it what `sandbox create` uses with no
`--image`. The built-in `linux` image is on every Mac, is updated with each
release, and can't be renamed or deleted. `macos` is reserved: it names the
account's most recent macOS base.

## Copies between Macs

A sandbox created on a Mac without its image copies the image there first. With
`--placement auto` Localbox prefers a Mac that already holds the image and has
room; a named `--machine` (or this Mac) always gets the copy. To copy ahead of
time:

```sh
localbox image copy IMAGE MACHINE
localbox image wait IMAGE
```

The copy goes directly from one of the user's Macs to the other: over the local
network when they share one, else a direct connection across the internet. It
resumes after a restart. The finished copy reports its size, duration and which
path it took. `copy_unreachable` lists every path tried; the usual fix is to put
both Macs on the same network once and copy again. Tell the user; don't retry in
a loop.

## Delete and rename

`localbox image rename IMAGE NAME` renames. `localbox image delete IMAGE
--confirm IMAGE` removes it from every Mac holding it, or with `--machine MACHINE`
only from that Mac. It never affects sandboxes made from it. Deleting the default
resets the default to `linux`, and the result says so. Delete only with the
user's go-ahead.

## macOS sandboxes

A macOS sandbox has every operation a Linux one has, desktop and browser
included, with Chrome installed. It needs a Mac running macOS 27 or newer, and a
macOS image runs only on Macs with the same major macOS as the one inside it, or
newer (`image_incompatible` names the Mac's version otherwise).

The account has no macOS base until one is built:

```sh
localbox image create --macos        # on this Mac, or add --machine MACHINE
localbox image wait IMAGE            # the name the create printed; repeat until ready
localbox sandbox create --image macos
```

The build downloads Apple's restore image and installs macOS on the Mac itself,
with no human step. Its disk is 50 GB unless `--disk` asks for more (macOS,
Chrome and the agent take about 30 GB of it); that is every macOS sandbox's
minimum, and a sandbox can still grow past it with its own `--disk`. The build
needs its whole disk size free plus whatever of the restore image is not yet
downloaded (it refuses with `disk_full` up front if not) and takes a while; tell
the user, then keep calling `image wait`.

Apple's licence allows at most two macOS VMs running at once per Mac, and a
macOS base build running there takes one of the two. A third macOS sandbox puts
the least recently used idle one to sleep, or answers `machine_full` naming the
two that are running. Don't start a build on a Mac already running two macOS
sandboxes, or a second one beside a build; pick another Mac. macOS sandboxes are for the
user's own development and testing; never set one up for anyone else.

## Xcode in a macOS sandbox

The macOS base has no Xcode: it needs an Apple ID and can't be redistributed.
Install it once and save the result as an image:

1. Create a macOS sandbox with room for Xcode, its `.xip` while it expands and
   a simulator runtime (`localbox sandbox create --image macos --disk 120G`),
   and get the Xcode `.xip` into it, either way:
   - **The user's Apple ID:** open https://developer.apple.com/download/all/ with
     `localbox browser open` and have the user sign in; they approve the
     two-factor prompt on their own device. Never write their password into a
     command, file or image.
   - **A `.xip` the user shares:** the user downloads it themselves. On the Mac
     that runs the sandbox, serve its folder on the sandbox network only: the
     Mac's address there is the sandbox's default gateway (`route -n get default`
     in the sandbox; usually `192.168.64.1`), so run
     `python3 -m http.server 8000 --bind GATEWAY` on the Mac and
     `curl -O http://GATEWAY:8000/NAME.xip` in the sandbox. Stop the server
     afterwards.
2. In the sandbox: `xip --expand` the archive, move `Xcode.app` to
   `/Applications`, then `xcodebuild -license accept` and
   `xcodebuild -runFirstLaunch`. These take minutes; run them with
   `--background`.
3. Sign the Apple ID out of the browser, delete the `.xip`, then save:
   `localbox image create --from NAME --name xcode`.

From then on `localbox sandbox create --image xcode` starts with Xcode ready.
