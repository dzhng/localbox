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

/// What `cloneForSandbox` laid down in a sandbox's directory.
public struct ClonedImage: Sendable {
    public let manifest: ImageManifest
    /// The sandbox's own copy of the image's boot store.
    public let boot: BootStore
    /// "cloned" (APFS clone, sharing every block until written) or "copied" (cloning unsupported), so a report never
    /// claims a thin clone it didn't get.
    public let disk: String
}

/// The only code that touches `images/<id>/`: `image.json`, `disk.img` and `boot/` (`efi-vars`, or `aux.img` for macOS).
/// An image is written into a dot-prefixed temporary directory and committed by one rename, so a reader never sees
/// half an image and a crash leaves only a temporary that the next start sweeps.
public struct ImageStore: Sendable {
    public let root: URL
    public init(imagesDirectory: URL) throws {
        root = imagesDirectory
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

    /// Makes a complete temporary directory image `id` with one rename; refuses one that is incomplete, names another
    /// id, or would replace an image already here.
    public func commit(_ temp: URL, as id: String) throws {
        let destination = try imageDirectory(id)
        // Compared as paths: a root made before its directory existed has no trailing slash, the parent of a child does.
        guard temp.deletingLastPathComponent().standardizedFileURL.path == root.standardizedFileURL.path, temp.lastPathComponent.hasPrefix(".") else { throw HostDaemonError.invalidState("\(temp.path) is not a temporary directory of \(root.path)") }
        let manifest = try JSONDecoder().decode(ImageManifest.self, from: Data(contentsOf: temp.appendingPathComponent(Self.manifestName)))
        guard manifest.imageID == id else { throw HostDaemonError.invalidState("the image being committed as \(id) names \(manifest.imageID)") }
        for file in [temp.appendingPathComponent(Self.diskName), bootStore(in: temp, os: manifest.os)] where !FileManager.default.fileExists(atPath: file.path) {
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
        try FileManager.default.copyItem(at: bootStore(in: image, os: manifest.os), to: directory.bootStore(for: manifest.os))
        return ClonedImage(manifest: manifest, boot: BootStore(os: manifest.os, in: directory), disk: disk)
    }

    /// Lays a sandbox's files into temporary `temp` as an image's: an APFS clone of `disk` and a copy of `bootStore`.
    /// Quick enough to run while the sandbox is frozen; the manifest comes after (`seal`). Returns "cloned" or "copied".
    public func layDown(disk: URL, bootStore source: URL, os: GuestOS, into temp: URL) throws -> String {
        let cloned = try cloneDisk(disk, to: temp.appendingPathComponent(Self.diskName))
        let boot = bootStore(in: temp, os: os)
        try FileManager.default.createDirectory(at: boot.deletingLastPathComponent(), withIntermediateDirectories: true)
        try FileManager.default.copyItem(at: source, to: boot)
        return cloned
    }

    /// Writes the manifest of the image laid down in `temp`, sized from its files, ready for `commit`.
    public func seal(_ temp: URL, imageID: String, os: GuestOS, hardwareModel: String?, minMacOS: String?, agentVersion: String) throws -> ImageManifest {
        let size = allocatedBytes(temp.appendingPathComponent(Self.diskName)) + allocatedBytes(bootStore(in: temp, os: os))
        let manifest = ImageManifest(imageID: imageID, os: os, sizeBytes: size, hardwareModel: hardwareModel, minMacOS: minMacOS, agentVersion: agentVersion)
        let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(manifest).write(to: temp.appendingPathComponent(Self.manifestName), options: .atomic)
        return manifest
    }

    /// Bytes free to an unprivileged writer on the images volume (`statfs` `f_bavail`).
    public func freeBytes() throws -> UInt64 {
        var stats = statfs()
        guard statfs(root.path, &stats) == 0 else { throw HostDaemonError.unsupported("could not read free space at \(root.path): errno \(errno)") }
        return UInt64(stats.f_bavail) * UInt64(stats.f_bsize)
    }

    /// At daemon start: removes temporaries a crash left (an unfinished write or delete). Returns their names.
    @discardableResult public func sweepTemps() -> [String] {
        let temps = ((try? FileManager.default.contentsOfDirectory(atPath: root.path)) ?? []).filter { $0.hasPrefix(".") && $0 != ".DS_Store" }.sorted()
        for name in temps { try? FileManager.default.removeItem(at: root.appendingPathComponent(name)) }
        return temps
    }

    static let manifestName = "image.json", diskName = "disk.img"

    /// Where image `id` lives; an id is one directory name.
    private func imageDirectory(_ id: String) throws -> URL {
        guard !id.isEmpty, !id.contains("/"), !id.hasPrefix(".") else { throw HostDaemonError.invalidState("image id \(id) is not a directory name") }
        return root.appendingPathComponent(id, isDirectory: true)
    }

    private func bootStore(in image: URL, os: GuestOS) -> URL {
        image.appendingPathComponent("boot", isDirectory: true).appendingPathComponent(os == .linux ? "efi-vars" : "aux.img")
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

/// `ImageStore` as the image host's view of the files: which images are here and which account listing last named
/// them. The listing mark is a file beside the manifest (`listed-by`), per Mac, never part of the image itself.
public struct StoredImageFiles: ImageFiles {
    public let store: ImageStore
    private static let listedBy = "listed-by"
    public init(store: ImageStore) { self.store = store }

    public func list() async throws -> [HeldImage] {
        store.list().filter { $0.imageID != "linux" }.map { manifest in
            let marker = store.root.appendingPathComponent(manifest.imageID).appendingPathComponent(Self.listedBy)
            return HeldImage(imageID: manifest.imageID, listedBy: (try? String(contentsOf: marker, encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines))
        }
    }

    public func markListed(_ imageID: String, by machineID: String) async throws {
        _ = try store.manifest(imageID)
        try Data(machineID.utf8).write(to: store.root.appendingPathComponent(imageID).appendingPathComponent(Self.listedBy), options: .atomic)
    }

    public func remove(_ imageID: String) async throws -> Bool {
        guard (try? store.manifest(imageID)) != nil else { return false }
        try store.remove(imageID)
        return true
    }
}
