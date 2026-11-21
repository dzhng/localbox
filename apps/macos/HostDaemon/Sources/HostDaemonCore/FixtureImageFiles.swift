import Foundation

/// Image files for dev daemons (`LOCALBOX_DEV=1` with `LOCALBOX_DEV_IMAGE_FILES`) until slice 24's `ImageStore` is
/// wired in: each image is a directory `<root>/<image id>/` whatever it holds, and `.listed-by` in it names the machine
/// whose catalog listed it. Proofs seed the directories themselves.
public struct FixtureImageFiles: ImageFiles {
    private let root: URL
    private static let listedBy = ".listed-by"

    public init(root: URL) throws {
        self.root = root
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    public func list() async throws -> [HeldImage] {
        try FileManager.default.contentsOfDirectory(atPath: root.path).filter { !$0.hasPrefix(".") && $0 != "linux" }.sorted().map { id in
            let marker = root.appendingPathComponent(id).appendingPathComponent(Self.listedBy)
            return HeldImage(imageID: id, listedBy: (try? String(contentsOf: marker, encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines))
        }
    }

    public func markListed(_ imageID: String, by machineID: String) async throws {
        try Data(machineID.utf8).write(to: root.appendingPathComponent(imageID).appendingPathComponent(Self.listedBy), options: .atomic)
    }

    public func remove(_ imageID: String) async throws -> Bool {
        guard !imageID.isEmpty, !imageID.contains("/"), !imageID.hasPrefix(".") else { throw HostDaemonError.invalidState("image id \(imageID) is not a directory name") }
        let directory = root.appendingPathComponent(imageID)
        guard FileManager.default.fileExists(atPath: directory.path) else { return false }
        try FileManager.default.removeItem(at: directory)
        return true
    }
}
