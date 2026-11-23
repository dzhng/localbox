import Foundation

/// A macOS guest's recovery container, `disk0s3` (`Apple_APFS_Recovery`), named `RecoveryOSContainer` in the GPT. It
/// sits right after the main APFS container and so stops it from growing. Localbox boots Recovery only once, in a
/// base build's `sip` step, so the build drops it before the base becomes an image.
public enum RecoveryPartition {
    public static let name = "RecoveryOSContainer"

    /// With the VM off, removes the recovery partition from `disk`'s GPT when it is the last entry. Returns whether it
    /// removed one; a disk without one (already deleted) is left as it is. Refuses two recovery partitions, or one
    /// that is not last.
    @discardableResult
    public static func delete(_ disk: URL) throws -> Bool {
        // Open the disk image and read its partition table
        let file: GPTDiskFile
        do { file = try GPTDiskFile(disk) } catch { throw GPTError("failed to open the disk image: \(error)") }

        let gptTable: GPTTable
        do { gptTable = try GPTTable.read(file) } catch {
            throw GPTError("failed to get the partition table: \(error)")
        }

        var recoveryPartitionIdx = -1

        for (idx, partition) in gptTable.partitions.enumerated() {
            guard partition.name == name else { continue }

            if recoveryPartitionIdx != -1 {
                throw GPTError("found a recovery partition at GPT entry \(idx + 1), but there's another recovery partition at GPT entry \(recoveryPartitionIdx + 1), refusing to proceed")
            }

            recoveryPartitionIdx = idx
        }

        // No recovery partition was found, assuming that it was already deleted.
        if recoveryPartitionIdx == -1 { return false }

        if recoveryPartitionIdx != gptTable.partitions.count - 1 {
            throw GPTError("found a recovery partition at GPT entry \(recoveryPartitionIdx + 1), but it's not the last partition on the disk, refusing to proceed")
        }

        gptTable.partitions = Array(gptTable.partitions[..<recoveryPartitionIdx])

        do {
            try gptTable.write(file)
            try file.synchronize()
        } catch { throw GPTError("failed to write the new partition table: \(error)") }

        return true
    }
}
