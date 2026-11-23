import Foundation
import zlib

/// A GUID Partition Table read from a disk file and written back to it: the protective MBR, the primary header and
/// partition entry array, and the backup array and header at the disk's end, each with its CRC32. A Linux sandbox's
/// disk grows by moving the backup to the new end (`resize`) and extending its last partition (`GPTPartition.expand`);
/// a macOS base drops its recovery partition (`RecoveryPartition.delete`).
///
/// Every disk Localbox runs has 512-byte sectors and an array of 128 entries of 128 bytes (what `sgdisk` and the macOS
/// installer write); a table laid out otherwise is refused. The table is the guest's to write, so that is also what
/// bounds what a read allocates.
final class GPTTable {
    var partitions: [GPTPartition]
    /// Disk GUID.
    let guid: UUID
    var protectiveMBR: Bool
    /// First LBA of the partition array.
    let partitionFirstLBA: UInt64
    let partitionEntryChecksum: UInt32
    /// LBA of the primary header, always 1.
    let primaryHeader: UInt64
    /// LBA of the backup header, always the disk's last sector.
    var secondaryHeader: UInt64
    let firstDataSector: UInt64
    var lastDataSector: UInt64

    init(partitions: [GPTPartition], guid: UUID, protectiveMBR: Bool, partitionFirstLBA: UInt64, partitionEntryChecksum: UInt32, primaryHeader: UInt64, secondaryHeader: UInt64,
         firstDataSector: UInt64, lastDataSector: UInt64) {
        self.partitions = partitions; self.guid = guid; self.protectiveMBR = protectiveMBR; self.partitionFirstLBA = partitionFirstLBA; self.partitionEntryChecksum = partitionEntryChecksum
        self.primaryHeader = primaryHeader; self.secondaryHeader = secondaryHeader; self.firstDataSector = firstDataSector; self.lastDataSector = lastDataSector
    }

    static let sectorSize = 512
    /// How many entries the partition array holds.
    static let partitionArraySize = 128

    static let mbrPartitionEntriesStart = 446
    static let mbrPartitionEntriesCount = 4
    static let mbrPartitionEntrySize = 16

    static let efiSignature: [UInt8] = [0x45, 0x46, 0x49, 0x20, 0x50, 0x41, 0x52, 0x54]
    static let efiRevision: [UInt8] = [0x00, 0x00, 0x01, 0x00]
    static let efiHeaderSize: [UInt8] = [0x5c, 0x00, 0x00, 0x00]
    static let efiZeroes: [UInt8] = [0x00, 0x00, 0x00, 0x00]
    static let mbrSignature: [UInt8] = [0x55, 0xaa]

    /// How many sectors the partition array takes.
    static let partitionArraySectors = UInt64(partitionArraySize * GPTPartition.entrySize / sectorSize)

    /// Whether the sector `b` holds a protective MBR covering `sectors`.
    static func readProtectiveMBR(_ b: [UInt8], sectors: UInt32) -> Bool {
        // check for MBR signature
        guard Array(b[(b.count - 2)...]) == mbrSignature else { return false }
        // get the partitions
        let parts = Array(b[mbrPartitionEntriesStart..<(mbrPartitionEntriesStart + mbrPartitionEntrySize * mbrPartitionEntriesCount)])
        // should have all except the first partition by zeroes
        for i in 1..<mbrPartitionEntriesCount where parts[(i * mbrPartitionEntrySize)..<((i + 1) * mbrPartitionEntrySize)].contains(where: { $0 != 0 }) { return false }
        // finally the first one should be a partition of type 0xee that covers the whole disk and has non-bootable

        // non-bootable
        guard parts[0] == 0x00 else { return false }
        // we ignore head/cylinder/sector
        // partition type 0xee
        guard parts[4] == 0xee else { return false }
        guard littleEndian32(parts, 8) == 1 else { return false }
        guard littleEndian32(parts, 12) == sectors else { return false }
        return true
    }

    /// The sector that holds the primary or the backup partition array.
    func partitionArraySector(_ primary: Bool) -> UInt64 {
        if primary { return primaryHeader + 1 }
        return secondaryHeader - Self.partitionArraySectors
    }

    func generateProtectiveMBR() -> [UInt8] {
        var b = [UInt8](repeating: 0, count: 512)
        // we don't do anything to the first 446 bytes
        b.replaceSubrange(510..<512, with: Self.mbrSignature)
        // create the single all disk partition
        let parts = Self.mbrPartitionEntriesStart
        // non-bootable
        b[parts + 0] = 0x00
        // ignore CHS entirely
        // partition type 0xee
        b[parts + 4] = 0xee
        // ignore CHS entirely
        // start LBA 1
        putLittleEndian32(&b, parts + 8, 1)
        // end LBA last one on disk
        putLittleEndian32(&b, parts + 12, UInt32(clamping: secondaryHeader))
        return b
    }

    /// The bytes of the partition array: each entry in the slot its index names, every other slot zero.
    func toPartitionArrayBytes() -> [UInt8] {
        var bpart = [UInt8](repeating: 0, count: GPTPartition.entrySize * Self.partitionArraySize)
        for p in partitions {
            let slotStart = (p.index - 1) * GPTPartition.entrySize
            bpart.replaceSubrange(slotStart..<(slotStart + GPTPartition.entrySize), with: p.toBytes())
        }
        return bpart
    }

    /// Just the GPT header, as bytes.
    func toGPTBytes(_ primary: Bool) -> [UInt8] {
        var b = [UInt8](repeating: 0, count: Self.sectorSize)

        // 8 bytes "EFI PART" signature
        b.replaceSubrange(0..<8, with: Self.efiSignature)
        // 4 bytes revision 1.0
        b.replaceSubrange(8..<12, with: Self.efiRevision)
        // 4 bytes header size
        b.replaceSubrange(12..<16, with: Self.efiHeaderSize)
        // 4 bytes CRC32/zlib of header with this field zeroed out - must calculate then come back
        b.replaceSubrange(16..<20, with: [0x00, 0x00, 0x00, 0x00])
        // 4 bytes zeroes reserved
        b.replaceSubrange(20..<24, with: Self.efiZeroes)

        // which LBA are we?
        if primary {
            putLittleEndian64(&b, 24, primaryHeader)
            putLittleEndian64(&b, 32, secondaryHeader)
        } else {
            putLittleEndian64(&b, 24, secondaryHeader)
            putLittleEndian64(&b, 32, primaryHeader)
        }

        // usable LBAs for partitions
        putLittleEndian64(&b, 40, firstDataSector)
        putLittleEndian64(&b, 48, lastDataSector)

        // 16 bytes disk GUID
        b.replaceSubrange(56..<72, with: bytesToUUIDBytes(guid.bytes))

        // starting LBA of array of partition entries
        putLittleEndian64(&b, 72, partitionArraySector(primary))

        // how many entries?
        putLittleEndian32(&b, 80, UInt32(Self.partitionArraySize))
        // how big is a single entry?
        putLittleEndian32(&b, 84, 0x80)

        // we need a CRC/zlib of the partition entries, so we do those first, then append the bytes
        putLittleEndian32(&b, 88, crc32IEEE(toPartitionArrayBytes()))

        // calculate checksum of entire header and place 4 bytes of offset 16 = 0x10
        putLittleEndian32(&b, 16, crc32IEEE(Array(b[0..<92])))

        return b
    }

    /// The partitions in the bytes of a partition array.
    static func readPartitionArrayBytes(_ b: [UInt8]) -> [GPTPartition] {
        var parts: [GPTPartition] = []
        var i = 0, offset = 0
        while b.count - offset >= GPTPartition.entrySize {
            let bpart = Array(b[offset..<(offset + GPTPartition.entrySize)])
            offset += GPTPartition.entrySize; i += 1
            guard let p = GPTPartition.fromBytes(index: i, bpart) else { continue }
            parts.append(p)
        }
        return parts
    }

    /// The GPT header in `b`.
    static func readGPTHeader(_ b: [UInt8]) throws -> GPTTable {
        var gpt = b
        // start with fixed headers
        let efiSignature = Array(gpt[0..<8])
        let efiRevision = Array(gpt[8..<12])
        let efiHeaderSize = Array(gpt[12..<16])
        let efiHeaderCrc = littleEndian32(gpt, 16)
        let efiZeroes = Array(gpt[20..<24])
        let primaryHeader = littleEndian64(gpt, 24)
        let secondaryHeader = littleEndian64(gpt, 32)
        let firstDataSector = littleEndian64(gpt, 40)
        let lastDataSector = littleEndian64(gpt, 48)
        let diskGUID = UUID(bytes: bytesToUUIDBytes(Array(gpt[56..<72])))
        let partitionEntryFirstLBA = littleEndian64(gpt, 72)
        let partitionEntryCount = littleEndian32(gpt, 80)
        let partitionEntrySize = littleEndian32(gpt, 84)
        let partitionEntryChecksum = littleEndian32(gpt, 88)

        // once we have the header CRC, zero it out
        gpt.replaceSubrange(16..<20, with: [0x00, 0x00, 0x00, 0x00])
        guard efiSignature == Self.efiSignature else { throw GPTError("invalid EFI Signature \(efiSignature)") }
        guard efiRevision == Self.efiRevision else { throw GPTError("invalid EFI Revision \(efiRevision)") }
        guard efiHeaderSize == Self.efiHeaderSize else { throw GPTError("invalid EFI Header size \(efiHeaderSize)") }
        guard efiZeroes == Self.efiZeroes else { throw GPTError("invalid EFI Header, expected zeroes, got \(efiZeroes)") }
        // get the checksum
        let checksum = crc32IEEE(Array(gpt[0..<92]))
        guard efiHeaderCrc == checksum else { throw GPTError("invalid EFI Header Checksum, expected \(checksum), got \(efiHeaderCrc)") }
        guard partitionEntryCount == partitionArraySize, partitionEntrySize == GPTPartition.entrySize else {
            throw GPTError("unsupported partition array of \(partitionEntryCount) entries of \(partitionEntrySize) bytes, expected \(partitionArraySize) of \(GPTPartition.entrySize)")
        }

        return GPTTable(partitions: [], guid: diskGUID, protectiveMBR: false, partitionFirstLBA: partitionEntryFirstLBA, partitionEntryChecksum: partitionEntryChecksum,
                        primaryHeader: primaryHeader, secondaryHeader: secondaryHeader, firstDataSector: firstDataSector, lastDataSector: lastDataSector)
    }

    /// The partition table in `b`, the disk's first two sectors.
    static func tableFromBytes(_ b: [UInt8]) throws -> GPTTable {
        // GPT starts at LBA1
        let table = try readGPTHeader(Array(b[sectorSize...]))

        // potential protective MBR is at LBA0
        table.protectiveMBR = readProtectiveMBR(Array(b[..<sectorSize]), sectors: UInt32(clamping: table.secondaryHeader))

        return table
    }

    /// Writes the table: the protective MBR (if any), the primary header and array, then the backup array and header.
    func write(_ f: GPTDiskFile) throws {
        if protectiveMBR {
            do { try f.writeAt(Array(generateProtectiveMBR()[Self.mbrPartitionEntriesStart...]), UInt64(Self.mbrPartitionEntriesStart)) } catch { throw GPTError("error writing protective MBR to disk: \(error)") }
        }
        do { try f.writeAt(toGPTBytes(true), UInt64(Self.sectorSize)) } catch { throw GPTError("error writing primary GPT to disk: \(error)") }
        let partitionArray = toPartitionArrayBytes()
        do { try f.writeAt(partitionArray, UInt64(Self.sectorSize) * partitionArraySector(true)) } catch { throw GPTError("error writing primary partition array to disk: \(error)") }
        do { try f.writeAt(partitionArray, UInt64(Self.sectorSize) * partitionArraySector(false)) } catch { throw GPTError("error writing secondary partition array to disk: \(error)") }
        do { try f.writeAt(toGPTBytes(false), UInt64(Self.sectorSize) * secondaryHeader) } catch { throw GPTError("error writing secondary GPT to disk: \(error)") }
    }

    /// Reads a partition table from a disk; throws at any stage that fails reading the disk or taking its bytes as a
    /// GPT Localbox can rewrite.
    static func read(_ f: GPTDiskFile) throws -> GPTTable {
        // read the data off of the disk - first block is the compatibility MBR, second is the GPT table
        var b: [UInt8]
        do { b = try f.readAt(sectorSize * 2, 0) } catch { throw GPTError("error reading GPT from file: \(error)") }
        guard b.count == sectorSize * 2 else { throw GPTError("read only \(b.count) bytes of GPT from file instead of expected \(sectorSize * 2)") }
        // get the gpt table
        let gptTable: GPTTable
        do { gptTable = try tableFromBytes(b) } catch { throw GPTError("error reading GPT table: \(error)") }
        let size = GPTPartition.entrySize * partitionArraySize
        // the guest wrote this sector number: it wraps as upstream's Go does rather than trap, and a wrong one fails a check
        do { b = try f.readAt(size, gptTable.partitionFirstLBA &* UInt64(sectorSize)) } catch { throw GPTError("error reading partitions from file: \(error)") }
        guard b.count == size else { throw GPTError("read only \(b.count) bytes of GPT from file instead of expected \(size)") }
        // we need a CRC/zlib of the partition entries, so we do those first, then append the bytes
        let checksum = crc32IEEE(b)
        guard gptTable.partitionEntryChecksum == checksum else { throw GPTError("invalid EFI Partition Entry Checksum, expected \(checksum), got \(gptTable.partitionEntryChecksum)") }

        gptTable.partitions = readPartitionArrayBytes(b)
        return gptTable
    }

    /// The total size of the GPT in bytes, counted from the start of the MBR to the end of the backup header.
    func totalSize() -> UInt64 { (secondaryHeader &+ 1) &* UInt64(Self.sectorSize) }

    /// Changes the size of the GPT to `size` bytes, a multiple of the sector size: for a disk that is no longer the
    /// size its GPT says.
    func resize(_ size: UInt64) {
        // how many sectors on the disk?
        let diskSectors = size / UInt64(Self.sectorSize)

        secondaryHeader = diskSectors - 1
        lastDataSector = secondaryHeader - 1 - Self.partitionArraySectors
    }
}

/// One GPT partition entry.
final class GPTPartition {
    /// Index of the partition in the table, from 1.
    let index: Int
    /// Start sector.
    let start: UInt64
    /// End sector.
    var end: UInt64
    /// Partition type GUID.
    let type: UUID
    let name: String
    /// Partition GUID.
    let guid: UUID
    let attributes: UInt64

    init(index: Int, start: UInt64, end: UInt64, type: UUID, name: String, guid: UUID, attributes: UInt64) {
        self.index = index; self.start = start; self.end = end; self.type = type; self.name = name; self.guid = guid; self.attributes = attributes
    }

    /// The fixed size of a GPT partition entry.
    static let entrySize = 128

    /// The 128 bytes of this entry.
    func toBytes() -> [UInt8] {
        var b = [UInt8](repeating: 0, count: Self.entrySize)

        // partition type GUID is first 16 bytes
        b.replaceSubrange(0..<16, with: bytesToUUIDBytes(type.bytes))

        // partition identifier GUID is next 16 bytes
        b.replaceSubrange(16..<32, with: bytesToUUIDBytes(guid.bytes))

        // next is first LBA and last LBA, uint64 = 8 bytes each
        putLittleEndian64(&b, 32, start)
        putLittleEndian64(&b, 40, end)
        putLittleEndian64(&b, 48, attributes)

        // now the partition name - it is UTF16LE encoded, max 36 code units for 72 bytes (a name read from an entry
        // fits by construction)
        for (i, u) in name.utf16.enumerated() {
            let pos = 56 + i * 2
            b[pos] = UInt8(u & 0xff); b[pos + 1] = UInt8(u >> 8)
        }

        return b
    }

    /// The entry in `b`, numbered `index` (from 1); nil for an unused, all-zero entry.
    static func fromBytes(index: Int, _ b: [UInt8]) -> GPTPartition? {
        // is it all zeroes?
        if b[0..<16].allSatisfy({ $0 == 0 }) { return nil }
        let typeGUID = UUID(bytes: bytesToUUIDBytes(Array(b[0..<16])))
        let uid = UUID(bytes: bytesToUUIDBytes(Array(b[16..<32])))
        let firstLBA = littleEndian64(b, 32)
        let lastLBA = littleEndian64(b, 40)
        let attribs = littleEndian64(b, 48)

        // get the partition name
        var u: [UInt16] = []
        var i = 56
        while i < b.count {
            // strip any 0s off of the end
            let entry = UInt16(b[i]) | UInt16(b[i + 1]) << 8
            if entry == 0 { break }
            u.append(entry); i += 2
        }
        let name = String(decoding: u, as: UTF16.self)

        return GPTPartition(index: index, start: firstLBA, end: lastLBA, type: typeGUID, name: name, guid: uid, attributes: attribs)
    }

    /// Grows the partition by `sectors`.
    func expand(_ sectors: UInt64) {
        end += sectors
    }
}

struct GPTError: Error, CustomStringConvertible, Sendable {
    let description: String
    init(_ description: String) { self.description = description }
}

/// A disk image file, opened for reading and writing.
final class GPTDiskFile {
    private let handle: FileHandle
    init(_ url: URL) throws { handle = try FileHandle(forUpdating: url) }
    deinit { try? handle.close() }
    /// Up to `count` bytes at `offset`: fewer at the file's end.
    func readAt(_ count: Int, _ offset: UInt64) throws -> [UInt8] {
        try handle.seek(toOffset: offset)
        return Array(try handle.read(upToCount: count) ?? Data())
    }
    func writeAt(_ bytes: [UInt8], _ offset: UInt64) throws {
        try handle.seek(toOffset: offset)
        try handle.write(contentsOf: bytes)
    }
    func synchronize() throws { try handle.synchronize() }
}

/// Moves the first three fields of a GUID's bytes between GPT's mixed-endian order and big-endian order.
func bytesToUUIDBytes(_ input: [UInt8]) -> [UInt8] {
    // first 3 sections (4 bytes, 2 bytes, 2 bytes) are little-endian, last 2 section are big-endian
    var b = Array(input[0..<16])
    b[0..<4].reverse()
    b[4..<6].reverse()
    b[6..<8].reverse()
    return b
}

func crc32IEEE(_ bytes: [UInt8]) -> UInt32 { UInt32(bytes.withUnsafeBufferPointer { zlib.crc32(0, $0.baseAddress, uInt($0.count)) }) }

private func littleEndian32(_ b: [UInt8], _ offset: Int) -> UInt32 { (0..<4).reduce(UInt32(0)) { $0 | UInt32(b[offset + $1]) << (8 * $1) } }
private func littleEndian64(_ b: [UInt8], _ offset: Int) -> UInt64 { (0..<8).reduce(UInt64(0)) { $0 | UInt64(b[offset + $1]) << (8 * $1) } }
private func putLittleEndian32(_ b: inout [UInt8], _ offset: Int, _ value: UInt32) { for i in 0..<4 { b[offset + i] = UInt8(truncatingIfNeeded: value >> (8 * i)) } }
private func putLittleEndian64(_ b: inout [UInt8], _ offset: Int, _ value: UInt64) { for i in 0..<8 { b[offset + i] = UInt8(truncatingIfNeeded: value >> (8 * i)) } }

extension UUID {
    /// The 16 bytes in RFC 4122 (big-endian) order.
    var bytes: [UInt8] { withUnsafeBytes(of: uuid) { Array($0) } }
    init(bytes: [UInt8]) { self = bytes.withUnsafeBytes { UUID(uuid: $0.loadUnaligned(as: uuid_t.self)) } }
}
