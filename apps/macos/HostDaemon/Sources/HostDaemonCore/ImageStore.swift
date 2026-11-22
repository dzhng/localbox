import Foundation
#if canImport(Darwin)
import Darwin
#endif

/// `images/<id>/image.json`: what the image is, read without opening its disk.
public struct ImageManifest: Codable, Equatable, Sendable {
    public let imageID: String
    public let os: GuestOS
    /// Bytes the image's files hold on disk (allocated, so a sparse disk counts only what it stores).
    public let sizeBytes: UInt64
    /// Base64 `VZMacHardwareModel` and the oldest macOS host that runs it; macOS images only.
    public let hardwareModel: String?
    public let minMacOS: String?
    /// The guest agent version the image carries; the host's agent is authoritative and replaces it when they differ.
    public let agentVersion: String
    public init(imageID: String, os: GuestOS, sizeBytes: UInt64, hardwareModel: String? = nil, minMacOS: String? = nil, agentVersion: String) {
        self.imageID = imageID; self.os = os; self.sizeBytes = sizeBytes; self.hardwareModel = hardwareModel; self.minMacOS = minMacOS; self.agentVersion = agentVersion
    }
    enum CodingKeys: String, CodingKey {
        case imageID = "image_id", os, sizeBytes = "size_bytes", hardwareModel = "hardware_model", minMacOS = "min_macos", agentVersion = "agent_version"
    }
}

/// The image a request names is not on this Mac (never here, or deleted since).
public struct ImageNotHere: Error, CustomStringConvertible, Sendable {
    public let imageID: String
    public var description: String { "image \(imageID) is not on this Mac" }
}

/// An image with files on this Mac. `listedBy` is the machine whose account catalog last listed it here, so a catalog
/// push deletes only what that same machine's catalog listed before (as `sandbox.mirror` does for sandboxes).
public struct HeldImage: Sendable, Equatable {
    public let imageID: String
    public let listedBy: String?
}

/// What `cloneForSandbox` laid down in a sandbox's directory.
public struct ClonedImage: Sendable {
    public let manifest: ImageManifest
    /// "cloned" (APFS clone, sharing every block until written) or "copied" (cloning unsupported), so a report never
    /// claims a thin clone it didn't get.
    public let disk: String
}

/// The only code that touches `images/<id>/`: `image.json`, `disk.img`, `boot/` (`efi-vars`, or `aux.img` for macOS)
/// and this Mac's own `listed-by` mark. An image is written into a dot-prefixed temporary directory and committed by one
/// rename, so a reader never sees half an image and a crash leaves only a temporary that the next start sweeps. It also
/// answers how much the images volume has free, for capacity and for every operation that writes an image, and keeps
/// the account's names for the images its catalog lists here (`accountName`).
public struct ImageStore: Sendable {
    public let root: URL
    /// A free-disk figure in place of the volume's: proof runs fix it (`LOCALBOX_DEV_FREE_DISK_BYTES`), tests script it.
    private let freeBytesOverride: (@Sendable () -> UInt64)?
    /// Shared by every copy of this store, so the daemon's image work reads the names the mirror last gave.
    private let names = AccountImageNames()

    public init(imagesDirectory: URL, freeBytesOverride: (@Sendable () -> UInt64)? = nil) throws {
        root = imagesDirectory; self.freeBytesOverride = freeBytesOverride
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    /// Every committed image whose manifest reads, in id order.
    public func list() -> [ImageManifest] {
        ((try? FileManager.default.contentsOfDirectory(atPath: root.path)) ?? []).sorted().filter { !$0.hasPrefix(".") }.compactMap { try? manifest($0) }
    }

    public func manifest(_ id: String) throws -> ImageManifest {
        let directory = try imageDirectory(id)
        guard let data = try? Data(contentsOf: directory.appendingPathComponent(Self.manifestName)) else { throw ImageNotHere(imageID: id) }
        let manifest = try JSONDecoder().decode(ImageManifest.self, from: data)
        guard manifest.imageID == id else { throw HostDaemonError.invalidState("image \(id)'s manifest names \(manifest.imageID)") }
        return manifest
    }

    /// A new, empty temporary directory to write image `id` into before `commit`. Dot-prefixed, so `list()` and the
    /// sandbox stray scan never see it.
    public func reserveTemp(_ id: String) throws -> URL {
        _ = try imageDirectory(id)
        let temp = root.appendingPathComponent(".\(id).\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: temp, withIntermediateDirectories: false)
        return temp
    }

    /// The temporary a resumable write of image `id` under `key` (a copy's operation) uses, created if missing and
    /// otherwise as an earlier run left it; `sweepTemps(keeping:)` spares it, and anything named after it, while that write
    /// may resume.
    public func resumableTemp(_ id: String, key: String) throws -> URL {
        let temp = root.appendingPathComponent(Self.resumableTempName(id, key: key), isDirectory: true)
        try FileManager.default.createDirectory(at: temp, withIntermediateDirectories: true)
        return temp
    }

    public static func resumableTempName(_ id: String, key: String) -> String { ".\(id).resume-\(key)" }

    /// Image `id`'s files as a copy sends them: the manifest, the disk and the boot store, never this Mac's own marks.
    public func copySource(_ id: String) throws -> ImageCopySource {
        let manifest = try manifest(id)
        return ImageCopySource(directory: try imageDirectory(id), files: [Self.manifestName, Self.diskName, "boot/\(manifest.os.bootStoreName)"])
    }

    /// Makes a complete temporary directory image `id` with one rename; refuses one that is incomplete, names another
    /// id, or would replace an image already here.
    public func commit(_ temp: URL, as id: String) throws {
        let destination = try imageDirectory(id)
        // Compared as paths: a root made before its directory existed has no trailing slash, the parent of a child does.
        guard temp.deletingLastPathComponent().standardizedFileURL.path == root.standardizedFileURL.path, temp.lastPathComponent.hasPrefix(".") else { throw HostDaemonError.invalidState("\(temp.path) is not a temporary directory of \(root.path)") }
        let manifest = try JSONDecoder().decode(ImageManifest.self, from: Data(contentsOf: temp.appendingPathComponent(Self.manifestName)))
        guard manifest.imageID == id else { throw HostDaemonError.invalidState("the image being committed as \(id) names \(manifest.imageID)") }
        for file in [temp.appendingPathComponent(Self.diskName), Self.bootStore(in: temp, os: manifest.os)] where !FileManager.default.fileExists(atPath: file.path) {
            throw HostDaemonError.invalidState("image \(id) is incomplete: \(file.lastPathComponent) is missing")
        }
        guard renamex_np(temp.path, destination.path, UInt32(RENAME_EXCL)) == 0 else {
            throw HostDaemonError.invalidState(errno == EEXIST ? "image \(id) is already on this Mac" : "could not commit image \(id): errno \(errno)")
        }
    }

    /// Deletes image `id`. Sandboxes cloned from it keep working: each has its own disk clone and boot store copy.
    /// The directory is first renamed to a temporary, so a crash mid-delete leaves something `sweepTemps` removes.
    public func remove(_ id: String) throws {
        let directory = try imageDirectory(id)
        guard FileManager.default.fileExists(atPath: directory.path) else { throw ImageNotHere(imageID: id) }
        let doomed = root.appendingPathComponent(".\(id).removing.\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.moveItem(at: directory, to: doomed)
        try FileManager.default.removeItem(at: doomed)
    }

    /// Lays image `id` down in a new sandbox's directory: an APFS clone of its disk and a plain copy of its boot store.
    public func cloneForSandbox(_ id: String, into directory: SandboxDirectory) throws -> ClonedImage {
        let manifest = try manifest(id)
        let image = try imageDirectory(id)
        let disk = try cloneDisk(image.appendingPathComponent(Self.diskName), to: directory.disk)
        try FileManager.default.copyItem(at: Self.bootStore(in: image, os: manifest.os), to: directory.bootStore(for: manifest.os))
        return ClonedImage(manifest: manifest, disk: disk)
    }

    /// Lays a sandbox's files into temporary `temp` as an image's: an APFS clone of `disk` and a copy of `bootStore`.
    /// Quick enough to run while the sandbox is frozen; the manifest comes after (`seal`). Returns "cloned" or "copied".
    public func layDown(disk: URL, bootStore source: URL, os: GuestOS, into temp: URL) throws -> String {
        let cloned = try cloneDisk(disk, to: temp.appendingPathComponent(Self.diskName))
        let boot = Self.bootStore(in: temp, os: os)
        try FileManager.default.createDirectory(at: boot.deletingLastPathComponent(), withIntermediateDirectories: true)
        try FileManager.default.copyItem(at: source, to: boot)
        return cloned
    }

    /// Writes the manifest of the image laid down in `temp`, sized from its files, ready for `commit`.
    public func seal(_ temp: URL, imageID: String, os: GuestOS, hardwareModel: String?, minMacOS: String?, agentVersion: String) throws -> ImageManifest {
        let size = allocatedBytes(temp.appendingPathComponent(Self.diskName)) + allocatedBytes(Self.bootStore(in: temp, os: os))
        let manifest = ImageManifest(imageID: imageID, os: os, sizeBytes: size, hardwareModel: hardwareModel, minMacOS: minMacOS, agentVersion: agentVersion)
        let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(manifest).write(to: temp.appendingPathComponent(Self.manifestName), options: .atomic)
        return manifest
    }

    /// Bytes free to an unprivileged writer on the images volume (`statfs` `f_bavail`), or the override.
    public func freeBytes() throws -> UInt64 {
        if let freeBytesOverride { return freeBytesOverride() }
        var stats = statfs()
        guard statfs(root.path, &stats) == 0 else { throw HostDaemonError.unsupported("could not read free space at \(root.path): errno \(errno)") }
        return UInt64(stats.f_bavail) * UInt64(stats.f_bsize)
    }

    /// Refuses `task` (`disk_full`) unless `needed` bytes are free; `why` says what they are for and `retry` how to try
    /// again once room is made.
    public func requireFree(_ needed: UInt64, for task: String, because why: String, then retry: String) throws {
        let free: UInt64
        do { free = try freeBytes() } catch { throw HostOperationFailure(code: "internal", message: "could not read this Mac's free disk: \(explain(error))") }
        guard free < needed else { return }
        throw HostOperationFailure(code: "disk_full", message: "\(task) needs \(gibibytes(needed)) free on this Mac (\(why)), and \(gibibytes(free)) is free",
                                   nextStep: "free at least \(gibibytes(needed - free)) on this Mac (delete sandboxes or images it no longer needs), then \(retry)")
    }

    // MARK: - This Mac's listing marks

    /// Every image with files here except the built-in one, with the machine whose catalog last listed it.
    public func held() -> [HeldImage] {
        list().filter { $0.imageID != builtInImage }.map { manifest in
            HeldImage(imageID: manifest.imageID, listedBy: (try? String(contentsOf: listingMark(manifest.imageID), encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines))
        }
    }

    /// Records that machine `machineID`'s catalog lists image `id` here. The mark is this Mac's account state, beside the
    /// manifest and never sent with a copy.
    public func markListed(_ id: String, by machineID: String) throws {
        _ = try manifest(id)
        try Data(machineID.utf8).write(to: listingMark(id), options: .atomic)
    }

    /// Removes image `id` when it is here; false when it was not.
    public func removeIfPresent(_ id: String) throws -> Bool {
        guard (try? manifest(id)) != nil else { return false }
        try remove(id)
        return true
    }

    private func listingMark(_ id: String) throws -> URL { try imageDirectory(id).appendingPathComponent("listed-by") }

    /// The account's name for image `id`, as the catalog last listed it here, held or still being built or copied in.
    /// Nil until the connector's first mirror after a start: the names are kept in memory only, since the images shown by
    /// name are the ones in progress, which have no directory to keep a mark in, and the connector re-sends them as soon
    /// as it reaches the account.
    public func accountName(_ id: String) -> String? { names.get(id) }

    /// What a message about image `id` calls it: its account name, else its id.
    public func displayName(_ id: String) -> String { accountName(id) ?? id }

    /// Replaces the account's names with those of the images its catalog lists here now.
    public func setAccountNames(_ listed: [String: String]) { names.set(listed) }

    /// The IPSW cache (`.ipsw/`): kept across starts and never swept, since it holds downloads that took an hour.
    public var ipswDirectory: URL { root.appendingPathComponent(".ipsw", isDirectory: true) }

    /// The directory a macOS base build of image `id` works in (`.<id>.build/`), made if missing. Its name is fixed, so a
    /// resumed build finds what the last run installed; it is committed like any temporary once it holds an image.
    public func buildDirectory(_ id: String) throws -> MacBuildDirectory {
        let directory = try buildRoot(id)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return MacBuildDirectory(root: directory)
    }

    /// Removes image `id`'s build directory, if any.
    public func discardBuild(_ id: String) throws {
        let directory = try buildRoot(id)
        if FileManager.default.fileExists(atPath: directory.path) { try FileManager.default.removeItem(at: directory) }
    }

    private func buildRoot(_ id: String) throws -> URL { root.appendingPathComponent(".\(try imageDirectory(id).lastPathComponent).build", isDirectory: true) }

    /// Removes every temporary of image `id` (`.<id>.*`): a resumed operation that starts over clears what its last run
    /// left before writing anew.
    public func discardTemps(of id: String) {
        for name in temps() where Self.temp(name, belongsTo: [id]) { try? FileManager.default.removeItem(at: root.appendingPathComponent(name)) }
    }

    /// At daemon start: removes temporaries a crash left (an unfinished write or delete). A dot-entry a running host
    /// operation owns (`.<subject>.*`, for every subject in `running`) stays for its resume (a build directory, a copy's partial files and the transfer's resume
    /// bitmap beside them), and so does the IPSW cache.
    /// Returns the names removed.
    @discardableResult public func sweepTemps(keeping running: Set<String> = []) -> [String] {
        let swept = temps().filter { $0 != ipswDirectory.lastPathComponent && !Self.temp($0, belongsTo: running) }
        for name in swept { try? FileManager.default.removeItem(at: root.appendingPathComponent(name)) }
        return swept
    }

    private func temps() -> [String] {
        ((try? FileManager.default.contentsOfDirectory(atPath: root.path)) ?? []).filter { $0.hasPrefix(".") && $0 != ".DS_Store" }.sorted()
    }

    /// Whether dot-entry `name` is a temporary of one of `images` (`.<id>.<anything>`).
    private static func temp(_ name: String, belongsTo images: Set<String>) -> Bool {
        let parts = name.dropFirst().split(separator: ".", maxSplits: 1)
        return parts.count == 2 && images.contains(String(parts[0]))
    }

    static let manifestName = "image.json", diskName = "disk.img"

    /// Where image `id` lives; an id is one directory name.
    private func imageDirectory(_ id: String) throws -> URL {
        guard !id.isEmpty, !id.contains("/"), !id.hasPrefix(".") else { throw HostDaemonError.invalidState("image id \(id) is not a directory name") }
        return root.appendingPathComponent(id, isDirectory: true)
    }

    /// An image's boot store, in its directory or a temporary laid out like one.
    static func bootStore(in image: URL, os: GuestOS) -> URL {
        image.appendingPathComponent("boot", isDirectory: true).appendingPathComponent(os.bootStoreName)
    }
}

/// `ImageStore`'s in-memory names, behind a lock: the mirror writes them from `ImageHost`, `host.watch` reads them from
/// `SandboxHost`.
private final class AccountImageNames: @unchecked Sendable {
    private let lock = NSLock()
    private var byID: [String: String] = [:]
    func get(_ id: String) -> String? { lock.withLock { byID[id] } }
    func set(_ names: [String: String]) { lock.withLock { byID = names } }
}

/// A macOS base build's working files, in its `ImageStore` build directory (`images/.<id>.build/`): the installed
/// disk and auxiliary storage kept pristine, the hardware model and identity they were installed with, and the work
/// copies laid out as an image's, so committing is one rename once the build's own files go.
public struct MacBuildDirectory: Sendable {
    public let root: URL
    public var installedDisk: URL { root.appendingPathComponent("installed.img") }
    public var installedAux: URL { root.appendingPathComponent("installed-aux.img") }
    public var hardwareModel: URL { root.appendingPathComponent("hardware-model") }
    public var machineIdentifier: URL { root.appendingPathComponent("machine-identifier") }
    public var mac: URL { root.appendingPathComponent("mac") }
    public var payload: URL { root.appendingPathComponent("payload.tgz") }
    public var disk: URL { root.appendingPathComponent(ImageStore.diskName) }
    public var aux: URL { ImageStore.bootStore(in: root, os: .macos) }

    /// Everything that is the build's own and not the image's.
    var privateFiles: [URL] { [installedDisk, installedAux, hardwareModel, machineIdentifier, mac, payload] }

    /// A fresh work copy of the installed guest: an APFS clone of its disk and a copy of its auxiliary storage. Each
    /// provisioning boot starts from one, so a build that resumes never boots a half-provisioned disk.
    func resetWorkCopy() throws {
        for file in [disk, aux] { try? FileManager.default.removeItem(at: file) }
        try FileManager.default.createDirectory(at: aux.deletingLastPathComponent(), withIntermediateDirectories: true)
        _ = try cloneDisk(installedDisk, to: disk)
        try FileManager.default.copyItem(at: installedAux, to: aux)
    }
}

/// An APFS clone of `source` (shares every block until written); a plain copy where cloning is unsupported.
/// Returns "cloned" or "copied".
public func cloneDisk(_ source: URL, to disk: URL) throws -> String {
    if clonefile(source.path, disk.path, 0) == 0 { return "cloned" }
    guard errno == ENOTSUP || errno == EXDEV else { throw HostDaemonError.unsupported("could not clone \(source.path): errno \(errno)") }
    try FileManager.default.copyItem(at: source, to: disk)
    return "copied"
}

/// Bytes the file has allocated (`st_blocks`), so a sparse disk counts only what it stores; 0 for a missing file.
/// Blocks shared with an APFS clone count in full.
public func allocatedBytes(_ url: URL) -> UInt64 {
    var info = stat()
    guard stat(url.path, &info) == 0 else { return 0 }
    return UInt64(info.st_blocks) * 512
}

/// Bytes only this file holds (APFS `ATTR_CMNEXT_PRIVATESIZE`): blocks shared with a clone are not counted, unlike `du`.
public func privateBytes(_ url: URL) -> Int64? {
    var list = attrlist(); list.bitmapcount = u_short(ATTR_BIT_MAP_COUNT); list.forkattr = attrgroup_t(ATTR_CMNEXT_PRIVATESIZE)
    var buffer = [UInt8](repeating: 0, count: 16)
    guard getattrlist(url.path, &list, &buffer, buffer.count, UInt32(FSOPT_ATTR_CMN_EXTENDED)) == 0 else { return nil }
    return buffer.withUnsafeBytes { $0.loadUnaligned(fromByteOffset: 4, as: Int64.self) }
}
