# Third-party notices

Code in this repository that was ported from other projects, the licence it
carries, and where it lives here.

## packer-plugin-tart (Mozilla Public License 2.0)

From [cirruslabs/packer-plugin-tart](https://github.com/cirruslabs/packer-plugin-tart)
at commit `f833f5728fcd77e343525a4b1ce6f26231093ceb` (`growDisk`, which that
commit's history removed, at `01d30a0^`):

| Upstream | Here |
| --- | --- |
| `builder/tart/step_disk_resize.go` | `apps/macos/HostDaemon/Sources/HostDaemonCore/GuestDiskClaim.swift` (`claimMacOS`) |
| `builder/tart/diskutil_parser.go` | `apps/macos/HostDaemon/Sources/HostDaemonCore/GuestDiskClaim.swift` (`parseDiskUtilPlistOutput`) |
| `builder/tart/diskutil_parser_test.go` | `apps/macos/HostDaemon/Tests/HostDaemonCoreTests/DiskGrowthTests.swift` (the diskutil plist tests) |
| `builder/tart/recoverypartition/delete.go`, `recoverypartition.go` | `apps/macos/HostDaemon/Sources/HostDaemonCore/RecoveryPartition.swift` |
| `builder/tart/recoverypartition/delete_test.go` | `apps/macos/HostDaemon/Tests/HostDaemonCoreTests/DiskGrowthTests.swift` (`testDelete`) |
| `builder/tart/step_disk_file_prepare.go` (`growDisk`) | `apps/macos/HostDaemon/Sources/HostDaemonCore/DiskGrowth.swift` (`growDisk`) |

Exhibit A, for the files above:

> This Source Code Form is subject to the terms of the Mozilla Public License,
> v. 2.0. If a copy of the MPL was not distributed with this file, You can
> obtain one at https://mozilla.org/MPL/2.0/.

## go-diskfs (MIT)

From [diskfs/go-diskfs](https://github.com/diskfs/go-diskfs) at tag `v1.9.3`
(commit `c8d7f7c32e34a300c741aa9f9a9cd48ba73736a0`), the GPT reading and writing
its `recoverypartition.Delete` relies on, with `Table.Resize` and
`Partition.Expand`:

| Upstream | Here |
| --- | --- |
| `partition/gpt/table.go`, `partition.go`, `common.go` | `apps/macos/HostDaemon/Sources/HostDaemonCore/GPT.swift` |
| `partition/gpt/table_test.go`, `table_internal_test.go`, `testdata/gpt.img`, `testdata/gpt_partition.dat` | `apps/macos/HostDaemon/Tests/HostDaemonCoreTests/GPTTests.swift` |

```
MIT License

Copyright (c) 2017 Avi Deitcher

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
