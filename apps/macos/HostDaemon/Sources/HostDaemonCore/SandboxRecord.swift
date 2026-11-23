import Foundation

/// What a sandbox was doing when its record was last written, so the next daemon start knows what to bring back:
/// `running` and `hibernated` (taken down by SIGTERM or the host's power) come back at start; `sleeping` (asleep in
/// memory, lost with the daemon) and `asleep` (down until used: a saved state, or a cold boot owed) wait for a request.
public enum SavedLifecycle: String, Codable, Sendable {
    case running, sleeping, asleep, stopped, hibernated
}

/// The image every Mac has, built into the release (the contract's `BUILT_IN_IMAGE`).
public let builtInImage = "linux"

/// One sandbox on this Mac, as `<sandboxes>/<id>/sandbox.json`: the catalog identity Convex owns (id, name) mirrored
/// read-only, plus the runtime this daemon owns (image, size, MAC, machine identifier, lifecycle).
public struct SandboxRecord: Codable, Equatable, Sendable {
    public let sandboxID: String
    public var name: String
    /// The image it was created from, and that image's OS, which `provision` sets. The sandbox keeps its own disk and
    /// boot store, so the image may be deleted afterwards.
    public let imageID: String
    public var os: GuestOS
    public var cpus: Int
    public var memoryBytes: UInt64
    /// The disk's size: its image's, or more. Like the CPUs and memory it takes effect at a cold boot, which grows the
    /// disk file to it first (`SandboxBackendFactory.growDisk`); a disk never shrinks.
    public var diskBytes: UInt64
    /// The host grew the disk and the guest has not yet grown its filesystem into it (`GuestDiskClaim`): tried after
    /// each boot until it succeeds.
    public var diskClaimPending: Bool
    /// Locally administered NAT MAC and base64 machine identifier (`VZGenericMachineIdentifier` for Linux,
    /// `VZMacMachineIdentifier` for macOS); written once, so a saved state restores.
    public var mac: String?
    public var machineIdentifier: String?
    /// Base64 `VZMacHardwareModel`, copied from a macOS image at create so the sandbox outlives its image.
    public var hardwareModel: String?
    public var lifecycle: SavedLifecycle
    public var lastActivityAt: Date?
    /// Why the next start must cold-boot instead of restoring (a failed save, or a backend that cannot save).
    public var coldBootPending: String?
    /// False once the account catalog stops listing it (deleted while this Mac was offline, or signed out): the disk
    /// stays, but no request reaches it until a catalog lists it again.
    public var inCatalog: Bool
    /// The machine id whose catalog last listed it. Only that machine's catalog may delete it by leaving it out, so a
    /// push older than its reservation, or another sign-in's catalog, never deletes a disk.
    public var listedBy: String?
    /// The idle policy, mirrored from the account catalog: sleep after this much idle time, and delete after this
    /// much (nil: never).
    public var sleepAfterMs: Int
    public var deleteAfterMs: Int?
    /// `diskBytes` 0 asks for the image's size, which provisioning fills in.
    public init(sandboxID: String, name: String, imageID: String, cpus: Int, memoryBytes: UInt64, diskBytes: UInt64 = 0, sleepAfterMs: Int, lifecycle: SavedLifecycle = .stopped, inCatalog: Bool = true) {
        self.sandboxID = sandboxID; self.name = name; self.imageID = imageID; self.os = .linux; self.cpus = cpus; self.memoryBytes = memoryBytes; self.diskBytes = diskBytes; self.diskClaimPending = false
        self.sleepAfterMs = sleepAfterMs; self.lifecycle = lifecycle; self.inCatalog = inCatalog
    }
    enum CodingKeys: String, CodingKey {
        case sandboxID = "sandbox_id", name, imageID = "image_id", os, cpus, memoryBytes = "memory_bytes", diskBytes = "disk_bytes", diskClaimPending = "disk_claim_pending", mac, machineIdentifier = "machine_identifier", hardwareModel = "hardware_model", lifecycle
        case lastActivityAt = "last_activity_at", coldBootPending = "cold_boot_pending", inCatalog = "in_catalog", listedBy = "listed_by"
        case sleepAfterMs = "sleep_after_ms", deleteAfterMs = "delete_after_ms"
    }
}

/// `machinePaths().sandboxes/<id>/` and the files in it.
public struct SandboxDirectory: Sendable {
    public let url: URL
    public init(_ url: URL) { self.url = url }
    public var recordFile: URL { url.appendingPathComponent("sandbox.json") }
    public var disk: URL { url.appendingPathComponent("disk.img") }
    public var savedState: URL { url.appendingPathComponent("state.vzsave") }
    public var consoleLog: URL { url.appendingPathComponent("console.log") }
    /// The sandbox's own copy of its image's boot store: the EFI variable store, or a macOS guest's auxiliary storage.
    public func bootStore(for os: GuestOS) -> URL { url.appendingPathComponent(os.bootStoreName) }
    /// The process fixture's filesystem root.
    public var guestRoot: URL { url.appendingPathComponent("root", isDirectory: true) }

    public func load() throws -> SandboxRecord {
        let decoder = JSONDecoder(); decoder.dateDecodingStrategy = .iso8601
        return try decoder.decode(SandboxRecord.self, from: Data(contentsOf: recordFile))
    }

    /// Writes into the directory `sandbox.create` laid down; never creates it, so a write after a delete fails.
    public func save(_ record: SandboxRecord) throws {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]; encoder.dateEncodingStrategy = .iso8601
        try encoder.encode(record).write(to: recordFile, options: .atomic)
    }

    /// Where a save is written before it replaces `savedState`, so a failed save never leaves a partial state there.
    func temporarySave() -> URL { url.appendingPathComponent(".save-\(UUID().uuidString).vzvmsave") }

    /// Removes saves a crash left half-written.
    func removeTemporarySaves() {
        for name in (try? FileManager.default.contentsOfDirectory(atPath: url.path)) ?? [] where name.hasPrefix(".save-") && name.hasSuffix(".vzvmsave") {
            try? FileManager.default.removeItem(at: url.appendingPathComponent(name))
        }
    }

    /// What deleting this directory removes, for the delete report.
    func contents() -> [String] {
        [(recordFile, "sandbox identity"), (disk, "disk"), (bootStore(for: .linux), "boot store"), (bootStore(for: .macos), "boot store"), (savedState, "saved state"), (guestRoot, "guest root")]
            .filter { FileManager.default.fileExists(atPath: $0.0.path) }.map(\.1)
    }
}

/// A random locally administered unicast MAC, the kind `VZMACAddress.randomLocallyAdministered()` makes.
func randomLocalMAC() -> String {
    var bytes = (0..<6).map { _ in UInt8.random(in: 0...255) }
    bytes[0] = (bytes[0] & 0xFC) | 0x02
    return bytes.map { String(format: "%02x", $0) }.joined(separator: ":")
}
