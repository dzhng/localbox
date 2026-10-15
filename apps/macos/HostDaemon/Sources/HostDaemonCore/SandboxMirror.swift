import Foundation

/// One sandbox this Mac holds, as the account catalog (Convex) names it.
public struct SandboxIdentity: Codable, Equatable, Sendable {
    public let sandboxID: String
    public var name: String
    public var cpus: Int
    public var memoryBytes: UInt64
    public init(sandboxID: String, name: String, cpus: Int, memoryBytes: UInt64) {
        self.sandboxID = sandboxID; self.name = name; self.cpus = cpus; self.memoryBytes = memoryBytes
    }
    enum CodingKeys: String, CodingKey { case sandboxID = "sandbox_id", name, cpus, memoryBytes = "memory_bytes" }
}

private let gib: UInt64 = 1024 * 1024 * 1024

/// A new sandbox's size when none is asked for: half the cores and a quarter of RAM (whole GiB), at least 2 CPUs
/// and 2 GiB. `defaultSize` in packages/contract is the same table.
public func defaultSize(hostCPUs: Int, hostMemoryBytes: UInt64) -> (cpus: Int, memoryBytes: UInt64) {
    (max(2, hostCPUs / 2), max(2 * gib, hostMemoryBytes / 4 / gib * gib))
}

/// The daemon's read-only copy of the catalog identities on this Mac, kept at `LOCALBOX_SANDBOX_MIRROR`.
/// Convex owns names; the daemon owns the size it runs a sandbox at and reports it back.
struct SandboxMirror {
    private(set) var identities: [SandboxIdentity]
    let file: URL?

    init(file: URL?) {
        self.file = file
        identities = file.flatMap { try? Data(contentsOf: $0) }.flatMap { try? JSONDecoder().decode([SandboxIdentity].self, from: $0) } ?? []
    }

    func find(_ sandboxID: String) -> SandboxIdentity? { identities.first { $0.sandboxID == sandboxID } }

    mutating func upsert(_ identity: SandboxIdentity) throws {
        if let index = identities.firstIndex(where: { $0.sandboxID == identity.sandboxID }) { identities[index] = identity } else { identities.append(identity) }
        try save()
    }

    @discardableResult mutating func remove(_ sandboxID: String) throws -> SandboxIdentity? {
        guard let index = identities.firstIndex(where: { $0.sandboxID == sandboxID }) else { return nil }
        let removed = identities.remove(at: index); try save(); return removed
    }

    /// Follow the catalog: its sandboxes and names; a sandbox already here keeps the size it runs at.
    /// Returns whether anything changed.
    mutating func follow(_ catalog: [SandboxIdentity]) throws -> Bool {
        let next = catalog.map { row -> SandboxIdentity in
            guard let local = find(row.sandboxID) else { return row }
            return SandboxIdentity(sandboxID: row.sandboxID, name: row.name, cpus: local.cpus, memoryBytes: local.memoryBytes)
        }
        guard next != identities else { return false }
        identities = next; try save(); return true
    }

    private func save() throws {
        guard let file else { return }
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(identities).write(to: file, options: .atomic)
    }
}
