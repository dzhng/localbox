import XCTest
@testable import HostDaemonCore

/// A sandbox's disk size: its image's or more at create, grown by resize and never shrunk, grown on the host at a cold
/// boot and claimed by the guest before the sandbox is ready, a failed claim tried again at the next boot.
final class SandboxDiskTests: XCTestCase {
    func testACreateWithNoDiskGetsItsImagesAndALargerOneGrowsAtTheFirstBoot() async throws {
        let rig = try Rig(test: self)
        let plain = try await result(rig.host, "sandbox.create", Self.create("one"), sandboxID: "sandbox_1")
        XCTAssertEqual((plain["produced"] as? [String: Any])?["disk_bytes"] as? UInt64, 8 * gib, "the image's size")
        XCTAssertFalse(rig.factory.log.events.contains { $0.hasPrefix("grow disk") })
        XCTAssertEqual(rig.claims.value, [], "nothing to claim")

        let grown = try await result(rig.host, "sandbox.create", Self.create("two", disk: 60 * gib), sandboxID: "sandbox_2")
        XCTAssertEqual((grown["produced"] as? [String: Any])?["disk_bytes"] as? UInt64, 60 * gib)
        XCTAssertEqual(rig.factory.log.events.filter { $0.hasPrefix("grow disk") }, ["grow disk \(60 * gib)"])
        XCTAssertEqual(rig.claims.value, [#"resize2fs "$(findmnt -n -o SOURCE /)""#], "the guest grows its root before the sandbox is ready")
        let boot = (grown["actions"] as? [[String: Any]])?.first { $0["kind"] as? String == "cold_booted" }
        XCTAssertEqual(boot?["detail"] as? String, "cold-booted two; its filesystem grew into its 60 GiB disk")
        let record = try rig.record("sandbox_2")
        XCTAssertEqual(record.diskBytes, 60 * gib); XCTAssertFalse(record.diskClaimPending)
        let status = try await result(rig.host, "sandbox.status", sandboxID: "sandbox_2")
        XCTAssertEqual(status["disk_bytes"] as? UInt64, 60 * gib)
        let listed = try await result(rig.host, "sandbox.list", sandboxID: nil)
        XCTAssertEqual((listed["sandboxes"] as? [[String: Any]])?.compactMap { $0["disk_bytes"] as? UInt64 }, [8 * gib, 60 * gib])
    }

    func testACreateBelowItsImagesDiskIsRefusedNamingTheImagesSize() async throws {
        let rig = try Rig(test: self)
        let error = try await failure(rig.host, "sandbox.create", ["name": "small", "image": "linux", "cpus": 2, "memory_bytes": 2 * gib, "disk_bytes": 4 * gib, "sleep_after_ms": 1_800_000], sandboxID: "sandbox_1")
        XCTAssertEqual(error["code"] as? String, "invalid_input")
        XCTAssertEqual(error["message"] as? String, "could not create small: image linux's disk is 8 GiB, the least a sandbox from it gets, and 4 GiB was asked for")
        XCTAssertFalse(FileManager.default.fileExists(atPath: rig.root.appendingPathComponent("sandbox_1").path), "nothing is laid down")
    }

    func testResizeGrowsARunningSandboxsDiskThroughARestartAndRefusesToShrinkIt() async throws {
        let rig = try Rig(test: self)
        _ = try await result(rig.host, "sandbox.create", Self.create("one"), sandboxID: "sandbox_1")
        let resized = try await result(rig.host, "sandbox.resize", ["disk_bytes": 64 * gib], sandboxID: "sandbox_1")
        let action = try XCTUnwrap((resized["actions"] as? [[String: Any]])?.first)
        XCTAssertEqual(action["kind"] as? String, "restarted")
        XCTAssertTrue((action["detail"] as? String)?.hasPrefix("restarted one at 2 CPUs, 2 GiB of memory and 64 GiB of disk;") == true, "\(action)")
        XCTAssertTrue((action["detail"] as? String)?.hasSuffix("; its filesystem grew into its 64 GiB disk") == true, "\(action)")
        XCTAssertEqual((resized["produced"] as? [String: Any])?["disk_bytes"] as? UInt64, 64 * gib)
        XCTAssertEqual(rig.factory.log.events.filter { $0.hasPrefix("grow disk") }, ["grow disk \(64 * gib)"])
        XCTAssertEqual(rig.claims.value.count, 1)

        let smaller = try await failure(rig.host, "sandbox.resize", ["disk_bytes": 32 * gib], sandboxID: "sandbox_1")
        XCTAssertEqual(smaller["code"] as? String, "invalid_input")
        XCTAssertEqual(smaller["message"] as? String, "a sandbox's disk only grows: one's is 64 GiB, and 32 GiB was asked for")
        let same = try await result(rig.host, "sandbox.resize", ["disk_bytes": 64 * gib], sandboxID: "sandbox_1")
        XCTAssertEqual((same["actions"] as? [[String: Any]])?.count, 0, "the size it has changes nothing")
    }

    func testAStoppedOrAsleepSandboxsDiskGrowsAtItsNextBoot() async throws {
        let rig = try Rig(test: self)
        _ = try await result(rig.host, "sandbox.create", Self.create("one"), sandboxID: "sandbox_1")
        _ = try await result(rig.host, "sandbox.stop", "{}", sandboxID: "sandbox_1")
        let stopped = try await result(rig.host, "sandbox.resize", ["disk_bytes": 20 * gib], sandboxID: "sandbox_1")
        XCTAssertEqual((stopped["actions"] as? [[String: Any]])?.count, 0, "a stopped sandbox only records the size")
        XCTAssertFalse(rig.factory.log.events.contains { $0.hasPrefix("grow disk") }, "nothing grows until it boots")
        _ = try await result(rig.host, "sandbox.start", "{}", sandboxID: "sandbox_1")
        XCTAssertEqual(rig.factory.log.events.filter { $0.hasPrefix("grow disk") }, ["grow disk \(20 * gib)"])

        _ = try await result(rig.host, "sandbox.sleep", "{}", sandboxID: "sandbox_1")
        let asleep = try await result(rig.host, "sandbox.resize", ["disk_bytes": 24 * gib], sandboxID: "sandbox_1")
        XCTAssertEqual((asleep["actions"] as? [[String: Any]])?.first?["detail"] as? String, "resized one to 2 CPUs, 2 GiB of memory and 24 GiB of disk while asleep; its processes ended, and it cold-boots at its next use")
        XCTAssertFalse(FileManager.default.fileExists(atPath: rig.root.appendingPathComponent("sandbox_1/state.vzsave").path), "the saved state a larger disk would invalidate is gone")
        _ = try await result(rig.host, "sandbox.start", "{}", sandboxID: "sandbox_1")
        XCTAssertEqual(rig.factory.log.events.filter { $0.hasPrefix("grow disk") }.last, "grow disk \(24 * gib)")
        XCTAssertEqual(rig.claims.value.count, 2)
    }

    func testAFailedClaimLeavesTheSandboxRunningAndIsTriedAgainAtTheNextBoot() async throws {
        let rig = try Rig(test: self, claimFails: true)
        let created = try await result(rig.host, "sandbox.create", Self.create("one", disk: 16 * gib), sandboxID: "sandbox_1")
        XCTAssertEqual((created["produced"] as? [String: Any])?["state"] as? String, "running", "the sandbox runs at its old filesystem size")
        let boot = (created["actions"] as? [[String: Any]])?.first { $0["kind"] as? String == "cold_booted" }
        XCTAssertEqual(boot?["detail"] as? String, "cold-booted one; its disk is 16 GiB, but the guest could not grow its filesystem into it (tried again at its next boot): growing its filesystem in the guest exited 1: resize2fs: Permission denied")
        XCTAssertTrue(try rig.record("sandbox_1").diskClaimPending)
        let status = try await result(rig.host, "sandbox.status", sandboxID: "sandbox_1")
        XCTAssertTrue((status["detail"] as? String)?.contains("could not grow its filesystem") == true, "\(status)")

        rig.claimFails.value = false
        _ = try await result(rig.host, "sandbox.stop", "{}", sandboxID: "sandbox_1")
        _ = try await result(rig.host, "sandbox.start", "{}", sandboxID: "sandbox_1")
        XCTAssertEqual(rig.claims.value.count, 2, "tried again")
        XCTAssertFalse(try rig.record("sandbox_1").diskClaimPending)
        XCTAssertEqual(rig.factory.log.events.filter { $0.hasPrefix("grow disk") }.count, 1, "the disk grew once")
    }

    // MARK: - Helpers

    static func create(_ name: String, disk: UInt64? = nil) -> [String: Any] {
        var input: [String: Any] = ["name": name, "image": "linux", "cpus": 2, "memory_bytes": 2 * gib, "sleep_after_ms": 1_800_000]
        if let disk { input["disk_bytes"] = disk }
        return input
    }

    /// One host on fake VMs whose guests answer `shell.exec`: a disk claim (recorded in `claims`, failing while
    /// `claimFails`) and everything else with an empty success.
    private struct Rig {
        let root: URL, factory: FakeBackendFactory, host: SandboxHost
        let claims = Locked<[String]>([]), claimFails: Locked<Bool>

        init(test: XCTestCase, claimFails fails: Bool = false) throws {
            root = try test.scratch()
            let claims = self.claims, claimFails = Locked(fails); self.claimFails = claimFails
            factory = FakeBackendFactory { request in
                let object = try JSONSerialization.jsonObject(with: request) as? [String: Any]
                guard object?["operation"] as? String == "shell.exec", let command = (object?["input"] as? [String: Any])?["command"] as? String else { return try JSONSerialization.data(withJSONObject: ["ok": true, "result": [:]]) }
                if command.hasPrefix("resize2fs") {
                    claims.withLock { $0.append(command) }
                    if claimFails.value { return try JSONSerialization.data(withJSONObject: ["ok": true, "result": ["exit_code": 1, "stdout": "", "stderr": "resize2fs: Permission denied"]]) }
                }
                return try JSONSerialization.data(withJSONObject: ["ok": true, "result": ["exit_code": 0, "stdout": "", "stderr": ""]])
            }
            host = try test.sandboxHost(sandboxesDirectory: root, factory: factory, hostCPUs: 8, hostMemoryBytes: 16 * gib)
        }

        func record(_ id: String) throws -> SandboxRecord { try SandboxDirectory(root.appendingPathComponent(id)).load() }
    }
}
