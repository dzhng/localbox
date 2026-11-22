import Foundation
import XCTest
@testable import HostDaemonCore

/// Under Localbox.app a new Mac has no `images/linux` until `localbox app image ensure` installs it; a create from it
/// meanwhile is told to wait, with the download's progress, and works once the image is here.
final class BuiltinImageWaitTests: XCTestCase {
    private static let create = #"{"name":"early-otter","image":"linux","cpus":2,"memory_bytes":2147483648,"sleep_after_ms":1800000}"#

    func testACreateFromTheBuiltInImageWaitsForItsDownloadThenSucceeds() async throws {
        let root = try scratch()
        let store = try ImageStore(imagesDirectory: root.appendingPathComponent("images"))
        let progress = root.appendingPathComponent("builtin-image.json")
        // The fake backend lays down any image it is told it has; the store decides whether linux is "here".
        let host = try sandboxHost(sandboxesDirectory: root.appendingPathComponent("sandboxes"), factory: FakeBackendFactory(images: [builtInImage, "image_bold"]), store: store,
                                   builtinImage: BuiltinImageWait(progressFile: progress))

        try Data(#"{"phase":"downloading","done_bytes":120000000,"total_bytes":345000000,"version":"0.43.0"}"#.utf8).write(to: progress)
        let error = try await refusal(host)
        XCTAssertEqual(error["code"] as? String, "sandbox_not_ready")
        XCTAssertEqual(error["retryable"] as? Bool, true)
        XCTAssertEqual(error["message"] as? String, "the built-in image is still downloading (120 MB of 345 MB); try again when `localbox app status` shows it ready")
        let details = try XCTUnwrap(error["details"] as? [String: Any])
        XCTAssertEqual(details["state"] as? String, "downloading")
        XCTAssertEqual(details["progress"] as? [String: Int], ["done_bytes": 120_000_000, "total_bytes": 345_000_000])
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("sandboxes/sandbox_1").path), "nothing was laid down")

        // Another image is not held up by the built-in one.
        _ = try await result(host, "sandbox.create", #"{"name":"bold","image":"image_bold","cpus":2,"memory_bytes":2147483648,"sleep_after_ms":1800000}"#, sandboxID: "sandbox_2")

        try Data(#"{"phase":"failed","done_bytes":0,"total_bytes":0,"error":"checksum mismatch: localbox-linux-0.43.0.disk.img.zst.001"}"#.utf8).write(to: progress)
        let failed = try await refusal(host)
        XCTAssertEqual(failed["retryable"] as? Bool, true, "Localbox.app retries a failed download")
        XCTAssertEqual((failed["details"] as? [String: Any])?["state"] as? String, "failed")
        XCTAssertTrue((failed["message"] as? String ?? "").contains("checksum mismatch"), "\(failed)")

        try FileManager.default.removeItem(at: progress)
        let unstarted = try await refusal(host)
        XCTAssertEqual(unstarted["message"] as? String, "the built-in image is still downloading; try again when `localbox app status` shows it ready")

        try store.plant(builtInImage)
        let created = try await result(host, "sandbox.create", Self.create, sandboxID: "sandbox_1")
        XCTAssertEqual(kinds(created).first, "created")
    }

    func testWithoutTheAppACreateFromAMissingBuiltInImageIsNotFoundAsBefore() async throws {
        let root = try scratch()
        let host = try sandboxHost(sandboxesDirectory: root.appendingPathComponent("sandboxes"), factory: FakeBackendFactory(images: []))
        let missing = try await refusal(host)
        XCTAssertEqual(missing["code"] as? String, "image_not_found")
    }

    /// The error a create of `early-otter` from the built-in image answers with.
    private func refusal(_ host: SandboxHost, file: StaticString = #filePath, line: UInt = #line) async throws -> [String: Any] {
        let response = try await call(host, envelope("sandbox.create", Self.create, sandboxID: "sandbox_1"))
        return try XCTUnwrap(response["error"] as? [String: Any], "\(response)", file: file, line: line)
    }
}
