import XCTest
@testable import HostDaemonCore

/// The GPT reader and writer: the fixture is a 10 MiB disk with one partition, as `sgdisk` wrote it (its non-zero
/// sectors are rebuilt in `gptFixture`).
final class GPTTests: XCTestCase {
    static let tenMB: Int64 = 10 * 1024 * 1024
    static let gptSize = 128 * 128

    func getValidTable() -> GPTTable {
        // check out data
        let table = GPTTable(partitionEntrySize: 128, primaryHeader: 1, secondaryHeader: 20479, firstDataSector: 34, lastDataSector: 20446, partitionArraySize: 128, partitionFirstLBA: 0,
                             guid: "43E51892-3273-42F7-BCDA-B43B80CDFC48", partitionEntryChecksum: 0)
        table.logicalSectorSize = 512; table.physicalSectorSize = 512; table.protectiveMBR = true
        // there are 127 Unused partitions, but those are ignored
        table.partitions = [GPTPartition(index: 1, start: 2048, end: 3048, size: (3048 - 2048 + 1) * 512, type: .efiSystemPartition, name: "EFI System", guid: "5CA3360B-5DE6-4FCF-B4CE-419CEE433B51",
                                         attributes: 0, logicalSectorSize: 512, physicalSectorSize: 512)]
        return table
    }

    // MARK: - Table

    func testTableReadErrorReadingFile() {
        let expected = "error reading GPT from file"
        let f = FakeFile(reader: { _, _ in throw GPTError(expected) })
        XCTAssertThrowsError(try GPTTable.read(f, logicalBlockSize: 512, physicalBlockSize: 512)) { XCTAssertTrue("\($0)".hasPrefix(expected), "\($0)") }
    }

    func testTableReadInsufficientDataRead() {
        let size = 100
        let f = FakeFile(reader: { _, _ in [UInt8](repeating: 0, count: size) })
        XCTAssertThrowsError(try GPTTable.read(f, logicalBlockSize: 512, physicalBlockSize: 512)) { XCTAssertTrue("\($0)".hasPrefix("read only \(size) bytes of GPT"), "\($0)") }
    }

    func testTableReadSuccessfulRead() throws {
        let table = try GPTTable.read(MemoryFile(gptFixture()), logicalBlockSize: 512, physicalBlockSize: 512)
        XCTAssertTrue(table.equal(getValidTable()), "table mismatch")
    }

    func testTableWriteErrorWritingFile() {
        let expected = "error writing protective MBR to disk"
        let f = FakeFile(writer: { _, _ in throw GPTError(expected) })
        XCTAssertThrowsError(try getValidTable().write(f, size: Self.tenMB)) { XCTAssertTrue("\($0)".hasPrefix(expected), "\($0)") }
    }

    func testTableWriteInsufficientDataWritten() {
        var size = 0
        let f = FakeFile(writer: { b, _ in size = b.count - 1; return size })
        XCTAssertThrowsError(try getValidTable().write(f, size: Self.tenMB)) { XCTAssertTrue("\($0)".hasPrefix("wrote \(size) bytes of protective MBR"), "\($0)") }
    }

    func testTableWriteSuccessfulWrite() throws {
        let firstBytes = Array(gptFixture()[0..<(Self.gptSize + 512 * 2)])
        let protectiveMBR = Array(firstBytes[446..<512]), primaryHeader = Array(firstBytes[512..<1024]), primaryArray = Array(firstBytes[1024...])
        var tableProtectiveMBR: [UInt8] = [], tablePrimaryHeader: [UInt8] = [], tablePrimaryArray: [UInt8] = []
        let f = FakeFile(writer: { b, offset in
            switch offset {
            case 446: tableProtectiveMBR += b
            case 512: tablePrimaryHeader += b
            case 1024: tablePrimaryArray += b
            default: break
            }
            return b.count
        })
        try getValidTable().write(f, size: Self.tenMB)
        XCTAssertTrue(compareProtectiveMBRBytes(tableProtectiveMBR, protectiveMBR), "mismatched protective MBR")
        XCTAssertEqual(tablePrimaryHeader, primaryHeader, "mismatched primary header")
        XCTAssertEqual(tablePrimaryArray, primaryArray, "mismatched primary array")
    }

    func testTableWriteSuccessfulFullTest() throws {
        let disk = try scratch().appendingPathComponent("disk.img")
        FileManager.default.createFile(atPath: disk.path, contents: nil)
        try FileHandle(forWritingTo: disk).truncate(atOffset: 10 * 1024 * 1024)
        // this is partition start and end in sectors, not bytes
        let partitionStart: UInt64 = 2048
        // make it a 5MB partition
        let partitionEnd = UInt64(5 * 1024 * 1024 / 512) + partitionStart
        let name = "EFI System Tester"
        let table = GPTTable(partitions: [GPTPartition(index: 1, start: partitionStart, end: partitionEnd, type: .efiSystemPartition, name: name)], logicalSectorSize: 512, protectiveMBR: true)
        try table.write(try GPTDiskFile(disk), size: try Int64(DiskGrowth.size(disk)))
        // sgdisk's view of it, read back: First usable sector is 34, last usable sector is 20446.
        let read = try GPTTable.read(try GPTDiskFile(disk), logicalBlockSize: 512, physicalBlockSize: 512)
        XCTAssertEqual(read.partitions.map(\.type), [.efiSystemPartition])
        XCTAssertEqual(read.partitions.first?.guid.count, 36)
        XCTAssertEqual([read.partitions.first?.start, read.partitions.first?.end], [partitionStart, partitionEnd])
        XCTAssertEqual(read.partitions.first?.name, name)
        XCTAssertEqual([read.firstDataSector, read.lastDataSector], [34, 20446])
    }

    func testToPartitionArrayBytes() throws {
        for partitions in [[GPTPartition](), []] {
            let table = getValidTable(); table.partitions = partitions
            let b = try table.toPartitionArrayBytes()
            XCTAssertEqual(b.count, Int(table.partitionEntrySize) * table.partitionArraySize)
            XCTAssertTrue(b.allSatisfy { $0 == 0 }, "expected empty partition entries")
        }
        func entries(_ list: [(Int, UInt64, UInt64)], type: GPTPartitionType = .unused) -> [GPTPartition] {
            list.map { GPTPartition(index: $0.0, start: $0.1, end: $0.2, size: ($0.2 - $0.1 + 1) * 512, type: type, name: "Index \($0.0)") }
        }
        for (label, partitions) in [("duplicate indexes", entries([(1, 4000, 5000), (1, 6000, 7000)])), ("negative index", entries([(-1, 4000, 5000)])), ("zero index", entries([(0, 4000, 5000)])),
                                    ("index too large", entries([(129, 4000, 5000)]))] {
            let table = getValidTable(); table.partitions = partitions
            XCTAssertThrowsError(try table.toPartitionArrayBytes(), "expected error due to \(label)")
        }
        for partitions in [entries([(1, 4000, 5000), (2, 6000, 7000), (3, 8000, 9000)], type: .linuxFilesystem), entries([(3, 8000, 9000), (8, 4000, 5000), (2, 6000, 7000)], type: .linuxFilesystem)] {
            let table = getValidTable(); table.partitions = partitions
            XCTAssertNoThrow(try table.toPartitionArrayBytes(), "in order or out of order")
        }
    }

    func testTableFromBytes() throws {
        XCTAssertThrowsError(try GPTTable.tableFromBytes([UInt8](repeating: 7, count: 512 + 512 - 1), logicalBlockSize: 512, physicalBlockSize: 512)) {
            XCTAssertTrue("\($0)".hasPrefix("data for partition was \(512 + 512 - 1) bytes"), "\($0)")
        }
        let cases: [(String, (inout [UInt8]) -> Void)] = [
            ("invalid EFI Signature", { $0[512] = 0x00 }),
            ("invalid EFI Revision", { $0[512 + 10] = 0xff }),
            ("invalid EFI Header size", { $0[512 + 12] &+= 1 }),
            ("invalid EFI Header, expected zeroes", { $0[512 + 20] = 0x01 }),
            ("invalid EFI Header Checksum", { $0[512 + 16] &+= 1 }),
        ]
        for (expected, corrupt) in cases {
            var b = gptFixture()
            corrupt(&b)
            XCTAssertThrowsError(try GPTTable.tableFromBytes(b, logicalBlockSize: 512, physicalBlockSize: 512)) { XCTAssertTrue("\($0)".hasPrefix(expected), "\($0) instead of \(expected)") }
        }
    }

    func testReadInvalidEFIPartitionChecksum() {
        var b = gptFixture()
        // change a single byte in a partition entry
        b[512 + 512 + 400] &+= 1
        XCTAssertThrowsError(try GPTTable.read(MemoryFile(b), logicalBlockSize: 512, physicalBlockSize: 512)) { XCTAssertTrue("\($0)".hasPrefix("invalid EFI Partition Entry Checksum"), "\($0)") }
    }

    func testResizeTableAndExpandPartition() throws {
        let newSize: UInt64 = 11 * 1024 * 1024
        let table = try GPTTable.read(MemoryFile(gptFixture()), logicalBlockSize: 512, physicalBlockSize: 512)
        table.resize(newSize)
        let image = try scratch().appendingPathComponent("gpt.img")
        FileManager.default.createFile(atPath: image.path, contents: nil)
        try FileHandle(forWritingTo: image).truncate(atOffset: newSize)
        table.partitions[0].expand(100)
        try table.write(try GPTDiskFile(image), size: Int64(newSize))
        let newTable = try GPTTable.read(try GPTDiskFile(image), logicalBlockSize: 512, physicalBlockSize: 512)
        XCTAssertEqual(newTable.partitions[0].start, 2048)
        XCTAssertEqual(newTable.partitions[0].end, 3148)
        XCTAssertEqual(newTable.partitions[0].size, 563712)
    }

    func testResize() {
        let newSize: UInt64 = 1024 * 1024
        let table = getValidTable()
        table.resize(newSize)
        XCTAssertEqual(table.totalSize(), newSize)
        XCTAssertEqual(table.lastUsableSector(), (newSize / 512) - 34)
    }

    func testExpandPartition() {
        let part = getValidTable().partitions[0]
        part.expand(100)
        XCTAssertEqual(part.end, 3148)
        XCTAssertEqual(part.size, (3148 - 2048 + 1) * 512)
    }

    // MARK: - Partition

    func testFromBytes() throws {
        for count in [GPTPartition.entrySize - 1, GPTPartition.entrySize + 1] {
            XCTAssertThrowsError(try GPTPartition.fromBytes(index: 1, [UInt8](repeating: 7, count: count), logicalSectorSize: 2048, physicalSectorSize: 2048)) {
                XCTAssertTrue("\($0)".hasPrefix("data for partition was \(count) bytes instead of expected \(GPTPartition.entrySize)"), "\($0)")
            }
        }
        let partition = try XCTUnwrap(try GPTPartition.fromBytes(index: 1, gptPartitionFixture(), logicalSectorSize: 0, physicalSectorSize: 0))
        XCTAssertEqual(partition, GPTPartition(index: 1, start: 2048, end: 3048, type: .efiSystemPartition, name: "EFI System", guid: "5CA3360B-5DE6-4FCF-B4CE-419CEE433B51", attributes: 0))
    }

    func testToBytes() throws {
        let invalidID = GPTPartition(index: 0, start: 2048, end: 3048, type: .efiSystemPartition, name: "EFI System", guid: "5CA3360B")
        XCTAssertThrowsError(try invalidID.toBytes()) { XCTAssertTrue("\($0)".hasPrefix("unable to parse partition identifier GUID"), "\($0)") }
        let invalidType = GPTPartition(index: 0, start: 2048, end: 3048, type: GPTPartitionType(rawValue: "ABCDEF"), name: "EFI System", guid: "5CA3360B-5DE6-4FCF-B4CE-419CEE433B51")
        XCTAssertThrowsError(try invalidType.toBytes()) { XCTAssertTrue("\($0)".hasPrefix("unable to parse partition type GUID"), "\($0)") }
        let longName = "This is a very long name, as long as it is longer than 36 unicode character points, it should fail. Since that is 72 bytes, we are going to make it >72 chars."
        let tooLong = GPTPartition(index: 0, start: 2048, end: 3048, type: .efiSystemPartition, name: longName, guid: "5CA3360B-5DE6-4FCF-B4CE-419CEE433B51")
        XCTAssertThrowsError(try tooLong.toBytes()) { XCTAssertTrue("\($0)".hasPrefix("cannot use \(longName) as partition name, has \(longName.count) Unicode code units, maximum size is 36"), "\($0)") }
        let valid = GPTPartition(index: 0, start: 2048, end: 3048, type: .efiSystemPartition, name: "EFI System", guid: "5CA3360B-5DE6-4FCF-B4CE-419CEE433B51")
        XCTAssertEqual(try valid.toBytes(), gptPartitionFixture())
    }

    func testInitEntry() throws {
        let goodGUID = "5CA3360B-5DE6-4FCF-B4CE-419CEE433B51"
        let start: UInt64 = 2048, end: UInt64 = 3047, size: UInt64 = 1000 * 512
        func entry(start: UInt64 = start, end: UInt64 = end, size: UInt64 = size, guid: String = goodGUID) -> GPTPartition {
            GPTPartition(index: 1, start: start, end: end, size: size, type: .efiSystemPartition, name: "EFI System", guid: guid)
        }

        let missing = entry(guid: ""); try missing.initEntry(512)
        XCTAssertNotNil(UUID(uuidString: missing.guid), "did not initialize valid GUID, remains: \(missing.guid)")
        let existing = entry(); try existing.initEntry(512)
        XCTAssertEqual(existing.guid, goodGUID, "reset GUID even though a good one existed")
        let noSize = entry(size: 0); try noSize.initEntry(512)
        XCTAssertEqual(noSize.size, size)
        let noEnd = entry(end: 0); try noEnd.initEntry(512)
        XCTAssertEqual(noEnd.end, end)
        XCTAssertThrowsError(try entry(start: 0, end: 0).initEntry(512), "only size")
        XCTAssertThrowsError(try entry(size: size + 1).initEntry(512)) { XCTAssertTrue("\($0)".hasPrefix("invalid partition entry"), "\($0)") }
    }

    // MARK: - Helpers

    /// Compares specially because sector, head and cylinder are ignored.
    private func compareProtectiveMBRBytes(_ b1: [UInt8], _ b2: [UInt8]) -> Bool {
        b1.count == b2.count && b1[0] == b2[0] && b1[4] == b2[4] && b1[8..<12] == b2[8..<12] && b1[12..<16] == b2[12..<16] && b1[16...] == b2[16...]
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

/// The fixture `gpt_partition.dat`: the 128-byte entry of that one partition.
func gptPartitionFixture() -> [UInt8] { bytes(gptPartitionHex) }

private let gptPartitionHex = "28732ac11ff8d211ba4b00a0c93ec93b0b36a35ce65dcf4fb4ce419cee433b510008000000000000e80b00000000000000000000000000004500460049002000530079007300740065006d0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"

private func bytes(_ hex: String) -> [UInt8] {
    var out: [UInt8] = [], index = hex.startIndex
    while index < hex.endIndex { let next = hex.index(index, offsetBy: 2); out.append(UInt8(hex[index..<next], radix: 16)!); index = next }
    return out
}

/// A disk in memory.
final class MemoryFile: GPTBackingFile {
    var bytes: [UInt8]
    init(_ bytes: [UInt8]) { self.bytes = bytes }
    func readAt(_ count: Int, _ offset: Int64) throws -> [UInt8] { Array(bytes[Int(offset)..<min(bytes.count, Int(offset) + count)]) }
    func writeAt(_ b: [UInt8], _ offset: Int64) throws -> Int { bytes.replaceSubrange(Int(offset)..<(Int(offset) + b.count), with: b); return b.count }
}

/// A disk whose reads and writes a test scripts.
final class FakeFile: GPTBackingFile {
    let reader: (Int, Int64) throws -> [UInt8], writer: ([UInt8], Int64) throws -> Int
    init(reader: @escaping (Int, Int64) throws -> [UInt8] = { _, _ in [] }, writer: @escaping ([UInt8], Int64) throws -> Int = { b, _ in b.count }) { self.reader = reader; self.writer = writer }
    func readAt(_ count: Int, _ offset: Int64) throws -> [UInt8] { try reader(count, offset) }
    func writeAt(_ b: [UInt8], _ offset: Int64) throws -> Int { try writer(b, offset) }
}
