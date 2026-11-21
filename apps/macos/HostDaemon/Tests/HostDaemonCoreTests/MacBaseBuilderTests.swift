import XCTest
@testable import HostDaemonCore

/// `macos.build` through `image.create { macos }` as the relay sends it, on a fake VM driver whose guests are files:
/// the phase order, a resume from every checkpoint, the refusals before anything is journaled, and the password, which
/// must never reach a file.
final class MacBaseBuilderTests: XCTestCase {
    static let release = IPSWRelease(url: URL(string: "https://updates.example.com/UniversalMac_27.2.1_26B131_Restore.ipsw")!, version: "27.2.1", build: "26B131", sizeBytes: 4096)
    static let fullBuild = ["install", "provision", "upload /tmp/localbox-payload.tgz", "root bootstrap", "disable SIP", "boot", "root tcc", "root finish", "shut down"]

    func testABuildRunsEveryPhaseInOrderAndCommitsAMacOSImage() async throws {
        let rig = try await Rig(test: self)
        let record = try await rig.build("m-1", image: "image_mac")
        XCTAssertEqual(record["state"] as? String, "running", "image.create answers once the build moves past its first phase")
        let finished = try await rig.finished("m-1")
        XCTAssertEqual(finished.state, .succeeded, "\(String(describing: finished.error))")
        XCTAssertEqual(rig.driver.calls, Self.fullBuild)
        XCTAssertEqual(rig.driver.phasesSeen, ["install", "provision", "bootstrap", "bootstrap", "sip", "tcc", "tcc", "finish", "finish"], "each step runs after its phase is journaled")
        let manifest = try rig.store.manifest("image_mac")
        XCTAssertEqual(manifest.os, .macos)
        XCTAssertEqual(manifest.hardwareModel, Data("model".utf8).base64EncodedString())
        XCTAssertEqual(manifest.minMacOS, "27.0", "the IPSW's major release, so the 27.0.1 Mac that built it runs it")
        XCTAssertEqual(manifest.agentVersion, "0.1.1+abc")
        let image = rig.store.root.appendingPathComponent("image_mac")
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: image.path).sorted(), ["boot", "disk.img", "image.json"], "nothing of the build's own is committed")
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: image.appendingPathComponent("boot").path), ["aux.img"])
        XCTAssertTrue(rig.store.list().map(\.imageID) == ["image_mac"])
        XCTAssertTrue(IPSWCache(directory: rig.store.ipswDirectory).has(Self.release), "the IPSW stays cached for the next build")
        guard case .object(let result)? = finished.result else { return XCTFail("no result") }
        XCTAssertEqual(result["min_macos"], .string("27.0")); XCTAssertEqual(result["ipsw_version"], .string("27.2.1")); XCTAssertEqual(result["chrome_version"], .string("142.0.7444.60"))
        XCTAssertEqual(result["size_bytes"], .number(Double(manifest.sizeBytes)))
    }

    func testTheBuildStepsInstallTheAgentAndChromeThenGrantAndCloseRemoteLogin() async throws {
        let rig = try await Rig(test: self)
        _ = try await rig.build("m-1", image: "image_mac")
        _ = try await rig.finished("m-1")
        let scripts = rig.driver.scripts
        XCTAssertTrue(scripts[0].contains("sh /tmp/localbox-stage/install.sh"), "bootstrap runs the darwin agent's install.sh")
        XCTAssertTrue(scripts[0].contains("https://dl.google.com/chrome/mac/universal/stable/gcem/GoogleChrome.pkg") && scripts[0].contains("Developer ID Installer: Google LLC"), "Chrome comes from Google's own signed installer (P12)")
        XCTAssertFalse(scripts.joined().contains("xcode"), "no Xcode (L5)")
        XCTAssertTrue(scripts[1].contains("localbox-agent --grant-tcc") && scripts[1].contains("kickstart -k gui/"), "the desktop role restarts holding its grants")
        XCTAssertTrue(scripts[2].contains("launchctl disable system/com.openssh.sshd"), "finish turns Remote Login off for good")
        let payload = try XCTUnwrap(rig.driver.payload)
        let listing = try output("/usr/bin/tar", ["-tzf", payload.path])
        XCTAssertEqual(Set(listing.split(separator: "\n").map { String($0).replacingOccurrences(of: "./", with: "") }.filter { !$0.isEmpty }),
                       ["localbox-agent", "install.sh", "localbox-desktop", "localbox-vsock", "sh.localbox.agent.plist", "sh.localbox.desktop.plist", "sh.localbox.vsock.plist"])
    }

    func testThePasswordNeverReachesAFile() async throws {
        let rig = try await Rig(test: self)
        _ = try await rig.build("m-1", image: "image_mac")
        _ = try await rig.finished("m-1")
        let password = try XCTUnwrap(rig.driver.passwords.first)
        XCTAssertEqual(password.count, 20)
        XCTAssertFalse(rig.driver.journalsSeen.contains { $0.contains(password) }, "no journal write during the build carried it")
        for file in try everyFile(under: rig.root) {
            XCTAssertNil(try Data(contentsOf: file).range(of: Data(password.utf8)), "\(file.path) holds the password")
        }
    }

    func testAResumeContinuesFromEveryCheckpoint() async throws {
        let expected: [MacBaseBuilder.Phase: [String]] = [
            .download: Self.fullBuild,
            .install: Self.fullBuild,
            // The password died with the last run, so these start over on a fresh clone of the installed disk.
            .provision: Array(Self.fullBuild.dropFirst()), .bootstrap: Array(Self.fullBuild.dropFirst()), .sip: Array(Self.fullBuild.dropFirst()),
            .tcc: ["boot", "root tcc", "root finish", "shut down"],
            .finish: ["boot", "root finish", "shut down"],
        ]
        for phase in MacBaseBuilder.Phase.allCases {
            let rig = try await Rig(test: self, leftAt: phase)
            let finished = try await rig.finished("m-1")
            XCTAssertEqual(finished.state, .succeeded, "\(phase): \(String(describing: finished.error))")
            XCTAssertEqual(rig.driver.calls, expected[phase], "resumed at \(phase)")
            if [.provision, .bootstrap, .sip].contains(phase) {
                XCTAssertEqual(rig.driver.provisionedDisk, Data("installed".utf8), "\(phase) provisions a fresh clone of the installed disk, not the half-provisioned one")
            }
            XCTAssertEqual(try rig.store.manifest("image_mac").os, .macos)
        }
    }

    func testADownloadThatStopsResumesFromWhereItStopped() async throws {
        let rig = try await Rig(test: self, http: FakeHTTP(failAfter: 1000))
        _ = try await rig.build("m-1", image: "image_mac")
        let failed = try await rig.finished("m-1")
        XCTAssertEqual(failed.state, .failed)
        XCTAssertTrue(failed.error?.nextStep?.contains("resumes where it stopped") == true, "\(String(describing: failed.error))")
        XCTAssertTrue(rig.driver.calls.isEmpty, "nothing installs from half an IPSW")
        rig.http.failAfter = nil
        _ = try await rig.build("m-2", image: "image_mac2")
        let finished = try await rig.finished("m-2")
        XCTAssertEqual(finished.state, .succeeded, "\(String(describing: finished.error))")
        XCTAssertEqual(rig.http.offsets, [0, 1000], "the second build fetched only what the first did not")
        XCTAssertEqual(try Data(contentsOf: IPSWCache(directory: rig.store.ipswDirectory).file(for: Self.release)), FakeHTTP.body)
    }

    func testAFailedBuildLeavesNoBuildDirectoryButKeepsTheIPSW() async throws {
        let rig = try await Rig(test: self)
        rig.driver.failing = "root bootstrap"
        _ = try await rig.build("m-1", image: "image_mac")
        let failed = try await rig.finished("m-1")
        XCTAssertEqual(failed.state, .failed)
        XCTAssertEqual(failed.error?.code, "internal")
        XCTAssertTrue(failed.error?.message.hasPrefix("the macOS build stopped in bootstrap") == true, "\(String(describing: failed.error))")
        XCTAssertFalse(FileManager.default.fileExists(atPath: rig.store.root.appendingPathComponent(".image_mac.build").path), "nothing resumes a failed build, so its files go")
        XCTAssertTrue(IPSWCache(directory: rig.store.ipswDirectory).has(Self.release), "the next build reuses the IPSW")
    }

    func testRefusalsComeBeforeAnythingIsJournaled() async throws {
        let old = try await Rig(test: self, hostVersion: "26.4")
        let incompatible = try await old.request(["macos": true, "image": "image_mac"], key: "m-1")
        XCTAssertEqual((incompatible["error"] as? [String: Any])?["code"] as? String, "image_incompatible")
        let journals = await old.operations.state("m-1")
        XCTAssertNil(journals)

        // The 60 GB disk plus the 4 KiB IPSW: one byte short is refused; with the IPSW cached it fits.
        let tight = try await Rig(test: self, freeBytes: MacBaseBuilder.diskBytes + 4095)
        let full = try await tight.request(["macos": true, "image": "image_mac"], key: "m-1")
        let error = try XCTUnwrap(full["error"] as? [String: Any])
        XCTAssertEqual(error["code"] as? String, "disk_full")
        XCTAssertTrue(((error["details"] as? [String: Any])?["next_step"] as? String)?.hasPrefix("free at least") == true, "\(error)")
        try FileManager.default.createDirectory(at: tight.store.ipswDirectory, withIntermediateDirectories: true)
        try FakeHTTP.body.write(to: IPSWCache(directory: tight.store.ipswDirectory).file(for: Self.release))
        let cached = try await tight.request(["macos": true, "image": "image_mac"], key: "m-2")
        XCTAssertEqual((cached["result"] as? [String: Any])?["kind"] as? String, MacBaseBuilder.kind, "\(cached)")
        _ = try await tight.finished("m-2")
    }

    func testAReplayReturnsTheSameBuild() async throws {
        let rig = try await Rig(test: self)
        let first = try await rig.build("m-1", image: "image_mac")
        let replay = try await rig.build("m-1", image: "image_mac")
        XCTAssertEqual(first["started_at"] as? Int, replay["started_at"] as? Int)
        _ = try await rig.finished("m-1")
        XCTAssertEqual(rig.driver.calls.filter { $0 == "install" }.count, 1)
    }

    func testTheStartSweepKeepsARunningBuildsDirectoryAndTheIPSWCache() throws {
        let root = try scratch()
        let store = try ImageStore(imagesDirectory: root)
        let build = try store.buildDirectory("image_mac")
        try FileManager.default.createDirectory(at: store.ipswDirectory, withIntermediateDirectories: true)
        let stray = try store.reserveTemp("image_gone")
        XCTAssertEqual(store.sweepTemps(keeping: ["image_mac"]), [stray.lastPathComponent])
        XCTAssertTrue(FileManager.default.fileExists(atPath: build.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: store.ipswDirectory.path))
        XCTAssertEqual(store.sweepTemps(), [build.lastPathComponent], "a finished build's directory goes; the cache never does")
    }

    // MARK: - Helpers

    private func scratch() throws -> URL {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("lb-macbuild-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        return root
    }

    private func everyFile(under root: URL) throws -> [URL] {
        let enumerator = try XCTUnwrap(FileManager.default.enumerator(at: root, includingPropertiesForKeys: [.isRegularFileKey]))
        return enumerator.compactMap { $0 as? URL }.filter { (try? $0.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true }
    }

    /// A daemon's image side with a fake driver: store, journal, builder and `ImageHost`, under one scratch root.
    private struct Rig {
        let root: URL, store: ImageStore, operations: HostOperationStore, images: ImageHost, driver: FakeDriver, http: FakeHTTP

        /// `leftAt` restarts a build the last run left just before that phase: its journal and files exist before the store loads.
        init(test: MacBaseBuilderTests, http: FakeHTTP = FakeHTTP(), hostVersion: String = "27.0.1", freeBytes: UInt64 = .max, leftAt: MacBaseBuilder.Phase? = nil) async throws {
            root = try test.scratch()
            self.http = http
            store = try ImageStore(imagesDirectory: root.appendingPathComponent("images"))
            try FileManager.default.createDirectory(at: root.appendingPathComponent("operations"), withIntermediateDirectories: true)
            if let leftAt { try Self.leaveBuild(at: leftAt, store: store, root: root) }
            operations = try HostOperationStore(operationsDirectory: root.appendingPathComponent("operations"))
            driver = FakeDriver(journals: root.appendingPathComponent("operations"), operations: operations)
            let agent = root.appendingPathComponent("guest-agent", isDirectory: true)
            try FileManager.default.createDirectory(at: agent.appendingPathComponent("darwin"), withIntermediateDirectories: true)
            try Data("agent".utf8).write(to: agent.appendingPathComponent("localbox-agent-darwin-arm64"))
            try Data(#"{"version":"0.1.1+abc"}"#.utf8).write(to: agent.appendingPathComponent("agent-version.json"))
            for name in ["install.sh", "localbox-desktop", "localbox-vsock", "sh.localbox.agent.plist", "sh.localbox.desktop.plist", "sh.localbox.vsock.plist"] { try Data(name.utf8).write(to: agent.appendingPathComponent("darwin/\(name)")) }
            let builder = MacBaseBuilder(store: store, operations: operations, driver: driver, catalog: FakeCatalog(), http: http, guestAgent: agent, hostVersion: { hostVersion }, freeBytes: { freeBytes })
            await builder.register()
            images = ImageHost(operations: operations, macBuilder: builder)
            await operations.start()
        }

        func request(_ input: [String: Any], key: String) async throws -> [String: Any] {
            let envelope: [String: Any] = ["protocol_version": "v1", "request_id": "r-\(UUID().uuidString)", "operation": "image.create", "sandbox_id": NSNull(), "deadline_ms": 30_000, "mutation_id": key, "input": input]
            let answer = await images.request(try JSONSerialization.data(withJSONObject: envelope))
            return try XCTUnwrap(JSONSerialization.jsonObject(with: answer) as? [String: Any])
        }

        func build(_ key: String, image: String) async throws -> [String: Any] {
            let response = try await request(["macos": true, "image": image], key: key)
            return try XCTUnwrap(response["result"] as? [String: Any], "\(response)")
        }

        func finished(_ key: String) async throws -> HostOperationRecord {
            for _ in 0..<200 {
                if let record = await operations.wait(key, timeoutMs: 5_000), record.state != .running { return record }
            }
            throw Timeout()
        }

        /// A journal and build directory as a run that stopped just before `phase` leaves them.
        static func leaveBuild(at phase: MacBaseBuilder.Phase, store: ImageStore, root: URL) throws {
            if phase != .download {
                try FileManager.default.createDirectory(at: store.ipswDirectory, withIntermediateDirectories: true)
                try FakeHTTP.body.write(to: IPSWCache(directory: store.ipswDirectory).file(for: MacBaseBuilderTests.release))
            }
            let build = MacBuildDirectory(root: try store.buildDirectory("image_mac"))
            if ![.download, .install].contains(phase) { try FakeDriver.writeInstalled(build) }
            if [.bootstrap, .sip, .tcc, .finish].contains(phase) {
                try build.resetWorkCopy()
                try Data("half-provisioned".utf8).write(to: build.disk)
            }
            let checkpoint = try JSONSerialization.jsonObject(with: JSONEncoder().encode(MacBaseBuilder.Checkpoint(phase: phase, ipsw: MacBaseBuilderTests.release)))
            let record: [String: Any] = ["key": "m-1", "kind": MacBaseBuilder.kind, "subject": "image_mac", "state": "running", "checkpoint": checkpoint, "started_at": 1, "updated_at": 1]
            try JSONSerialization.data(withJSONObject: record).write(to: root.appendingPathComponent("operations/m-1.json"))
        }
    }
}

private struct Timeout: Error {}

private struct FakeCatalog: IPSWCatalog {
    func latest() async throws -> IPSWRelease { MacBaseBuilderTests.release }
}

/// Serves `body` by range; `failAfter` drops the connection once that many bytes of the file exist.
private final class FakeHTTP: RangedHTTP, @unchecked Sendable {
    static let body = Data((0..<4096).map { UInt8(truncatingIfNeeded: $0 &* 7) })
    private let lock = NSLock()
    private var _failAfter: Int?, _offsets: [UInt64] = []
    var failAfter: Int? { get { lock.withLock { _failAfter } } set { lock.withLock { _failAfter = newValue } } }
    var offsets: [UInt64] { lock.withLock { _offsets } }
    init(failAfter: Int? = nil) { _failAfter = failAfter }

    func length(of url: URL) async throws -> UInt64 { UInt64(Self.body.count) }
    func fetch(_ url: URL, from offset: UInt64, appendingTo file: FileHandle, progress: @escaping @Sendable (UInt64) -> Void) async throws {
        lock.withLock { _offsets.append(offset) }
        let end = failAfter.map { min($0, Self.body.count) } ?? Self.body.count
        try file.write(contentsOf: Self.body.subdata(in: Int(offset)..<max(Int(offset), end)))
        progress(UInt64(end) - offset)
        if end < Self.body.count { throw URLError(.networkConnectionLost) }
    }
}

/// Guests made of files. Records each step, the phase journaled when it ran, every password it was handed, every
/// journal write it could see, and the disk a provisioning boot started from.
private final class FakeDriver: MacBuildDriver, @unchecked Sendable {
    let journals: URL, operations: HostOperationStore
    private let lock = NSLock()
    private var _calls: [String] = [], _phases: [String] = [], _passwords: [String] = [], _journals: [String] = [], _scripts: [String] = []
    private var _payload: URL?, _provisionedDisk: Data?, _failing: String?
    /// A step that throws, as a guest step that exits non-zero would.
    var failing: String? { get { lock.withLock { _failing } } set { lock.withLock { _failing = newValue } } }
    var calls: [String] { lock.withLock { _calls } }
    var phasesSeen: [String] { lock.withLock { _phases } }
    var passwords: [String] { lock.withLock { _passwords } }
    var journalsSeen: [String] { lock.withLock { _journals } }
    var scripts: [String] { lock.withLock { _scripts } }
    var payload: URL? { lock.withLock { _payload } }
    var provisionedDisk: Data? { lock.withLock { _provisionedDisk } }
    init(journals: URL, operations: HostOperationStore) { self.journals = journals; self.operations = operations }

    static func writeInstalled(_ build: MacBuildDirectory) throws {
        try Data("installed".utf8).write(to: build.installedDisk)
        try Data("aux".utf8).write(to: build.installedAux)
        try Data("model".utf8).write(to: build.hardwareModel)
        try Data("identifier".utf8).write(to: build.machineIdentifier)
        try Data("02:00:00:00:00:02".utf8).write(to: build.mac)
    }

    /// Records step `name` of the build in `build`, with the phase its operation last journaled.
    func step(_ name: String, _ build: MacBuildDirectory, script: String? = nil, payload: URL? = nil) async throws {
        let subject = String(build.root.lastPathComponent.dropFirst().dropLast(".build".count))
        let phase = await operations.latest(subject: subject)?.progress?.phase ?? ""
        let written = (try? FileManager.default.contentsOfDirectory(at: journals, includingPropertiesForKeys: nil))?.compactMap { try? String(contentsOf: $0, encoding: .utf8) } ?? []
        lock.withLock {
            _calls.append(name); _phases.append(phase); _journals.append(contentsOf: written)
            if let script { _scripts.append(script) }
            if let payload { _payload = payload }
        }
        if name == failing { throw HostDaemonError.unsupported("a build step in the guest exited 56") }
    }

    func install(ipsw: URL, into build: MacBuildDirectory, diskBytes: UInt64, progress: @escaping @Sendable (Double) -> Void) async throws {
        XCTAssertEqual(try Data(contentsOf: ipsw), FakeHTTP.body, "installs the cached IPSW")
        try Self.writeInstalled(build)
        try await step("install", build)
    }

    func provision(_ build: MacBuildDirectory, user: MacProvisioningUser) async throws -> any MacBuildGuest {
        lock.withLock { _passwords.append(user.password); _provisionedDisk = try? Data(contentsOf: build.disk) }
        try await step("provision", build)
        return FakeGuest(driver: self, build: build)
    }

    func boot(_ build: MacBuildDirectory) async throws -> any MacBuildGuest {
        try await step("boot", build)
        return FakeGuest(driver: self, build: build, throughAgent: true)
    }
}

private struct FakeGuest: MacBuildGuest {
    let driver: FakeDriver, build: MacBuildDirectory
    /// Booted normally, so its steps go through the agent's request lane, which refuses deadlines over 120 s.
    var throughAgent = false
    func root(_ script: String, timeout: TimeInterval) async throws -> String {
        if throughAgent { XCTAssertLessThanOrEqual(timeout, 120, "a step through the agent must fit its 120 s request deadline") }
        let name = script.contains("install.sh") ? "bootstrap" : script.contains("--grant-tcc") ? "tcc" : script.contains("openssh") ? "finish" : "other"
        try await driver.step("root \(name)", build, script: script)
        return name == "finish" ? "142.0.7444.60\n" : ""
    }
    func upload(_ local: URL, to remote: String) async throws {
        let copy = FileManager.default.temporaryDirectory.appendingPathComponent("lb-payload-\(UUID().uuidString).tgz")
        try FileManager.default.copyItem(at: local, to: copy)
        try await driver.step("upload \(remote)", build, payload: copy)
    }
    func shutDown() async throws { try await driver.step("shut down", build) }
    func disableSIP(as user: MacProvisioningUser) async throws { try await driver.step("disable SIP", build) }
    func abandon() async {}
}

private func output(_ tool: String, _ arguments: [String]) throws -> String {
    let process = Process(); process.executableURL = URL(fileURLWithPath: tool); process.arguments = arguments
    let out = Pipe(); process.standardOutput = out
    try process.run(); let data = out.fileHandleForReading.readDataToEndOfFile(); process.waitUntilExit()
    return String(decoding: data, as: UTF8.self)
}
