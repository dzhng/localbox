import Foundation

/// A sandbox's or image's disk made bigger on the host, with no VM running on it. The file grows (it stays sparse, so
/// the new space costs nothing until the guest writes it); a Linux disk's GPT is then rewritten so its backup sits at
/// the new end and its last partition, the root, fills the disk. The guest grows its filesystem at its next boot
/// (`GuestDiskClaim`). A macOS disk keeps its GPT: in the guest, `diskutil repairDisk` moves the backup header.
public enum DiskGrowth {
    /// A requested size rounds up to a whole mebibyte, so every disk is whole sectors and its partitions stay aligned.
    public static let granularity: UInt64 = 1 << 20

    public static func rounded(_ bytes: UInt64) -> UInt64 { (bytes + granularity - 1) / granularity * granularity }

    /// The disk's size: its file's length, not what it holds on disk.
    public static func size(_ disk: URL) throws -> UInt64 {
        guard let length = (try FileManager.default.attributesOfItem(atPath: disk.path)[.size] as? NSNumber)?.uint64Value else {
            throw HostDaemonError.invalidState("could not read the size of \(disk.path)")
        }
        return length
    }

    /// The disk size a sandbox from an image of `imageBytes` gets when it asks for `requested` bytes (nil: none): the
    /// image's, or the request rounded up; below the image's is refused.
    public static func sandboxSize(requested: UInt64?, image: String, imageBytes: UInt64) throws -> UInt64 {
        guard let requested, requested != imageBytes else { return imageBytes }
        guard requested > imageBytes else { throw DiskBelowImage(image: image, imageBytes: imageBytes, requested: requested) }
        return rounded(requested)
    }

    /// Grows `disk` to `bytes` for a guest of `os`, with no VM running on it. Returns whether the guest now has space
    /// its filesystem does not reach. A disk already that size is left as it is, except that a Linux GPT a grow left
    /// short is finished and a macOS container short of its disk's end is reported, so an interrupted grow is completed
    /// at the next boot. A smaller size is refused: a disk never shrinks.
    @discardableResult
    public static func grow(_ disk: URL, to bytes: UInt64, os: GuestOS) throws -> Bool {
        let grew = try growDisk(bytes, disk)
        switch os {
        case .linux: return try extendLastPartition(disk) || grew
        case .macos: return try grew || hasUnclaimedSpace(disk)
        }
    }

    static func growDisk(_ desiredSizeInBytes: UInt64, _ diskImagePath: URL) throws -> Bool {
        let size = try size(diskImagePath)
        if size > desiredSizeInBytes { throw HostDaemonError.invalidState("the disk is \(gibibytes(size)), larger than \(gibibytes(desiredSizeInBytes)); a disk only grows") }
        if size == desiredSizeInBytes { return false }
        try FileHandle(forWritingTo: diskImagePath).truncate(atOffset: desiredSizeInBytes)
        return true
    }

    /// Moves `disk`'s backup GPT to the disk's end and extends the partition that ends last (the root) to the last
    /// usable sector. Returns whether it changed the table; a table whose backup is at the end and whose root stops
    /// short of it by no more than `granularity` (the built-in image's alignment slack) is not written.
    static func extendLastPartition(_ disk: URL) throws -> Bool {
        let file = try GPTDiskFile(disk)
        let table: GPTTable
        do { table = try GPTTable.read(file, logicalBlockSize: GPTTable.logicalSectorSize, physicalBlockSize: GPTTable.physicalSectorSize) } catch { throw GPTError("failed to get the partition table: \(error)") }
        let size = try size(disk)
        guard let last = table.partitions.max(by: { $0.end < $1.end }) else { throw GPTError("the disk has no partition to grow") }
        let atEnd = table.totalSize() == size
        table.resize(size)
        let short = last.end < table.lastUsableSector() && (table.lastUsableSector() - last.end) * UInt64(table.logicalSectorSize) > granularity
        guard !atEnd || short else { return false }
        if last.end < table.lastUsableSector() { last.expand(table.lastUsableSector() - last.end) }
        do { try table.write(file, size: Int64(size)); try file.synchronize() } catch { throw GPTError("failed to write the new partition table: \(error)") }
        return true
    }

    /// Whether a macOS disk has space its APFS container does not reach yet: its file grew past the backup GPT
    /// header, or its last partition ends more than a mebibyte before the last usable sector (a recovery
    /// partition just deleted). Read with the VM off.
    public static func hasUnclaimedSpace(_ disk: URL) throws -> Bool {
        let file = try GPTDiskFile(disk)
        let table = try GPTTable.read(file, logicalBlockSize: GPTTable.logicalSectorSize, physicalBlockSize: GPTTable.physicalSectorSize)
        let sectors = try size(disk) / UInt64(table.logicalSectorSize)
        if table.secondaryHeader != sectors - 1 { return true }
        let lastEnd = table.partitions.map(\.end).max() ?? 0
        return table.lastUsableSector() > lastEnd && (table.lastUsableSector() - lastEnd) * UInt64(table.logicalSectorSize) > granularity
    }
}

/// A sandbox asked for a disk smaller than its image's, which is the least a sandbox from it gets.
public struct DiskBelowImage: Error, CustomStringConvertible, Sendable {
    public let image: String, imageBytes: UInt64, requested: UInt64
    public var description: String { "image \(image)'s disk is \(gibibytes(imageBytes)), the least a sandbox from it gets, and \(gibibytes(requested)) was asked for" }
}
