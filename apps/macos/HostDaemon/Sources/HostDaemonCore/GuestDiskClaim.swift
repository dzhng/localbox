import Foundation

/// The guest's side of a grown disk: after boot, its filesystem takes the space the host added (`DiskGrowth`), driven
/// through the agent's root shell. Run until it succeeds; running it again when there is nothing to claim changes
/// nothing on Linux, and macOS is only asked when its GPT shows unclaimed space.
public enum GuestDiskClaim {
    /// Runs a script as root in the guest: its stdout, or a throw with its output when it exits non-zero.
    public typealias RootShell = @Sendable (_ script: String, _ timeout: TimeInterval) async throws -> String

    public static func claim(_ os: GuestOS, _ root: RootShell) async throws {
        switch os {
        case .linux: try await claimLinux(root)
        case .macos: try await claimMacOS(root)
        }
    }

    /// The mounted ext4 root grows online to fill its partition, which the host already extended.
    static func claimLinux(_ root: RootShell) async throws {
        _ = try await root(#"resize2fs "$(findmnt -n -o SOURCE /)""#, 110)
    }

    /// The APFS container grows to the disk's end: `repairDisk` first, which moves the GPT's backup header to the end
    /// of the grown disk, then `resizeContainer` with size 0 (all the space after it).
    static func claimMacOS(_ root: RootShell) async throws {
        // Determine the disk and a partition to act on
        let list = try await root("diskutil list -plist physical", 60)

        let (diskName, partitionName): (String, String)
        do { (diskName, partitionName) = try parseDiskUtilPlistOutput(Data(list.utf8)) } catch {
            throw HostDaemonError.unsupported("failed to parse \"diskutil list -plist physical\" output: \(error)")
        }

        // Freeing space...
        _ = try await root("yes | diskutil repairDisk \(diskName)", 110)

        // Resizing the partition...
        _ = try await root("diskutil apfs resizeContainer \(partitionName) 0", 110)
    }

    static let expectedPartitionContent = "Apple_APFS"

    struct DiskUtilOutput: Decodable {
        let allDisksAndPartitions: [DiskWithPartitions]?
        enum CodingKeys: String, CodingKey { case allDisksAndPartitions = "AllDisksAndPartitions" }
    }

    struct DiskWithPartitions: Decodable {
        let deviceIdentifier: String?
        let partitions: [Partition]?
        enum CodingKeys: String, CodingKey { case deviceIdentifier = "DeviceIdentifier", partitions = "Partitions" }
    }

    struct Partition: Decodable {
        let deviceIdentifier: String?
        let content: String?
        enum CodingKeys: String, CodingKey { case deviceIdentifier = "DeviceIdentifier", content = "Content" }
    }

    /// Parses `diskutil list -plist` output, makes sure there's only one disk on the system with an APFS partition and
    /// returns its name and the name of that partition, or throws otherwise.
    static func parseDiskUtilPlistOutput(_ input: Data) throws -> (disk: String, partition: String) {
        let diskUtilOutput: DiskUtilOutput
        do { diskUtilOutput = try PropertyListDecoder().decode(DiskUtilOutput.self, from: input) } catch {
            throw HostDaemonError.unsupported("failed to parse \"diskutil list -plist\" output: \(error)")
        }

        struct Candidate { let diskName: String; let partitionName: String }

        var candidates: [Candidate] = []

        for diskWithPartitions in diskUtilOutput.allDisksAndPartitions ?? [] {
            for partition in diskWithPartitions.partitions ?? [] {
                guard partition.content == expectedPartitionContent else { continue }

                candidates.append(Candidate(diskName: diskWithPartitions.deviceIdentifier ?? "", partitionName: partition.deviceIdentifier ?? ""))
            }
        }

        if candidates.isEmpty {
            throw HostDaemonError.unsupported("found no disks on which the partition's \"Content\" is \"\(expectedPartitionContent)\", make sure that the macOS is installed")
        }

        if candidates.count > 1 {
            throw HostDaemonError.unsupported("found more than one disk on which the partition's \"Content\" is \"\(expectedPartitionContent)\", please only mount a single disk that contains APFS partitions otherwise it's hard to tell on which disk the macOS is installed")
        }

        return (candidates[0].diskName, candidates[0].partitionName)
    }
}
