import Foundation
import zlib

/// A GUID Partition Table read from and written to a disk file: the protective MBR, the primary header and partition
/// entry array, and the backup array and header at the disk's end, each with its CRC32. A sandbox's disk grows by
/// moving the backup to the new end (`resize`) and, on Linux, extending the last partition (`GPTPartition.expand`); a
/// macOS base drops its recovery partition (`RecoveryPartition.delete`).
public final class GPTTable {
    public var partitions: [GPTPartition]
    public var logicalSectorSize: Int
    public var physicalSectorSize: Int
    /// Disk GUID, blank to generate one.
    public var guid: String
    public var protectiveMBR: Bool
    /// How many entries the partition array holds.
    var partitionArraySize: Int
    /// The size of one entry in the array, usually 128 bytes.
    var partitionEntrySize: UInt32
    /// First LBA of the partition array.
    var partitionFirstLBA: UInt64
    var partitionEntryChecksum: UInt32
    /// LBA of the primary header, always 1.
    var primaryHeader: UInt64
    /// LBA of the backup header, always the disk's last sector.
    var secondaryHeader: UInt64
    var firstDataSector: UInt64
    var lastDataSector: UInt64
    var initialized: Bool

    public init(partitions: [GPTPartition] = [], logicalSectorSize: Int = 0, physicalSectorSize: Int = 0, guid: String = "", protectiveMBR: Bool = false) {
        self.partitions = partitions; self.logicalSectorSize = logicalSectorSize; self.physicalSectorSize = physicalSectorSize; self.guid = guid; self.protectiveMBR = protectiveMBR
        partitionArraySize = 0; partitionEntrySize = 0; partitionFirstLBA = 0; partitionEntryChecksum = 0; primaryHeader = 0; secondaryHeader = 0; firstDataSector = 0; lastDataSector = 0; initialized = false
    }

    init(partitionEntrySize: UInt32, primaryHeader: UInt64, secondaryHeader: UInt64, firstDataSector: UInt64, lastDataSector: UInt64, partitionArraySize: Int, partitionFirstLBA: UInt64, guid: String, partitionEntryChecksum: UInt32) {
        partitions = []; logicalSectorSize = 0; physicalSectorSize = 0; protectiveMBR = false; initialized = false
        self.partitionEntrySize = partitionEntrySize; self.primaryHeader = primaryHeader; self.secondaryHeader = secondaryHeader; self.firstDataSector = firstDataSector; self.lastDataSector = lastDataSector
        self.partitionArraySize = partitionArraySize; self.partitionFirstLBA = partitionFirstLBA; self.guid = guid; self.partitionEntryChecksum = partitionEntryChecksum
    }

    static let mbrPartitionEntriesStart = 446
    static let mbrPartitionEntriesCount = 4
    static let mbrPartitionEntrySize = 16
    // just defaults
    static let physicalSectorSize = 512
    static let logicalSectorSize = 512
    static let gptHeaderSector: UInt64 = 1

    static let efiSignature: [UInt8] = [0x45, 0x46, 0x49, 0x20, 0x50, 0x41, 0x52, 0x54]
    static let efiRevision: [UInt8] = [0x00, 0x00, 0x01, 0x00]
    static let efiHeaderSize: [UInt8] = [0x5c, 0x00, 0x00, 0x00]
    static let efiZeroes: [UInt8] = [0x00, 0x00, 0x00, 0x00]
    static let mbrSignature: [UInt8] = [0x55, 0xaa]

    /// Ensures a blank table is initialized.
    func initTable(_ size: Int64) {
        // default settings
        if logicalSectorSize == 0 { logicalSectorSize = 512 }
        if physicalSectorSize == 0 { physicalSectorSize = 512 }
        if primaryHeader == 0 { primaryHeader = 1 }
        if guid == "" { guid = UUID().uuidString }
        if partitionArraySize == 0 { partitionArraySize = 128 }
        if partitionEntrySize == 0 { partitionEntrySize = 128 }

        // how many sectors on the disk?
        let diskSectors = UInt64(size) / UInt64(logicalSectorSize)
        // how many sectors used for partition entries?
        let partSectors = UInt64(partitionArraySize) * UInt64(partitionEntrySize) / UInt64(logicalSectorSize)

        if firstDataSector == 0 { firstDataSector = 2 + partSectors }
        if secondaryHeader == 0 { secondaryHeader = diskSectors - 1 }
        if lastDataSector == 0 { lastDataSector = secondaryHeader - partSectors - 1 }

        initialized = true
    }

    /// Whether `table` is functionally equal to this one.
    func equal(_ other: GPTTable?) -> Bool {
        guard let other else { return false }
        let basicMatch = logicalSectorSize == other.logicalSectorSize && physicalSectorSize == other.physicalSectorSize && partitionEntrySize == other.partitionEntrySize &&
            primaryHeader == other.primaryHeader && secondaryHeader == other.secondaryHeader && firstDataSector == other.firstDataSector && lastDataSector == other.lastDataSector &&
            partitionArraySize == other.partitionArraySize && protectiveMBR == other.protectiveMBR && guid == other.guid
        let partMatch = partitions.count == other.partitions.count && zip(partitions, other.partitions).allSatisfy { ($0.type == .unused && $1.type == .unused) || $0 == $1 }
        return basicMatch && partMatch
    }

    /// Whether `b` holds a protective MBR covering `sectors`.
    static func readProtectiveMBR(_ b: [UInt8], sectors: UInt32) -> Bool {
        let size = b.count
        guard size >= 512 else { return false }
        // check for MBR signature
        guard Array(b[(size - 2)...]) == mbrSignature else { return false }
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
        return secondaryHeader - UInt64(partitionArraySize) * UInt64(partitionEntrySize) / UInt64(logicalSectorSize)
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

    /// The bytes of the partition array.
    func toPartitionArrayBytes() throws -> [UInt8] {
        let blocksize = UInt64(logicalSectorSize)

        // go through the partitions, make sure Start/End/Size are correct, and each has a GUID.
        // In addition, the Partition slice could be in order, or not, e.g. it might have partitions 1,3,4,7 only, yet the
        // slice will have 4 positions. Or it could be out of order. So we need to write out the partition entries in
        // order, and fill in blanks.
        var partMap: [Int: GPTPartition] = [:]
        for (i, part) in partitions.enumerated() {
            do { try part.initEntry(blocksize) } catch { throw GPTError("could not initialize partition \(i) correctly: \(error)") }
            if part.index < 1 || part.index > partitionArraySize {
                throw GPTError("partition \(i) has invalid index \(part.index) for partition array size \(partitionArraySize)")
            }
            if partMap[part.index] != nil { throw GPTError("duplicate partition index \(part.index) found") }
            partMap[part.index] = part
        }

        // generate the partition bytes
        let partSize = Int(partitionEntrySize) * partitionArraySize
        var bpart = [UInt8](repeating: 0, count: partSize)
        for i in 0..<partitionArraySize {
            // unused partition
            guard let p = partMap[i + 1] else { continue }
            // write the primary partition entry
            let b2: [UInt8]
            do { b2 = try p.toBytes() } catch { throw GPTError("error preparing partition entry \(i) for writing to disk: \(error)") }
            let slotStart = i * Int(partitionEntrySize)
            bpart.replaceSubrange(slotStart..<(slotStart + b2.count), with: b2)
        }
        return bpart
    }

    /// Just the GPT header, as bytes.
    func toGPTBytes(_ primary: Bool) throws -> [UInt8] {
        var b = [UInt8](repeating: 0, count: logicalSectorSize)

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
        let diskGUID: UUID
        if guid == "" { diskGUID = UUID() } else {
            guard let parsed = UUID(uuidString: guid) else { throw GPTError("invalid UUID: \(guid)") }
            diskGUID = parsed
        }
        b.replaceSubrange(56..<72, with: bytesToUUIDBytes(diskGUID.bytes))

        // starting LBA of array of partition entries
        putLittleEndian64(&b, 72, partitionArraySector(primary))

        // how many entries?
        putLittleEndian32(&b, 80, UInt32(partitionArraySize))
        // how big is a single entry?
        putLittleEndian32(&b, 84, 0x80)

        // we need a CRC/zlib of the partition entries, so we do those first, then append the bytes
        let bpart: [UInt8]
        do { bpart = try toPartitionArrayBytes() } catch { throw GPTError("error converting partition array to bytes: \(error)") }
        putLittleEndian32(&b, 88, crc32IEEE(bpart))

        // calculate checksum of entire header and place 4 bytes of offset 16 = 0x10
        putLittleEndian32(&b, 16, crc32IEEE(Array(b[0..<92])))

        // zeroes to the end of the sector
        for i in 92..<logicalSectorSize { b[i] = 0x00 }

        return b
    }

    func calculatePartitionArrayLocations() -> (start: Int, size: Int) {
        (Int(partitionFirstLBA) * logicalSectorSize, partitionArraySize * Int(partitionEntrySize))
    }

    /// The partitions in the bytes of a partition array.
    static func readPartitionArrayBytes(_ b: [UInt8], entrySize: Int, logicalSectorSize: Int, physicalSectorSize: Int) throws -> [GPTPartition] {
        var parts: [GPTPartition] = []
        var i = 0, offset = 0
        while b.count - offset >= entrySize {
            let bpart = Array(b[offset..<(offset + entrySize)])
            // write the primary partition entry
            let p: GPTPartition?
            do { p = try GPTPartition.fromBytes(index: i + 1, bpart, logicalSectorSize: logicalSectorSize, physicalSectorSize: physicalSectorSize) } catch { throw GPTError("error reading partition entry \(i): \(error)") }
            offset += entrySize; i += 1
            guard let p else { continue }
            // augment partition information
            p.size = (p.end - p.start + 1) * UInt64(logicalSectorSize)
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

        return GPTTable(partitionEntrySize: partitionEntrySize, primaryHeader: primaryHeader, secondaryHeader: secondaryHeader, firstDataSector: firstDataSector, lastDataSector: lastDataSector,
                        partitionArraySize: Int(partitionEntryCount), partitionFirstLBA: partitionEntryFirstLBA, guid: diskGUID.uuidString, partitionEntryChecksum: partitionEntryChecksum)
    }

    /// The partition table in `b`.
    static func tableFromBytes(_ b: [UInt8], logicalBlockSize: Int, physicalBlockSize: Int) throws -> GPTTable {
        // minimum size - gpt entries + header + LBA0 for (protective) MBR
        guard b.count >= logicalBlockSize * 2 else { throw GPTError("data for partition was \(b.count) bytes instead of expected minimum \(logicalBlockSize * 2)") }

        // GPT starts at LBA1
        let table = try readGPTHeader(Array(b[logicalBlockSize...]))

        // potential protective MBR is at LBA0
        table.protectiveMBR = readProtectiveMBR(Array(b[..<logicalBlockSize]), sectors: UInt32(clamping: table.secondaryHeader))
        table.logicalSectorSize = logicalBlockSize
        table.physicalSectorSize = physicalBlockSize
        table.initialized = true

        return table
    }

    /// Writes the table to a disk of `size` bytes: the protective MBR (if any), the primary header and array, then the
    /// backup array and header.
    public func write(_ f: any GPTBackingFile, size: Int64) throws {
        // it is possible that we are given a basic new table that we need to initialize
        if !initialized { initTable(size) }

        // write the protectiveMBR if any
        // write the primary GPT header
        // write the primary partition array
        // write the secondary partition array
        // write the secondary GPT header
        var written: Int
        if protectiveMBR {
            let fullMBR = generateProtectiveMBR()
            let protectiveMBR = Array(fullMBR[Self.mbrPartitionEntriesStart...])
            do { written = try f.writeAt(protectiveMBR, Int64(Self.mbrPartitionEntriesStart)) } catch { throw GPTError("error writing protective MBR to disk: \(error)") }
            guard written == protectiveMBR.count else { throw GPTError("wrote \(written) bytes of protective MBR instead of \(protectiveMBR.count)") }
        }

        let primaryHeader: [UInt8]
        do { primaryHeader = try toGPTBytes(true) } catch { throw GPTError("error converting primary GPT header to byte array: \(error)") }
        do { written = try f.writeAt(primaryHeader, Int64(logicalSectorSize)) } catch { throw GPTError("error writing primary GPT to disk: \(error)") }
        guard written == primaryHeader.count else { throw GPTError("wrote \(written) bytes of primary GPT header instead of \(primaryHeader.count)") }

        let partitionArray: [UInt8]
        do { partitionArray = try toPartitionArrayBytes() } catch { throw GPTError("error converting primary GPT partitions to byte array: \(error)") }
        do { written = try f.writeAt(partitionArray, Int64(logicalSectorSize * Int(partitionArraySector(true)))) } catch { throw GPTError("error writing primary partition arrayto disk: \(error)") }
        guard written == partitionArray.count else { throw GPTError("wrote \(written) bytes of primary partition array instead of \(primaryHeader.count)") }

        do { written = try f.writeAt(partitionArray, Int64(logicalSectorSize) * Int64(partitionArraySector(false))) } catch { throw GPTError("error writing secondary partition array to disk: \(error)") }
        guard written == partitionArray.count else { throw GPTError("wrote \(written) bytes of secondary partition array instead of \(primaryHeader.count)") }

        let secondaryHeader: [UInt8]
        do { secondaryHeader = try toGPTBytes(false) } catch { throw GPTError("error converting secondary GPT header to byte array: \(error)") }
        do { written = try f.writeAt(secondaryHeader, Int64(self.secondaryHeader) * Int64(logicalSectorSize)) } catch { throw GPTError("error writing secondary GPT to disk: \(error)") }
        guard written == secondaryHeader.count else { throw GPTError("wrote \(written) bytes of secondary GPT header instead of \(secondaryHeader.count)") }
    }

    /// Reads a partition table from a disk with the given logical and physical block sizes; throws at any stage that
    /// fails reading the disk or taking its bytes as a GPT.
    public static func read(_ f: any GPTBackingFile, logicalBlockSize: Int, physicalBlockSize: Int) throws -> GPTTable {
        // read the data off of the disk - first block is the compatibility MBR, second is the GPT table
        var b: [UInt8]
        do { b = try f.readAt(logicalBlockSize * 2, 0) } catch { throw GPTError("error reading GPT from file: \(error)") }
        guard b.count == logicalBlockSize * 2 else { throw GPTError("read only \(b.count) bytes of GPT from file instead of expected \(logicalBlockSize * 2)") }
        // get the gpt table
        let gptTable: GPTTable
        do { gptTable = try tableFromBytes(b, logicalBlockSize: logicalBlockSize, physicalBlockSize: physicalBlockSize) } catch { throw GPTError("error reading GPT table: \(error)") }
        let (start, size) = gptTable.calculatePartitionArrayLocations()
        do { b = try f.readAt(size, Int64(start)) } catch { throw GPTError("error reading partitions from file: \(error)") }
        guard b.count == size else { throw GPTError("read only \(b.count) bytes of GPT from file instead of expected \(size)") }
        // we need a CRC/zlib of the partition entries, so we do those first, then append the bytes
        let checksum = crc32IEEE(b)
        guard gptTable.partitionEntryChecksum == checksum else { throw GPTError("invalid EFI Partition Entry Checksum, expected \(checksum), got \(gptTable.partitionEntryChecksum)") }

        do { gptTable.partitions = try readPartitionArrayBytes(b, entrySize: Int(gptTable.partitionEntrySize), logicalSectorSize: logicalBlockSize, physicalSectorSize: physicalBlockSize) } catch {
            throw GPTError("error parsing partition data: \(error)")
        }
        return gptTable
    }

    /// The total size of the GPT in bytes, counted from the start of the MBR to the end of the backup header.
    public func totalSize() -> UInt64 { (secondaryHeader + Self.gptHeaderSector) * UInt64(logicalSectorSize) }

    public func lastUsableSector() -> UInt64 { lastDataSector }

    /// Changes the size of the GPT to `size` bytes, a multiple of the logical sector size: for a disk that is no
    /// longer the size its GPT says.
    public func resize(_ size: UInt64) {
        // how many sectors on the disk?
        let diskSectors = size / UInt64(logicalSectorSize)
        // how many sectors used for partition entries?
        let partSectors = UInt64(partitionArraySize) * UInt64(partitionEntrySize) / UInt64(logicalSectorSize)

        secondaryHeader = diskSectors - 1
        lastDataSector = secondaryHeader - 1 - partSectors
    }
}

/// One GPT partition entry.
public final class GPTPartition: Equatable {
    /// Index of the partition in the table, from 1.
    public var index: Int
    /// Start sector.
    public var start: UInt64
    /// End sector.
    public var end: UInt64
    /// Size in bytes.
    public var size: UInt64
    public var type: GPTPartitionType
    public var name: String
    /// Partition GUID, blank to generate one.
    public var guid: String
    public var attributes: UInt64
    var logicalSectorSize: Int
    var physicalSectorSize: Int

    public init(index: Int, start: UInt64, end: UInt64 = 0, size: UInt64 = 0, type: GPTPartitionType = .unused, name: String = "", guid: String = "", attributes: UInt64 = 0, logicalSectorSize: Int = 0, physicalSectorSize: Int = 0) {
        self.index = index; self.start = start; self.end = end; self.size = size; self.type = type; self.name = name; self.guid = guid; self.attributes = attributes
        self.logicalSectorSize = logicalSectorSize; self.physicalSectorSize = physicalSectorSize
    }

    /// The fixed size of a GPT partition entry.
    public static let entrySize = 128

    public static func == (a: GPTPartition, b: GPTPartition) -> Bool {
        a.index == b.index && a.start == b.start && a.end == b.end && a.size == b.size && a.type == b.type && a.name == b.name && a.guid == b.guid && a.attributes == b.attributes
            && a.logicalSectorSize == b.logicalSectorSize && a.physicalSectorSize == b.physicalSectorSize
    }

    /// The 128 bytes of this entry.
    func toBytes() throws -> [UInt8] {
        var b = [UInt8](repeating: 0, count: Self.entrySize)

        // if the Type is Unused, just return all zeroes
        if type == .unused { return b }

        // partition type GUID is first 16 bytes
        guard let typeGUID = UUID(uuidString: type.rawValue) else { throw GPTError("unable to parse partition type GUID: \(type.rawValue)") }
        b.replaceSubrange(0..<16, with: bytesToUUIDBytes(typeGUID.bytes))

        // partition identifier GUID is next 16 bytes
        guard let idGUID = UUID(uuidString: guid) else { throw GPTError("unable to parse partition identifier GUID: \(guid)") }
        b.replaceSubrange(16..<32, with: bytesToUUIDBytes(idGUID.bytes))

        // next is first LBA and last LBA, uint64 = 8 bytes each
        putLittleEndian64(&b, 32, start)
        putLittleEndian64(&b, 40, end)
        putLittleEndian64(&b, 48, attributes)

        // now the partition name - it is UTF16LE encoded, max 36 code units for 72 bytes
        let r = Array(name.unicodeScalars)
        guard r.count <= 36, name.utf16.count <= 36 else { throw GPTError("cannot use \(name) as partition name, has \(r.count) Unicode code units, maximum size is 36") }
        // next convert the runes to uint16, and then to little-endian bytes
        for (i, u) in name.utf16.enumerated() {
            let pos = 56 + i * 2
            b[pos] = UInt8(u & 0xff); b[pos + 1] = UInt8(u >> 8)
        }

        return b
    }

    /// The entry in `b`, numbered `index` (from 1); nil for an unused, all-zero entry.
    static func fromBytes(index: Int, _ b: [UInt8], logicalSectorSize: Int, physicalSectorSize: Int) throws -> GPTPartition? {
        guard b.count == entrySize else { throw GPTError("data for partition was \(b.count) bytes instead of expected \(entrySize)") }
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

        return GPTPartition(index: index, start: firstLBA, end: lastLBA, type: GPTPartitionType(rawValue: typeGUID.uuidString), name: name, guid: uid.uuidString, attributes: attribs,
                            logicalSectorSize: logicalSectorSize, physicalSectorSize: physicalSectorSize)
    }

    /// Adjusts the start, end and size and ensures it has a GUID.
    func initEntry(_ blocksize: UInt64) throws {
        if type == .unused { return }
        if guid == "" { guid = UUID().uuidString } else {
            guard let parsed = UUID(uuidString: guid) else { throw GPTError("invalid UUID: \(guid)") }
            guid = parsed.uuidString
        }

        // check size matches sectors
        // valid possibilities:
        // 1- size=0, start>=0, end>start - valid - begin at start, go until end
        // 2- size>0, start>=0, end=0 - valid - begin at start for size bytes
        // 3- size>0, start=0, end=0 - valid - begin at end of previous partition, go for size bytes
        // anything else is an error
        let calculatedSize = end >= start ? (end - start + 1) * blocksize : nil
        switch true {
        case start == 0:
            // neither start nor end specified, we cannot do anything with it
            throw GPTError("invalid partition entry, start sector is 0")
        case end >= start && size == calculatedSize: break
        case size == 0 && end >= start:
            // provided specific start and end, so calculate size
            size = calculatedSize!
        case size > 0 && size % blocksize == 0 && start > 0 && end == 0:
            // provided specific start and size, so calculate end
            end = start + size / blocksize - 1
        default:
            throw GPTError("invalid partition entry, size \(size) bytes does not match start sector \(start) and end sector \(end)")
        }
    }

    /// Grows the partition by `sectors`.
    public func expand(_ sectors: UInt64) {
        end += sectors
        size += sectors * UInt64(logicalSectorSize)
    }
}

/// A partition type GUID.
public struct GPTPartitionType: RawRepresentable, Equatable, Sendable {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public static let unused = GPTPartitionType(rawValue: "00000000-0000-0000-0000-000000000000")
    public static let efiSystemPartition = GPTPartitionType(rawValue: "C12A7328-F81F-11D2-BA4B-00A0C93EC93B")
    public static let linuxFilesystem = GPTPartitionType(rawValue: "0FC63DAF-8483-4772-8E79-3D69D8477DE4")
    public static let appleAPFS = GPTPartitionType(rawValue: "7C3457EF-0000-11AA-AA11-00306543ECAC")
}

public struct GPTError: Error, CustomStringConvertible, Sendable {
    public let description: String
    init(_ description: String) { self.description = description }
}

/// A disk the table reads and writes at byte offsets; a read may return fewer bytes than asked, as at the file's end.
public protocol GPTBackingFile {
    func readAt(_ count: Int, _ offset: Int64) throws -> [UInt8]
    func writeAt(_ bytes: [UInt8], _ offset: Int64) throws -> Int
}

/// A disk image file, opened for reading and writing.
public final class GPTDiskFile: GPTBackingFile {
    private let handle: FileHandle
    public init(_ url: URL) throws { handle = try FileHandle(forUpdating: url) }
    deinit { try? handle.close() }
    public func readAt(_ count: Int, _ offset: Int64) throws -> [UInt8] {
        try handle.seek(toOffset: UInt64(offset))
        return Array(try handle.read(upToCount: count) ?? Data())
    }
    public func writeAt(_ bytes: [UInt8], _ offset: Int64) throws -> Int {
        try handle.seek(toOffset: UInt64(offset))
        try handle.write(contentsOf: bytes)
        return bytes.count
    }
    public func synchronize() throws { try handle.synchronize() }
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
