import Foundation
#if canImport(Darwin)
import Darwin
#endif

private let gib: UInt64 = 1024 * 1024 * 1024

/// A new sandbox's size when none is asked for: half the cores and a quarter of RAM (whole GiB), at least 2 CPUs
/// and 2 GiB. `defaultSize` in packages/contract is the same table.
public func defaultSize(hostCPUs: Int, hostMemoryBytes: UInt64) -> (cpus: Int, memoryBytes: UInt64) {
    (max(2, hostCPUs / 2), max(2 * gib, hostMemoryBytes / 4 / gib * gib))
}

/// A size for a report, e.g. "2 GiB" or "1.5 GiB".
func gibibytes(_ bytes: UInt64) -> String { "\(String(format: "%g", (Double(bytes) / Double(gib) * 10).rounded() / 10)) GiB" }

/// A duration for a report, in the largest whole unit: "5 s", "10 min", "2 h".
func spoken(_ seconds: TimeInterval) -> String {
    let whole = Int(seconds.rounded())
    if whole >= 3_600, whole % 3_600 == 0 { return "\(whole / 3_600) h" }
    if whole >= 60, whole % 60 == 0 { return "\(whole / 60) min" }
    return "\(whole) s"
}

/// What a sandbox was doing when its record was last written, so the next daemon start knows what to bring back:
/// `running` and `hibernated` (taken down by SIGTERM or the host's power) come back at start; `sleeping` (asleep in
/// memory, lost with the daemon) and `asleep` (down until used: a saved state, or a cold boot owed) wait for a request.
public enum SavedLifecycle: String, Codable, Sendable {
    case running, sleeping, asleep, stopped, hibernated
}

/// One sandbox on this Mac, as `<sandboxes>/<id>/sandbox.json`: the catalog identity Convex owns (id, name) mirrored
/// read-only, plus the runtime this daemon owns (size, MAC, machine identifier, lifecycle).
public struct SandboxRecord: Codable, Equatable, Sendable {
    public let sandboxID: String
    public var name: String
    public var cpus: Int
    public var memoryBytes: UInt64
    /// Locally administered NAT MAC and base64 `VZGenericMachineIdentifier`; written once, so a saved state restores.
    public var mac: String?
    public var machineIdentifier: String?
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
    /// The idle policy (Q5), mirrored from the account catalog: sleep after this much idle time (nil: the 30 min
    /// default), and delete after this much (nil: never).
    public var sleepAfterMs: Int?
    public var deleteAfterMs: Int?
    public init(sandboxID: String, name: String, cpus: Int, memoryBytes: UInt64, lifecycle: SavedLifecycle = .stopped, inCatalog: Bool = true) {
        self.sandboxID = sandboxID; self.name = name; self.cpus = cpus; self.memoryBytes = memoryBytes; self.lifecycle = lifecycle; self.inCatalog = inCatalog
    }
    enum CodingKeys: String, CodingKey {
        case sandboxID = "sandbox_id", name, cpus, memoryBytes = "memory_bytes", mac, machineIdentifier = "machine_identifier", lifecycle
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
    /// The process fixture's filesystem root.
    public var guestRoot: URL { url.appendingPathComponent("root", isDirectory: true) }

    public func load() throws -> SandboxRecord {
        let decoder = JSONDecoder(); decoder.dateDecodingStrategy = .iso8601
        return try decoder.decode(SandboxRecord.self, from: Data(contentsOf: recordFile))
    }

    public func save(_ record: SandboxRecord) throws {
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]; encoder.dateEncodingStrategy = .iso8601
        try encoder.encode(record).write(to: recordFile, options: .atomic)
    }

    /// What deleting this directory removes, for the delete report.
    func contents() -> [String] {
        [(recordFile, "sandbox identity"), (disk, "disk"), (savedState, "saved state"), (guestRoot, "guest root")]
            .filter { FileManager.default.fileExists(atPath: $0.0.path) }.map(\.1)
    }
}

/// A random locally administered unicast MAC, the kind `VZMACAddress.randomLocallyAdministered()` makes.
func randomLocalMAC() -> String {
    var bytes = (0..<6).map { _ in UInt8.random(in: 0...255) }
    bytes[0] = (bytes[0] & 0xFC) | 0x02
    return bytes.map { String(format: "%02x", $0) }.joined(separator: ":")
}

#if canImport(Darwin)
/// An APFS clone of `template` (shares every block until written); a plain copy where cloning is unsupported.
/// Returns "cloned" or "copied".
public func cloneDisk(_ template: URL, to disk: URL) throws -> String {
    if clonefile(template.path, disk.path, 0) == 0 { return "cloned" }
    guard errno == ENOTSUP || errno == EXDEV else { throw HostDaemonError.unsupported("could not clone \(template.path): errno \(errno)") }
    try FileManager.default.copyItem(at: template, to: disk)
    return "copied"
}

/// Bytes only this file holds (APFS `ATTR_CMNEXT_PRIVATESIZE`): blocks shared with a clone are not counted, unlike `du`.
public func privateBytes(_ url: URL) -> Int64? {
    var list = attrlist(); list.bitmapcount = u_short(ATTR_BIT_MAP_COUNT); list.forkattr = attrgroup_t(ATTR_CMNEXT_PRIVATESIZE)
    var buffer = [UInt8](repeating: 0, count: 16)
    guard getattrlist(url.path, &list, &buffer, buffer.count, UInt32(FSOPT_ATTR_CMN_EXTENDED)) == 0 else { return nil }
    return buffer.withUnsafeBytes { $0.loadUnaligned(fromByteOffset: 4, as: Int64.self) }
}
#endif
