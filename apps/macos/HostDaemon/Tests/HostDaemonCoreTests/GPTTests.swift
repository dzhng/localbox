import XCTest
@testable import HostDaemonCore

/// The GPT reader and writer, against a 10 MiB disk with one partition as `sgdisk` wrote it (its non-zero sectors are
/// rebuilt in `gptFixture`).
final class GPTTests: XCTestCase {
    static let tenMB: UInt64 = 10 * 1024 * 1024

    func testReadsTheTableSgdiskWrote() throws {
        let table = try GPTTable.read(try GPTDiskFile(try fixtureDisk()))
        XCTAssertEqual(table.guid, UUID(uuidString: "43E51892-3273-42F7-BCDA-B43B80CDFC48"))
        XCTAssertTrue(table.protectiveMBR)
        XCTAssertEqual([table.primaryHeader, table.secondaryHeader, table.firstDataSector, table.lastDataSector, table.partitionFirstLBA], [1, 20479, 34, 20446, 2])
        XCTAssertEqual(table.partitions.count, 1, "the 127 unused entries are left out")
        let partition = try XCTUnwrap(table.partitions.first)
        XCTAssertEqual([partition.index], [1])
        XCTAssertEqual([partition.start, partition.end, partition.attributes], [2048, 3048, 0])
        XCTAssertEqual(partition.type, UUID(uuidString: "C12A7328-F81F-11D2-BA4B-00A0C93EC93B"), "the EFI system partition")
        XCTAssertEqual(partition.guid, UUID(uuidString: "5CA3360B-5DE6-4FCF-B4CE-419CEE433B51"))
        XCTAssertEqual(partition.name, "EFI System")
    }

    /// Everything `sgdisk` wrote comes back byte for byte, except the protective MBR's cylinder-head-sector fields,
    /// which nothing reads.
    func testATableReadAndWrittenBackIsTheBytesSgdiskWrote() throws {
        let table = try GPTTable.read(try GPTDiskFile(try fixtureDisk()))
        let copy = try blankDisk(Self.tenMB)
        try table.write(try GPTDiskFile(copy))
        var expected = gptFixture()
        for offset in [447, 448, 449, 451, 452, 453] { expected[offset] = 0 }
        XCTAssertTrue(try Data(contentsOf: copy) == Data(expected))
    }

    func testResizeMovesTheBackupToTheNewEndAndExpandExtendsAPartition() throws {
        let newSize: UInt64 = 11 * 1024 * 1024
        let disk = try fixtureDisk()
        try FileHandle(forWritingTo: disk).truncate(atOffset: newSize)
        let table = try GPTTable.read(try GPTDiskFile(disk))
        table.resize(newSize)
        table.partitions[0].expand(100)
        try table.write(try GPTDiskFile(disk))

        let read = try GPTTable.read(try GPTDiskFile(disk))
        XCTAssertEqual(read.totalSize(), newSize)
        XCTAssertEqual(read.lastDataSector, newSize / 512 - 34)
        XCTAssertEqual([read.partitions[0].start, read.partitions[0].end], [2048, 3148])
        let backup = try GPTTable.readGPTHeader(Array(try Data(contentsOf: disk).suffix(512)))
        XCTAssertEqual(backup.primaryHeader, newSize / 512 - 1, "the backup header names itself as the disk's last sector")
        XCTAssertEqual(backup.partitionFirstLBA, newSize / 512 - 33, "its array sits just before it")
    }

    func testAHeaderThatIsNotAGPTOrFailsItsChecksumIsRefused() {
        let cases: [(String, (inout [UInt8]) -> Void)] = [
            ("invalid EFI Signature", { $0[512] = 0x00 }),
            ("invalid EFI Revision", { $0[512 + 10] = 0xff }),
            ("invalid EFI Header size", { $0[512 + 12] &+= 1 }),
            ("invalid EFI Header, expected zeroes", { $0[512 + 20] = 0x01 }),
            ("invalid EFI Header Checksum", { $0[512 + 16] &+= 1 }),
        ]
        for (expected, corrupt) in cases {
            var b = Array(gptFixture()[0..<1024])
            corrupt(&b)
            XCTAssertThrowsError(try GPTTable.tableFromBytes(b)) { XCTAssertTrue("\($0)".hasPrefix(expected), "\($0) instead of \(expected)") }
        }
    }

    /// The guest writes its own GPT; a header asking for a larger array is refused, not read.
    func testAnArrayOtherThan128EntriesOf128BytesIsRefused() {
        var b = gptFixture()
        b[512 + 81] = 0x01 // 384 entries
        rehash(&b)
        XCTAssertThrowsError(try GPTTable.tableFromBytes(Array(b[0..<1024]))) { XCTAssertTrue("\($0)".hasPrefix("unsupported partition array of 384 entries"), "\($0)") }
    }

    /// Sector numbers past any disk in a guest's header fail the read or count as space to claim; the host never traps.
    func testSectorNumbersPastTheDiskInAGuestsHeaderDoNotCrashTheHost() throws {
        let huge = UInt64(1) << 62
        XCTAssertThrowsError(try GPTTable.read(try GPTDiskFile(try fixtureDisk(header: [72: huge]))), "the array's LBA")
        for field in [32, 48] { // the backup header's LBA, the last usable sector
            XCTAssertTrue(try DiskGrowth.hasUnclaimedSpace(try fixtureDisk(header: [field: huge])), "field \(field)")
        }
    }

    func testACorruptPartitionArrayIsRefused() throws {
        var b = gptFixture()
        // change a single byte in a partition entry
        b[512 + 512 + 400] &+= 1
        let disk = try scratch().appendingPathComponent("disk.img")
        try Data(b).write(to: disk)
        XCTAssertThrowsError(try GPTTable.read(try GPTDiskFile(disk))) { XCTAssertTrue("\($0)".hasPrefix("invalid EFI Partition Entry Checksum"), "\($0)") }
    }

    func testADiskTooShortForAGPTIsRefused() throws {
        let disk = try blankDisk(100)
        XCTAssertThrowsError(try GPTTable.read(try GPTDiskFile(disk))) { XCTAssertTrue("\($0)".hasPrefix("read only 100 bytes of GPT"), "\($0)") }
    }

    // MARK: - Helpers

    /// The fixture on disk, with the primary header's 64-bit fields at `header`'s offsets replaced and its CRC redone.
    private func fixtureDisk(header: [Int: UInt64] = [:]) throws -> URL {
        var b = gptFixture()
        for (offset, value) in header { for i in 0..<8 { b[512 + offset + i] = UInt8(truncatingIfNeeded: value >> (8 * i)) } }
        if !header.isEmpty { rehash(&b) }
        let disk = try scratch().appendingPathComponent("gpt.img")
        try Data(b).write(to: disk)
        return disk
    }

    /// Recomputes the primary header's CRC after a test edits it.
    private func rehash(_ b: inout [UInt8]) {
        b.replaceSubrange((512 + 16)..<(512 + 20), with: [0, 0, 0, 0])
        let crc = crc32IEEE(Array(b[512..<(512 + 92)]))
        for i in 0..<4 { b[512 + 16 + i] = UInt8(truncatingIfNeeded: crc >> (8 * i)) }
    }

    private func blankDisk(_ bytes: UInt64) throws -> URL {
        let disk = try scratch().appendingPathComponent("blank.img")
        FileManager.default.createFile(atPath: disk.path, contents: nil)
        try FileHandle(forWritingTo: disk).truncate(atOffset: bytes)
        return disk
    }
}

/// A 10 MiB disk `sgdisk --new 1:2048:3048 --typecode=1:ef00 --change-name=1:'EFI System'` partitioned, rebuilt from its
/// non-zero bytes (the partition's random contents left out: nothing here reads them).
func gptFixture() -> [UInt8] {
    var disk = [UInt8](repeating: 0, count: 10 * 1024 * 1024)
    for (offset, hex) in [
        (446, "00000200ee46050101000000ff4f000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000055aa"),
        (512, "4546492050415254000001005c000000fb76f2d7000000000100000000000000ff4f0000000000002200000000000000de4f0000000000009218e5437332f742bcdab43b80cdfc4802000000000000008000000080000000d31682a6"),
        (1024, gptPartitionHex),
        (20447 * 512, gptPartitionHex),
        (20479 * 512, "4546492050415254000001005c000000b215496d00000000ff4f00000000000001000000000000002200000000000000de4f0000000000009218e5437332f742bcdab43b80cdfc48df4f0000000000008000000080000000d31682a6"),
    ] { disk.replaceSubrange(offset..<(offset + hex.count / 2), with: bytes(hex)) }
    return disk
}

/// The 128-byte entry of that one partition.
private let gptPartitionHex = "28732ac11ff8d211ba4b00a0c93ec93b0b36a35ce65dcf4fb4ce419cee433b510008000000000000e80b00000000000000000000000000004500460049002000530079007300740065006d0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"

private func bytes(_ hex: String) -> [UInt8] {
    var out: [UInt8] = [], index = hex.startIndex
    while index < hex.endIndex { let next = hex.index(index, offsetBy: 2); out.append(UInt8(hex[index..<next], radix: 16)!); index = next }
    return out
}
