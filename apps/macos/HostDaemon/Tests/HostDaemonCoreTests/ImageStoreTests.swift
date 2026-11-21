import Foundation
import XCTest
@testable import HostDaemonCore
#if canImport(Darwin)
import Darwin
#endif

final class ImageStoreTests: XCTestCase {
    private var scratch: URL!
    private var images: URL { scratch.appendingPathComponent("images", isDirectory: true) }
    override func setUpWithError() throws {
        scratch = FileManager.default.temporaryDirectory.appendingPathComponent("lb-images-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)
    }
    override func tearDownWithError() throws { try? FileManager.default.removeItem(at: scratch) }

    /// Writes a complete image into `temp`: a 16 MiB disk of real (non-zero) data, a boot store and its manifest.
    private func writeImage(_ id: String, into temp: URL, os: GuestOS = .linux) throws {
        try Data(repeating: 0xA5, count: 16 << 20).write(to: temp.appendingPathComponent("disk.img"))
        let boot = temp.appendingPathComponent("boot", isDirectory: true)
        try FileManager.default.createDirectory(at: boot, withIntermediateDirectories: true)
        try Data("boot store".utf8).write(to: boot.appendingPathComponent(os == .linux ? "efi-vars" : "aux.img"))
        try JSONEncoder().encode(ImageManifest(imageID: id, os: os, sizeBytes: 16 << 20, hardwareModel: os == .macos ? "bW9kZWw=" : nil, agentVersion: "0.1.1+abc")).write(to: temp.appendingPathComponent("image.json"))
    }

    private func committed(_ store: ImageStore, _ id: String, os: GuestOS = .linux) throws {
        let temp = try store.reserveTemp(id)
        try writeImage(id, into: temp, os: os)
        try store.commit(temp, as: id)
    }

    private func sandbox(_ name: String) throws -> SandboxDirectory {
        let directory = SandboxDirectory(scratch.appendingPathComponent("sandboxes/\(name)", isDirectory: true))
        try FileManager.default.createDirectory(at: directory.url, withIntermediateDirectories: true)
        return directory
    }

    func testACrashBetweenReserveAndCommitIsSweptOnTheNextStart() throws {
        let store = try ImageStore(imagesDirectory: images)
        let temp = try store.reserveTemp("brave-walrus")
        try writeImage("brave-walrus", into: temp)
        XCTAssertEqual(store.list(), [], "an uncommitted image is never listed")
        // The daemon dies here; the next start sweeps before anything reads the store.
        let restarted = try ImageStore(imagesDirectory: images)
        XCTAssertEqual(restarted.sweepTemps(), [temp.lastPathComponent])
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: images.path), [])
        XCTAssertThrowsError(try restarted.manifest("brave-walrus"))
    }

    func testCommitIsAtomicAndRefusesIncompleteOrDuplicateImages() throws {
        let store = try ImageStore(imagesDirectory: images)
        try committed(store, "linux")
        XCTAssertEqual(store.list().map(\.imageID), ["linux"])
        XCTAssertEqual(try store.manifest("linux").agentVersion, "0.1.1+abc")
        let again = try store.reserveTemp("linux")
        try writeImage("linux", into: again)
        XCTAssertThrowsError(try store.commit(again, as: "linux"), "a commit never replaces an image already here")
        let incomplete = try store.reserveTemp("half")
        try writeImage("half", into: incomplete)
        try FileManager.default.removeItem(at: incomplete.appendingPathComponent("boot/efi-vars"))
        XCTAssertThrowsError(try store.commit(incomplete, as: "half"))
        let misnamed = try store.reserveTemp("one")
        try writeImage("other", into: misnamed)
        XCTAssertThrowsError(try store.commit(misnamed, as: "one"))
        XCTAssertThrowsError(try store.reserveTemp("../escape"))
        XCTAssertEqual(store.list().map(\.imageID), ["linux"])
    }

    /// A daemon whose images directory didn't exist yet (its root URL then has no trailing slash) commits all the same.
    func testCommitWorksOnAStoreWhoseDirectoryItCreated() throws {
        let fresh = URL(fileURLWithPath: scratch.appendingPathComponent("fresh-images").path)
        let store = try ImageStore(imagesDirectory: fresh)
        try committed(store, "brave-walrus")
        XCTAssertEqual(store.list().map(\.imageID), ["brave-walrus"])
    }

    /// On APFS a sandbox's disk shares every block with the image until written, and the result says so.
    func testClonesAreThinOnAPFS() throws {
        let store = try ImageStore(imagesDirectory: images)
        try committed(store, "linux")
        let directory = try sandbox("sandbox_1")
        let clone = try store.cloneForSandbox("linux", into: directory)
        XCTAssertEqual(clone.disk, "cloned")
        XCTAssertEqual(clone.boot, .linuxEFI(variableStore: directory.bootStore(for: .linux)))
        XCTAssertEqual(clone.manifest.os, .linux)
        let shared = try XCTUnwrap(privateBytes(directory.disk))
        XCTAssertLessThan(shared, 1 << 20, "a 16 MiB clone holds \(shared) private bytes")
        XCTAssertEqual(try Data(contentsOf: directory.bootStore(for: .linux)), Data("boot store".utf8))
    }

    /// Removing an image leaves sandboxes made from it whole: their disk clone and boot store copy are their own.
    func testRemoveLeavesExistingSandboxClonesBootable() throws {
        let store = try ImageStore(imagesDirectory: images)
        try committed(store, "image_mac", os: .macos)
        let directory = try sandbox("sandbox_mac")
        let clone = try store.cloneForSandbox("image_mac", into: directory)
        XCTAssertEqual(clone.manifest.hardwareModel, "bW9kZWw=")
        let disk = try Data(contentsOf: directory.disk)
        try store.remove("image_mac")
        XCTAssertEqual(store.list(), [])
        XCTAssertEqual(try Data(contentsOf: directory.disk), disk)
        XCTAssertEqual(try Data(contentsOf: directory.bootStore(for: .macos)), Data("boot store".utf8))
        XCTAssertThrowsError(try store.cloneForSandbox("image_mac", into: try sandbox("sandbox_2")))
        XCTAssertThrowsError(try store.remove("image_mac"))
    }

    func testFreeBytesMatchesStatfs() throws {
        let store = try ImageStore(imagesDirectory: images)
        var stats = statfs()
        XCTAssertEqual(statfs(images.path, &stats), 0)
        let expected = Double(UInt64(stats.f_bavail) * UInt64(stats.f_bsize))
        XCTAssertEqual(Double(try store.freeBytes()), expected, accuracy: 256 * 1024 * 1024, "free space moves a little between the two reads")
    }
}
