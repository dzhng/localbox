import XCTest
@testable import HostDaemonCore

/// A disk made bigger: the host's side (the file, a Linux GPT, a macOS base's recovery partition) and the commands the
/// guest's side runs through the agent's root shell.
final class DiskGrowthTests: XCTestCase {
    // MARK: - The recovery partition

    func testDelete() throws {
        // Create a disk, partitioned as GPT with a macOS recovery partition
        let diskPath = try gptDisk(1 * 1024 * 1024, [(34, 38, "Doesn't matter"), (39, 43, RecoveryPartition.name)])

        // Delete the recovery partition
        XCTAssertTrue(try RecoveryPartition.delete(diskPath))

        // Ensure that the recovery partition was deleted
        let partitions = try GPTTable.read(try GPTDiskFile(diskPath)).partitions
        XCTAssertEqual(partitions.map(\.name), ["Doesn't matter"])

        XCTAssertFalse(try RecoveryPartition.delete(diskPath), "no recovery partition: already deleted, nothing written")
    }

    func testDeleteRefusesARecoveryPartitionThatIsNotLastOrNotTheOnlyOne() throws {
        for names in [[RecoveryPartition.name, "Main"], ["Main", RecoveryPartition.name, RecoveryPartition.name]] {
            let disk = try gptDisk(1 << 20, names.enumerated().map { (34 + UInt64($0.offset) * 5, 38 + UInt64($0.offset) * 5, $0.element) })
            XCTAssertThrowsError(try RecoveryPartition.delete(disk)) { XCTAssertTrue("\($0)".contains("refusing to proceed"), "\($0)") }
            XCTAssertEqual(try GPTTable.read(try GPTDiskFile(disk)).partitions.count, names.count, "the table is left as it was")
        }
    }

    // MARK: - diskutil's plist

    func testSingleDisk() throws {
        let (disk, partition) = try GuestDiskClaim.parseDiskUtilPlistOutput(Data(Self.singleDisk.utf8))
        XCTAssertEqual(disk, "disk0"); XCTAssertEqual(partition, "disk0s2")
    }

    func testSingleDiskWithRecoveryPartition() throws {
        let (disk, partition) = try GuestDiskClaim.parseDiskUtilPlistOutput(Data(Self.singleDiskWithRecoveryPartition.utf8))
        XCTAssertEqual(disk, "disk0"); XCTAssertEqual(partition, "disk0s2")
    }

    func testMultipleDisks() throws {
        let (disk, partition) = try GuestDiskClaim.parseDiskUtilPlistOutput(Data(Self.multipleDisks.utf8))
        XCTAssertEqual(disk, "disk0"); XCTAssertEqual(partition, "disk0s2")
    }

    // MARK: - Growing a disk

    /// The built-in image's layout: an EFI system partition, then the ext4 root as the last partition.
    func testALinuxDiskGrowsItsGPTAndItsLastPartitionToTheNewEnd() throws {
        let disk = try linuxDisk(64 << 20)
        XCTAssertTrue(try DiskGrowth.grow(disk, to: 96 << 20, os: .linux))
        XCTAssertEqual(try DiskGrowth.size(disk), 96 << 20)
        let table = try GPTTable.read(try GPTDiskFile(disk))
        XCTAssertEqual(table.totalSize(), 96 << 20, "the backup header is at the new end")
        XCTAssertEqual(table.partitions.map(\.name), ["esp", "root"])
        XCTAssertEqual(table.partitions[0].end, 2048 + 8191, "the first partition is untouched")
        XCTAssertEqual(table.partitions[1].end, table.lastDataSector, "the root fills the disk")
        XCTAssertEqual(table.partitions[1].start, 10240)
        XCTAssertFalse(try DiskGrowth.grow(disk, to: 96 << 20, os: .linux), "a disk already at its size, with a table that fills it, changes nothing")
        XCTAssertThrowsError(try DiskGrowth.grow(disk, to: 64 << 20, os: .linux), "a disk never shrinks")
    }

    /// `sgdisk -n2:206848:+8192M` on the 8294M built-in disk leaves the root 2015 sectors short of the last usable one:
    /// alignment slack, not space to claim, so a sandbox at the image's size has nothing to grow.
    func testALinuxDiskAtItsImagesSizeHasNothingToGrow() throws {
        let disk = try linuxDisk(64 << 20, slackSectors: 2015)
        XCTAssertFalse(try DiskGrowth.grow(disk, to: 64 << 20, os: .linux))
        XCTAssertTrue(try DiskGrowth.grow(disk, to: 65 << 20, os: .linux), "a MiB more is growth")
    }

    func testALinuxGrowLeftHalfDoneIsFinishedAtTheNextBoot() throws {
        let disk = try linuxDisk(64 << 20)
        try FileHandle(forWritingTo: disk).truncate(atOffset: 96 << 20)
        XCTAssertTrue(try DiskGrowth.grow(disk, to: 96 << 20, os: .linux), "the file grew, its table did not: the table is finished")
        let table = try GPTTable.read(try GPTDiskFile(disk))
        XCTAssertEqual(table.partitions[1].end, table.lastDataSector)
    }

    /// A macOS disk keeps its table; the guest's `repairDisk` moves the backup header, `resizeContainer` the container.
    func testAMacOSDiskGrowsItsFileAndLeavesItsTableToTheGuest() throws {
        let disk = try macDisk(64 << 20, containerFills: true)
        let before = try Data(contentsOf: disk).prefix(64 << 20)
        XCTAssertFalse(try DiskGrowth.hasUnclaimedSpace(disk), "a container that fills its disk has nothing to claim")
        XCTAssertTrue(try DiskGrowth.grow(disk, to: 96 << 20, os: .macos))
        XCTAssertEqual(try Data(contentsOf: disk).prefix(64 << 20), before, "nothing on the disk was written")
        XCTAssertTrue(try DiskGrowth.hasUnclaimedSpace(disk), "the backup header is no longer at the end")
        XCTAssertTrue(try DiskGrowth.grow(disk, to: 96 << 20, os: .macos), "until the guest claims it, every boot says so")
    }

    func testAMacOSBaseWithoutItsRecoveryPartitionHasSpaceToClaim() throws {
        let disk = try macDisk(64 << 20, containerFills: false)
        XCTAssertTrue(try RecoveryPartition.delete(disk))
        XCTAssertTrue(try DiskGrowth.hasUnclaimedSpace(disk), "the recovery partition's space follows the container")
    }

    func testASandboxDiskIsItsImagesOrMore() throws {
        XCTAssertEqual(try DiskGrowth.sandboxSize(requested: nil, image: "linux", imageBytes: 8_696_889_344), 8_696_889_344)
        XCTAssertEqual(try DiskGrowth.sandboxSize(requested: 8_696_889_344, image: "linux", imageBytes: 8_696_889_344), 8_696_889_344, "the image's size exactly is not rounded")
        XCTAssertEqual(try DiskGrowth.sandboxSize(requested: 60 * gib + 1, image: "linux", imageBytes: 8_696_889_344), 60 * gib + (1 << 20), "a larger size rounds up to a whole MiB")
        XCTAssertThrowsError(try DiskGrowth.sandboxSize(requested: 4 * gib, image: "linux", imageBytes: 8_696_889_344)) {
            XCTAssertEqual("\($0)", "image linux's disk is 8.1 GiB, the least a sandbox from it gets, and 4 GiB was asked for")
        }
    }

    // MARK: - The guest's side

    func testALinuxGuestGrowsItsMountedRoot() async throws {
        let shell = Shell()
        try await GuestDiskClaim.claim(.linux, shell.run)
        XCTAssertEqual(shell.scripts, [#"resize2fs "$(findmnt -n -o SOURCE /)""#])
    }

    func testAMacOSGuestRepairsItsDiskThenGrowsItsContainer() async throws {
        let shell = Shell(answers: ["diskutil list -plist physical": Self.singleDisk])
        try await GuestDiskClaim.claim(.macos, shell.run)
        XCTAssertEqual(shell.scripts, ["diskutil list -plist physical", "yes | diskutil repairDisk disk0", "diskutil apfs resizeContainer disk0s2 0"], "upstream's order: repairDisk moves the backup header first")
    }

    // MARK: - Helpers

    private func blankDisk(_ bytes: UInt64) throws -> URL {
        let disk = try scratch().appendingPathComponent("disk.img")
        FileManager.default.createFile(atPath: disk.path, contents: nil)
        try FileHandle(forWritingTo: disk).truncate(atOffset: bytes)
        return disk
    }

    /// A blank disk of `bytes` with a GPT laid out as `sgdisk` lays one out (the protective MBR, the array at LBA 2,
    /// partitions from LBA 34 to 34 sectors before the end), holding `partitions` as (start, end, name).
    private func gptDisk(_ bytes: UInt64, _ partitions: [(UInt64, UInt64, String)]) throws -> URL {
        let disk = try blankDisk(bytes)
        let sectors = bytes / 512
        let table = GPTTable(partitions: partitions.enumerated().map { GPTPartition(index: $0.offset + 1, start: $0.element.0, end: $0.element.1, type: UUID(), name: $0.element.2, guid: UUID(), attributes: 0) },
                             guid: UUID(), protectiveMBR: true, partitionFirstLBA: 2, partitionEntryChecksum: 0, primaryHeader: 1, secondaryHeader: sectors - 1, firstDataSector: 34, lastDataSector: sectors - 34)
        try table.write(try GPTDiskFile(disk))
        return disk
    }

    /// A 4 MiB ESP at 1 MiB and the root after it, `slackSectors` short of the disk's last usable sector, as `sgdisk`
    /// lays the built-in image out.
    private func linuxDisk(_ bytes: UInt64, slackSectors: UInt64 = 0) throws -> URL {
        try gptDisk(bytes, [(2048, 2048 + 8191, "esp"), (10240, bytes / 512 - 34 - slackSectors, "root")])
    }

    /// iBoot's container, the main APFS container and, unless it fills the disk, the recovery container last.
    private func macDisk(_ bytes: UInt64, containerFills: Bool) throws -> URL {
        let lastUsable = bytes / 512 - 34
        return try gptDisk(bytes, [(40, 2087, "iBootSystemContainer")] + (containerFills ? [(2088, lastUsable, "Container")] : [(2088, lastUsable - 16384, "Container"), (lastUsable - 16383, lastUsable, RecoveryPartition.name)]))
    }

    /// A root shell that records each script and answers from `answers`.
    private final class Shell: @unchecked Sendable {
        private let seen = Locked<[String]>([])
        let answers: [String: String]
        init(answers: [String: String] = [:]) { self.answers = answers }
        var scripts: [String] { seen.value }
        var run: GuestRootShell { { script, _ in self.seen.withLock { $0.append(script) }; return self.answers[script] ?? "" } }
    }

    static let singleDisk = """
    <?xml version="1.0" encoding="UTF-8"?>
    <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
    <plist version="1.0">
    <dict>
    	<key>AllDisks</key>
    	<array>
    		<string>disk0</string>
    		<string>disk0s1</string>
    		<string>disk0s2</string>
    		<string>disk0s3</string>
    	</array>
    	<key>AllDisksAndPartitions</key>
    	<array>
    		<dict>
    			<key>Content</key>
    			<string>GUID_partition_scheme</string>
    			<key>DeviceIdentifier</key>
    			<string>disk0</string>
    			<key>OSInternal</key>
    			<false/>
    			<key>Partitions</key>
    			<array>
    				<dict>
    					<key>Content</key>
    					<string>Apple_APFS_ISC</string>
    					<key>DeviceIdentifier</key>
    					<string>disk0s1</string>
    					<key>DiskUUID</key>
    					<string>024D2AE5-891F-4244-81EC-182B88D1AA0B</string>
    					<key>Size</key>
    					<integer>524288000</integer>
    				</dict>
    				<dict>
    					<key>Content</key>
    					<string>Apple_APFS</string>
    					<key>DeviceIdentifier</key>
    					<string>disk0s2</string>
    					<key>DiskUUID</key>
    					<string>430F1409-D91A-47F4-8418-0876B14AA807</string>
    					<key>Size</key>
    					<integer>494384795648</integer>
    				</dict>
    			</array>
    			<key>Size</key>
    			<integer>500277792768</integer>
    		</dict>
    	</array>
    	<key>VolumesFromDisks</key>
    	<array/>
    	<key>WholeDisks</key>
    	<array>
    		<string>disk0</string>
    	</array>
    </dict>
    </plist>
    """

    static let singleDiskWithRecoveryPartition = """
    <?xml version="1.0" encoding="UTF-8"?>
    <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
    <plist version="1.0">
    <dict>
    	<key>AllDisks</key>
    	<array>
    		<string>disk0</string>
    		<string>disk0s1</string>
    		<string>disk0s2</string>
    		<string>disk0s3</string>
    	</array>
    	<key>AllDisksAndPartitions</key>
    	<array>
    		<dict>
    			<key>Content</key>
    			<string>GUID_partition_scheme</string>
    			<key>DeviceIdentifier</key>
    			<string>disk0</string>
    			<key>OSInternal</key>
    			<false/>
    			<key>Partitions</key>
    			<array>
    				<dict>
    					<key>Content</key>
    					<string>Apple_APFS_ISC</string>
    					<key>DeviceIdentifier</key>
    					<string>disk0s1</string>
    					<key>DiskUUID</key>
    					<string>22A4F5CC-CB5B-4EF1-B4F5-EBE9F79C0EE6</string>
    					<key>Size</key>
    					<integer>524288000</integer>
    				</dict>
    				<dict>
    					<key>Content</key>
    					<string>Apple_APFS</string>
    					<key>DeviceIdentifier</key>
    					<string>disk0s2</string>
    					<key>DiskUUID</key>
    					<string>E59D951F-E0B0-42B5-BE26-DF3611AD673C</string>
    					<key>Size</key>
    					<integer>44107001856</integer>
    				</dict>
    				<dict>
    					<key>Content</key>
    					<string>Apple_APFS_Recovery</string>
    					<key>DeviceIdentifier</key>
    					<string>disk0s3</string>
    					<key>DiskUUID</key>
    					<string>7684137C-F165-45C4-948B-681012742DAC</string>
    					<key>Size</key>
    					<integer>5368672256</integer>
    				</dict>
    			</array>
    			<key>Size</key>
    			<integer>50000000000</integer>
    		</dict>
    	</array>
    	<key>VolumesFromDisks</key>
    	<array/>
    	<key>WholeDisks</key>
    	<array>
    		<string>disk0</string>
    	</array>
    </dict>
    </plist>
    """

    static let multipleDisks = """
    <?xml version="1.0" encoding="UTF-8"?>
    <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
    <plist version="1.0">
    <dict>
    	<key>AllDisks</key>
    	<array>
    		<string>disk0</string>
    		<string>disk0s1</string>
    		<string>disk0s2</string>
    		<string>disk2</string>
    	</array>
    	<key>AllDisksAndPartitions</key>
    	<array>
    		<dict>
    			<key>Content</key>
    			<string>GUID_partition_scheme</string>
    			<key>DeviceIdentifier</key>
    			<string>disk0</string>
    			<key>OSInternal</key>
    			<false/>
    			<key>Partitions</key>
    			<array>
    				<dict>
    					<key>Content</key>
    					<string>Apple_APFS_ISC</string>
    					<key>DeviceIdentifier</key>
    					<string>disk0s1</string>
    					<key>DiskUUID</key>
    					<string>D2B79297-879E-4461-8DA2-EEA50EA7319A</string>
    					<key>Size</key>
    					<integer>524288000</integer>
    				</dict>
    				<dict>
    					<key>Content</key>
    					<string>Apple_APFS</string>
    					<key>DeviceIdentifier</key>
    					<string>disk0s2</string>
    					<key>DiskUUID</key>
    					<string>D5BA624D-182F-40D0-8248-D08508A8D1B3</string>
    					<key>Size</key>
    					<integer>89475674112</integer>
    				</dict>
    			</array>
    			<key>Size</key>
    			<integer>90000000000</integer>
    		</dict>
    		<dict>
    			<key>Content</key>
    			<string></string>
    			<key>DeviceIdentifier</key>
    			<string>disk2</string>
    			<key>OSInternal</key>
    			<false/>
    			<key>Size</key>
    			<integer>107164426240</integer>
    		</dict>
    	</array>
    	<key>VolumesFromDisks</key>
    	<array/>
    	<key>WholeDisks</key>
    	<array>
    		<string>disk0</string>
    		<string>disk2</string>
    	</array>
    </dict>
    </plist>
    """
}
