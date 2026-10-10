import XCTest
@testable import VMProbeCore

final class VMProbeCoreTests: XCTestCase {
    func testFakeProbePersistsMarkerAcrossRuns() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("vm-probe-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let backend = FakeVMBackend()
        let cold = try backend.run(diskURL: root)
        let warm = try backend.run(diskURL: root)
        XCTAssertEqual(cold.verdict, "pass")
        XCTAssertEqual(warm.verdict, "pass")
        XCTAssertTrue(warm.diskMarkerPersistence.passed)
        XCTAssertTrue(warm.notes.contains("fake backend: warm persistence run"))
        XCTAssertEqual(cold.guest, warm.guest)
    }

    func testDefaultBackendIsUsableOnThisPlatform() throws {
        let backend = VMProbeFactory.makeDefault()
        #if os(macOS)
        XCTAssertEqual(backend.name, "apple-virtualization")
        #else
        XCTAssertEqual(backend.name, "fake")
        #endif
    }

    func testAppleBackendDoesNotSilentlyFallBack() {
        let backend = AppleVirtualizationBackend()
        XCTAssertThrowsError(try backend.run(diskURL: URL(fileURLWithPath: "/tmp/probe-disk")))
    }
}
