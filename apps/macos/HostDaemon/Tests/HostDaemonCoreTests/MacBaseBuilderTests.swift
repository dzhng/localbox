import XCTest
@testable import HostDaemonCore

/// `macos.build` through `image.create { macos }` as the relay sends it, on a fake VM driver whose guests are files:
/// the phase order, a resume from every checkpoint, the refusals before anything is journaled, and the password, which
/// must never reach a file.
final class MacBaseBuilderTests: XCTestCase {
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
        XCTAssertTrue(IPSWCache(directory: rig.store.ipswDirectory).has(fakeIPSW), "the IPSW stays cached for the next build")
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
        XCTAssertTrue(scripts[0].contains("defaults write '/Library/Managed Preferences/com.google.Chrome' BrowserSignin -int 0") && scripts[0].contains("DefaultNotificationsSetting -int 2"), "Chrome's sign-in prompt and notification asks are off by policy")
        XCTAssertTrue(scripts[1].contains("localbox-agent --grant-tcc") && scripts[1].contains("kickstart -k gui/"), "the desktop role restarts holding its grants")
        XCTAssertTrue(scripts[1].contains("launchctl disable gui/$(id -u localbox)/com.apple.notificationcenterui.agent"), "no notification banner covers a screenshot")
        XCTAssertTrue(scripts[2].contains("launchctl disable system/com.openssh.sshd"), "finish turns Remote Login off for good")
        let payload = try XCTUnwrap(rig.driver.payload)
        let listing = await output("/usr/bin/tar", ["-tzf", payload.path])
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
        XCTAssertEqual(try Data(contentsOf: IPSWCache(directory: rig.store.ipswDirectory).file(for: fakeIPSW)), FakeHTTP.body)
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
        XCTAssertTrue(IPSWCache(directory: rig.store.ipswDirectory).has(fakeIPSW), "the next build reuses the IPSW")
    }

    func testWithoutApplesCatalogABuildUsesTheNewestCachedRelease() async throws {
        let rig = try await Rig(test: self)
        _ = try await rig.build("m-1", image: "image_mac")
        _ = try await rig.finished("m-1")
        rig.catalog.fails = true
        let rebuilt = try await rig.build("m-2", image: "image_mac2")
        let finished = try await rig.finished("m-2")
        XCTAssertEqual(finished.state, .succeeded, "\(rebuilt) \(String(describing: finished.error))")
        XCTAssertEqual(rig.http.offsets, [0], "nothing was downloaded the second time")
        XCTAssertEqual(try rig.store.manifest("image_mac2").minMacOS, "27.0")

        let empty = try await Rig(test: self)
        empty.catalog.fails = true
        let refused = try await empty.request(["macos": true, "image": "image_mac"], key: "m-1")
        XCTAssertEqual((refused["error"] as? [String: Any])?["code"] as? String, "internal", "with nothing cached there is no release to build")
    }

    func testRefusalsComeBeforeAnythingIsJournaled() async throws {
        let old = try await Rig(test: self, hostVersion: "26.4")
        let incompatible = try await old.request(["macos": true, "image": "image_mac"], key: "m-1")
        XCTAssertEqual((incompatible["error"] as? [String: Any])?["code"] as? String, "image_incompatible")
        let journals = await old.operations.state("m-1")
        XCTAssertNil(journals)

        // The 50 GB disk plus the 4 KiB IPSW: one byte short is refused; with the IPSW cached it fits.
        let tight = try await Rig(test: self, freeBytes: MacBaseBuilder.diskBytes + 4095)
        let full = try await tight.request(["macos": true, "image": "image_mac"], key: "m-1")
        let error = try XCTUnwrap(full["error"] as? [String: Any])
        XCTAssertEqual(error["code"] as? String, "disk_full")
        XCTAssertTrue(((error["details"] as? [String: Any])?["next_step"] as? String)?.hasPrefix("free at least") == true, "\(error)")
        try FileManager.default.createDirectory(at: tight.store.ipswDirectory, withIntermediateDirectories: true)
        try FakeHTTP.body.write(to: IPSWCache(directory: tight.store.ipswDirectory).file(for: fakeIPSW))
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
        let build = try store.buildDirectory("image_mac").root
        try FileManager.default.createDirectory(at: store.ipswDirectory, withIntermediateDirectories: true)
        let stray = try store.reserveTemp("image_gone")
        XCTAssertEqual(store.sweepTemps(keeping: ["image_mac"]), [stray.lastPathComponent])
        XCTAssertTrue(FileManager.default.fileExists(atPath: build.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: store.ipswDirectory.path))
        XCTAssertEqual(store.sweepTemps(), [build.lastPathComponent], "a finished build's directory goes; the cache never does")
    }

    // MARK: - Helpers

    private func everyFile(under root: URL) throws -> [URL] {
        let enumerator = try XCTUnwrap(FileManager.default.enumerator(at: root, includingPropertiesForKeys: [.isRegularFileKey]))
        return enumerator.compactMap { $0 as? URL }.filter { (try? $0.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true }
    }

    /// A daemon with a fake build driver and guest agent build, its journal started, under one scratch root.
    private struct Rig {
        let rig: TestDaemon, driver: FakeMacDriver, http: FakeHTTP, catalog = FakeCatalog()
        var root: URL { rig.root }
        var store: ImageStore { rig.store }
        var operations: HostOperationStore { rig.operations }

        /// `leftAt` restarts a build the last run left just before that phase: its journal and files exist before the store loads.
        init(test: MacBaseBuilderTests, http: FakeHTTP = FakeHTTP(), hostVersion: String = "27.0.1", freeBytes: UInt64? = nil, leftAt: MacBaseBuilder.Phase? = nil) async throws {
            let root = try test.scratch()
            self.http = http
            try FileManager.default.createDirectory(at: root.appendingPathComponent("operations"), withIntermediateDirectories: true)
            if let leftAt { try Self.leaveBuild(at: leftAt, store: try ImageStore(imagesDirectory: root.appendingPathComponent("images")), root: root) }
            driver = FakeMacDriver(journals: root.appendingPathComponent("operations"))
            let agent = root.appendingPathComponent("guest-agent", isDirectory: true)
            try FileManager.default.createDirectory(at: agent.appendingPathComponent("darwin"), withIntermediateDirectories: true)
            try Data("agent".utf8).write(to: agent.appendingPathComponent("localbox-agent-darwin-arm64"))
            try Data(#"{"version":"0.1.1+abc"}"#.utf8).write(to: agent.appendingPathComponent("agent-version.json"))
            for name in ["install.sh", "localbox-desktop", "localbox-vsock", "sh.localbox.agent.plist", "sh.localbox.desktop.plist", "sh.localbox.vsock.plist"] { try Data(name.utf8).write(to: agent.appendingPathComponent("darwin/\(name)")) }
            rig = try await TestDaemon(root: root, freeBytes: freeBytes, macDriver: driver, catalog: catalog, http: http, guestAgent: agent, hostVersion: hostVersion)
            await rig.operations.start()
        }

        func request(_ input: [String: Any], key: String) async throws -> [String: Any] {
            try await call(rig.daemon, envelope("image.create", input, mutation: key))
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
                try FakeHTTP.body.write(to: IPSWCache(directory: store.ipswDirectory).file(for: fakeIPSW))
            }
            let build = try store.buildDirectory("image_mac")
            if ![.download, .install].contains(phase) { try FakeMacDriver.writeInstalled(build) }
            if [.bootstrap, .sip, .tcc, .finish].contains(phase) {
                try build.resetWorkCopy()
                try Data("half-provisioned".utf8).write(to: build.disk)
            }
            let checkpoint = try JSONSerialization.jsonObject(with: JSONEncoder().encode(MacBaseBuilder.Checkpoint(phase: phase, ipsw: fakeIPSW)))
            let record: [String: Any] = ["key": "m-1", "kind": MacBaseBuilder.kind, "subject": "image_mac", "state": "running", "checkpoint": checkpoint, "started_at": 1, "updated_at": 1]
            try JSONSerialization.data(withJSONObject: record).write(to: root.appendingPathComponent("operations/m-1.json"))
        }
    }
}

private struct Timeout: Error {}

private func output(_ tool: String, _ arguments: [String]) async -> String { await runProcess(URL(fileURLWithPath: tool), arguments, timeout: 30).output }
