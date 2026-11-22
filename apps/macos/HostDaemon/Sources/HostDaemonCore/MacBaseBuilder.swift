import Foundation

/// The user a fresh macOS install is provisioned with: logged in automatically, Remote Login on, so the build reaches
/// the guest over SSH before any Localbox agent exists (P3). The password lives only in the builder's memory.
public struct MacProvisioningUser: Sendable {
    public static let defaultName = "localbox"
    public let name: String
    public let fullName: String
    public let password: String
    public init(name: String = MacProvisioningUser.defaultName, fullName: String = "Localbox", password: String) { self.name = name; self.fullName = fullName; self.password = password }

    /// 20 characters with no look-alikes, typed into Recovery's Terminal, so nothing that needs a shift on a VNC keyboard
    /// beyond capitals.
    public static func randomPassword() -> String {
        let alphabet = Array("abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789")
        var generator = SystemRandomNumberGenerator()
        return String((0..<20).map { _ in alphabet.randomElement(using: &generator)! })
    }
}

/// The VM side of a macOS base build. `AppleMacBuildDriver` boots real guests; tests pass a fake.
public protocol MacBuildDriver: Sendable {
    /// Installs `ipsw` as the build's pristine guest: its installed disk of `diskBytes`, auxiliary storage, hardware
    /// model and identity.
    func install(ipsw: URL, into build: MacBuildDirectory, diskBytes: UInt64, progress: @escaping @Sendable (Double) -> Void) async throws
    /// Boots the work copy for the first time with `user` provisioned (auto-login, Remote Login on); the guest answers
    /// over SSH as that user.
    func provision(_ build: MacBuildDirectory, user: MacProvisioningUser) async throws -> any MacProvisionedGuest
    /// Boots the work copy normally; the guest answers through the Localbox agent's root shell over vsock.
    func boot(_ build: MacBuildDirectory) async throws -> any MacAgentGuest
}

/// A booted build guest.
public protocol MacBuildGuest: Sendable {
    /// Runs `script` with `/bin/sh` as root; throws with its output unless it exits 0, else returns its stdout.
    func root(_ script: String, timeout: TimeInterval) async throws -> String
    /// Stops the VM at once (a failed phase leaves nothing running).
    func abandon() async
}

/// The first boot of a fresh install, over SSH as the provisioned user: the payload goes in, and SIP is disabled.
public protocol MacProvisionedGuest: MacBuildGuest {
    func upload(_ local: URL, to remote: String) async throws
    /// Shuts down, boots Recovery and runs `csrutil disable` as `user` on its Terminal; ends powered off.
    func disableSIP(as user: MacProvisioningUser) async throws
}

/// A normal boot, through the Localbox agent.
public protocol MacAgentGuest: MacBuildGuest {
    /// Shuts the guest down from inside and waits for it to power off.
    func shutDown() async throws
}

/// Host operation kind `macos.build` (`image create --macos`): builds the account's macOS base on this Mac from
/// Apple's latest IPSW with no human step, and commits it through `ImageStore` as an `os: macos` image.
///
/// Phases, each journaled as the checkpoint's next phase before it runs: `download` (resumable, into the IPSW cache),
/// `install`, `provision` (a fresh clone of the installed disk, first boot with a random password and Remote Login),
/// `bootstrap` (over SSH: the darwin agent, its forwarder, helper and units, and Chrome from Google's installer, P12), `sip` (Recovery's Terminal), `tcc` and `finish` (through the agent's root shell: grants and a quiet
/// desktop, then Remote Login off, shut down, commit). The password lives only in this process's memory: a restart
/// during `bootstrap` or `sip` resumes from `provision` on a fresh clone; `tcc` and `finish` need no password and resume
/// where they were. The IPSW (URL, version, size) is chosen once at `begin` and kept in the checkpoint. From `install`
/// on, a build runs a macOS VM, which takes one of the two this Mac may run: before its first boot in a run (a resume
/// after a restart included) it takes the slot through `SandboxHost`'s admission, which sleeps an idle macOS sandbox
/// for it (kept in the checkpoint and the result as `made_room`) or fails the build `machine_full`.
public actor MacBaseBuilder: HostOperationKind {
    public static let kind = "macos.build"
    /// The guest's disk: 50 GB, the low end of the 50–80 GB the spec delegates and the size the map's E14 measures; the
    /// built base holds about 30 GB of it (Chrome and the agent included).
    public static let diskBytes: UInt64 = 50_000_000_000
    /// How a building guest is named in the agent's hello (its host name until a sandbox renames it).
    static let guestName = "localbox-macos-base"

    public enum Phase: String, Codable, Sendable, CaseIterable {
        case download, install, provision, bootstrap, sip, tcc, finish
    }

    /// The checkpoint: the phase to run next, the release chosen at `begin`, and what sleeping sandboxes made room for
    /// the build's VM.
    struct Checkpoint: Codable, Equatable {
        var phase: Phase
        let ipsw: IPSWRelease
        var madeRoom: [String] = []
        enum CodingKeys: String, CodingKey { case phase, ipsw, madeRoom = "made_room" }
    }

    private let store: ImageStore
    private let operations: HostOperationStore
    private let driver: any MacBuildDriver
    private let catalog: any IPSWCatalog
    private let http: any RangedHTTP
    private let guestAgent: URL?
    private let hostVersion: @Sendable () -> String
    private let cache: IPSWCache
    /// The owner of this Mac's macOS VM slots, which a build's VM takes one of.
    private let sandboxes: SandboxHost

    /// `guestAgent` is the host's guest agent build (`LOCALBOX_GUEST_AGENT`: the darwin binary, `agent-version.json` and
    /// `darwin/`); without it `begin` refuses. The rest default to the real Mac and Apple.
    public init(store: ImageStore, operations: HostOperationStore, sandboxes: SandboxHost, driver: any MacBuildDriver, catalog: any IPSWCatalog, http: any RangedHTTP = URLSessionRangedHTTP(), guestAgent: URL?,
                hostVersion: (@Sendable () -> String)? = nil) {
        self.store = store; self.operations = operations; self.sandboxes = sandboxes; self.driver = driver; self.catalog = catalog; self.http = http; self.guestAgent = guestAgent
        self.hostVersion = hostVersion ?? { ProcessInfo.processInfo.operatingSystemVersion.dotted }
        cache = IPSWCache(directory: store.ipswDirectory)
    }

    /// Starts building image `imageID` under `key` (the create's mutation id), or returns the operation already under
    /// that key. A host older than macOS 27 (`image_incompatible`), a Mac without room for the IPSW and the disk
    /// (`disk_full`) or without a guest agent build is refused before anything is journaled.
    public func begin(key: String, imageID: String) async throws -> HostOperationRecord {
        if let existing = await operations.state(key) { return existing }
        let host = hostVersion()
        guard (Int(host.split(separator: ".").first ?? "") ?? 0) >= 27 else {
            throw HostOperationFailure(code: "image_incompatible", message: "building a macOS image needs macOS 27 or later on this Mac, and it runs macOS \(host)", nextStep: "update this Mac to macOS 27, or build on another Mac with --machine")
        }
        guard let guestAgent, FileManager.default.fileExists(atPath: guestAgent.appendingPathComponent("darwin").path) else {
            throw HostOperationFailure(code: "unsupported", message: "this Mac's Localbox has no darwin guest agent build to install in a macOS image", nextStep: "reinstall Localbox, then build again")
        }
        // Apple's catalog names the release; when it can't answer (offline, or its service failing, as it does inside a
        // daemon that already ran an install), the newest release cached whole is built instead.
        let release: IPSWRelease
        do { release = try await catalog.latest(); try? cache.remember(release) }
        catch {
            guard let cached = cache.newestCached() else { throw HostOperationFailure(code: "internal", message: "could not ask Apple for the latest macOS restore image: \(explain(error))", nextStep: "check this Mac's internet connection, then build again") }
            release = cached
        }
        let missing = cache.missingBytes(release)
        try store.requireFree(missing + Self.diskBytes, for: "building a macOS image",
                              because: missing > 0 ? "the macOS \(release.version) IPSW, \(gibibytes(missing)), and a \(gibibytes(Self.diskBytes)) disk" : "its \(gibibytes(Self.diskBytes)) disk",
                              then: "build again")
        return try await operations.begin(kind: Self.kind, key: key, subject: imageID, checkpoint: try JSONValue(encoding: Checkpoint(phase: .download, ipsw: release)))
    }

    func run(_ context: HostOperationContext) async throws -> JSONValue {
        do { let result = try await build(context); await sandboxes.releaseMacOSSlot(build: context.key); return result }
        catch { await sandboxes.releaseMacOSSlot(build: context.key); throw error }
    }

    private func build(_ context: HostOperationContext) async throws -> JSONValue {
        var checkpoint: Checkpoint
        do { checkpoint = try context.checkpoint.decoded(as: Checkpoint.self) } catch { throw HostOperationFailure(code: "invalid_input", message: "macos.build needs a checkpoint { phase, ipsw }") }
        let imageID = context.subject
        if let manifest = try? store.manifest(imageID) { return result(manifest, checkpoint, chrome: nil) }
        let build = try store.buildDirectory(imageID)
        var chrome: String?
        func advance(to phase: Phase) async throws {
            checkpoint.phase = phase
            try await context.report(HostOperationProgress(phase: phase.rawValue), checkpoint: try JSONValue(encoding: checkpoint))
        }
        do {
            loop: while true {
                if checkpoint.phase != .download { try await takeSlot(&checkpoint, context) }
                switch checkpoint.phase {
                case .download:
                    try await download(checkpoint, context)
                    try await advance(to: .install)
                case .install:
                    // An install is not resumable: whatever an interrupted one left is started over.
                    try store.discardBuild(imageID)
                    _ = try store.buildDirectory(imageID)
                    try await driver.install(ipsw: cache.file(for: checkpoint.ipsw), into: build, diskBytes: Self.diskBytes, progress: { _ in })
                    try await advance(to: .provision)
                case .provision, .bootstrap, .sip:
                    // Only this run knows the password, so all three run here, from a fresh clone of the installed disk.
                    let user = MacProvisioningUser(password: MacProvisioningUser.randomPassword())
                    if checkpoint.phase != .provision { try await advance(to: .provision) }
                    try build.resetWorkCopy()
                    let guest = try await driver.provision(build, user: user)
                    do {
                        try await advance(to: .bootstrap)
                        try await stagePayload(into: build)
                        try await guest.upload(build.payload, to: Self.remotePayload)
                        _ = try await guest.root(Self.bootstrapScript(user: user.name), timeout: 1_800)
                        try await advance(to: .sip)
                        try await guest.disableSIP(as: user)
                    } catch { await guest.abandon(); throw error }
                    try await advance(to: .tcc)
                case .tcc, .finish:
                    let guest = try await driver.boot(build)
                    do {
                        if checkpoint.phase == .tcc {
                            _ = try await guest.root(Self.tccScript(user: MacProvisioningUser.defaultName), timeout: 120)
                            try await advance(to: .finish)
                        }
                        chrome = try await guest.root(Self.finishScript, timeout: 120).trimmingCharacters(in: .whitespacesAndNewlines)
                        try await guest.shutDown()
                    } catch { await guest.abandon(); throw error }
                    break loop
                }
            }
            let hardwareModel = try Data(contentsOf: build.hardwareModel).base64EncodedString()
            for file in build.privateFiles { try? FileManager.default.removeItem(at: file) }
            let manifest = try store.seal(build.root, imageID: imageID, os: .macos, hardwareModel: hardwareModel, minMacOS: Self.minMacOS(checkpoint.ipsw), agentVersion: agentVersion())
            try store.commit(build.root, as: imageID)
            return result(manifest, checkpoint, chrome: chrome)
        } catch is CancellationError {
            // The daemon is stopping: the build directory stays for the next start's resume.
            throw CancellationError()
        } catch {
            // A failed operation is final, so nothing will resume from its build directory; the IPSW cache stays.
            try? store.discardBuild(imageID)
            if let failure = error as? HostOperationFailure { throw failure }
            throw HostOperationFailure(code: "internal", message: "the macOS build stopped in \(checkpoint.phase.rawValue): \(explain(error))", nextStep: "delete the failed image and build again; the downloaded IPSW is kept")
        }
    }

    /// The build's macOS VM slot, before its first boot in this run; what slept for it is journaled with the phase it is
    /// about to run. A Mac whose two macOS VMs can't make room fails the build `machine_full`, naming them.
    private func takeSlot(_ checkpoint: inout Checkpoint, _ context: HostOperationContext) async throws {
        let made: [SandboxAction]
        do { made = try await sandboxes.takeMacOSSlot(build: context.key, image: context.subject) } catch let refused as AdmissionRefused {
            throw HostOperationFailure(code: "machine_full", message: refused.message, nextStep: "stop or sleep a macOS sandbox on this Mac, then delete the failed image and build again; the downloaded IPSW is kept")
        }
        guard !made.isEmpty else { return }
        checkpoint.madeRoom += made.compactMap { $0["detail"] }
        try await context.report(HostOperationProgress(phase: checkpoint.phase.rawValue), checkpoint: try JSONValue(encoding: checkpoint))
    }

    /// The IPSW into the cache, journaling bytes held about every 2 s.
    private func download(_ checkpoint: Checkpoint, _ context: HostOperationContext) async throws {
        let release = checkpoint.ipsw, encoded = try JSONValue(encoding: checkpoint)
        let held = Locked<UInt64>(0)
        try await context.report(HostOperationProgress(phase: Phase.download.rawValue, completed: Int(release.sizeBytes - cache.missingBytes(release)), total: Int(release.sizeBytes)), checkpoint: encoded)
        if cache.has(release) { return }
        let reporter = Task {
            var last: UInt64 = 0
            while true {
                try await Task.sleep(nanoseconds: 2_000_000_000)
                let now = held.value
                if now != last { last = now; try await context.report(HostOperationProgress(phase: Phase.download.rawValue, completed: Int(now), total: Int(release.sizeBytes)), checkpoint: encoded) }
            }
        }
        // The reporter is stopped and awaited before the build moves on, so no late progress lands over the next phase.
        func stopReporting() async { reporter.cancel(); _ = await reporter.result }
        do { _ = try await cache.fetch(release, over: http) { held.value = $0 }; await stopReporting() }
        catch is CancellationError { await stopReporting(); throw CancellationError() }
        catch {
            await stopReporting()
            throw HostOperationFailure(code: "internal", message: "downloading the macOS \(release.version) IPSW stopped: \(explain(error))", nextStep: "check this Mac's internet connection, then delete the failed image and build again; the download resumes where it stopped")
        }
    }

    private func stagePayload(into build: MacBuildDirectory) async throws {
        guard let guestAgent else { throw HostOperationFailure(code: "unsupported", message: "this Mac's Localbox has no guest agent build") }
        try await Self.packPayload(guestAgent: guestAgent, to: build.payload)
    }

    /// The darwin agent (as `localbox-agent`) with everything in the build's `darwin/` (helper, forwarder, units,
    /// `install.sh`), as one tarball for the guest's `install.sh`. The macOS lab installs it the same way.
    public static func packPayload(guestAgent: URL, to tarball: URL) async throws {
        let stage = tarball.deletingLastPathComponent().appendingPathComponent(".payload-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: stage, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: stage) }
        try FileManager.default.copyItem(at: guestAgent.appendingPathComponent("localbox-agent-darwin-arm64"), to: stage.appendingPathComponent("localbox-agent"))
        let darwin = guestAgent.appendingPathComponent("darwin", isDirectory: true)
        for name in try FileManager.default.contentsOfDirectory(atPath: darwin.path) { try FileManager.default.copyItem(at: darwin.appendingPathComponent(name), to: stage.appendingPathComponent(name)) }
        try? FileManager.default.removeItem(at: tarball)
        let tar = await runProcess(URL(fileURLWithPath: "/usr/bin/tar"), ["-czf", tarball.path, "-C", stage.path, "."], timeout: 120)
        guard tar.status == 0 else { throw HostDaemonError.unsupported("could not pack the guest agent for the macOS guest (tar exited \(tar.status)): \(tar.stderr)") }
    }

    private func agentVersion() -> String {
        guard let guestAgent, let data = try? Data(contentsOf: guestAgent.appendingPathComponent("agent-version.json")),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let version = object["version"] as? String else { return "unknown" }
        return version
    }

    /// What the connector reports to the account (`size_bytes`, `min_macos`, `ipsw_version`) and the relay words from.
    private func result(_ manifest: ImageManifest, _ checkpoint: Checkpoint, chrome: String?) -> JSONValue {
        let release = checkpoint.ipsw
        var result: [String: JSONValue] = ["size_bytes": .number(Double(manifest.sizeBytes)), "os": .string(manifest.os.rawValue), "ipsw_version": .string(release.version), "ipsw_build": .string(release.build), "agent_version": .string(manifest.agentVersion)]
        if let minMacOS = manifest.minMacOS { result["min_macos"] = .string(minMacOS) }
        if let chrome, !chrome.isEmpty { result["chrome_version"] = .string(chrome) }
        if !checkpoint.madeRoom.isEmpty { result["made_room"] = .array(checkpoint.madeRoom.map(JSONValue.string)) }
        return .object(result)
    }

    /// The oldest host the image runs on: the IPSW's major release. Apple serves a host the newest restore image it
    /// supports, which is often a later minor than the host itself (27.2.1 on a 27.0.1 Mac), so the full version would
    /// keep the image off the Mac that built it.
    static func minMacOS(_ release: IPSWRelease) -> String { "\(release.version.split(separator: ".").first ?? "27").0" }

    // MARK: - Guest scripts

    public static let remotePayload = "/tmp/localbox-payload.tgz"
    /// Google's own signed installer package for Chrome (P12); Localbox redistributes nothing macOS-side.
    static let chromeInstaller = "https://dl.google.com/chrome/mac/universal/stable/gcem/GoogleChrome.pkg"

    /// Waits up to `seconds` for `user`'s auto-login session (its launchd domain and Finder): SSH and the agent answer
    /// before it exists, and the desktop role and its TCC database live in it.
    static func waitForSession(user: String, seconds: Int) -> String {
        "n=0; until launchctl print gui/$(id -u \(user)) >/dev/null 2>&1 && pgrep -x -u \(user) Finder >/dev/null; do n=$((n+2)); [ $n -lt \(seconds) ] || { echo \"the desktop session of \(user) never came up\" >&2; exit 1; }; sleep 2; done"
    }

    /// Over SSH as root, on the first boot: wait for the auto-login session the agent's desktop role runs in, install
    /// the agent (`install.sh`), then Chrome from Google's package, checked to be signed by Google.
    public static func bootstrapScript(user: String) -> String {
        """
        set -eu
        \(waitForSession(user: user, seconds: 300))
        rm -rf /tmp/localbox-stage && mkdir /tmp/localbox-stage && tar -xzf \(remotePayload) -C /tmp/localbox-stage
        sh /tmp/localbox-stage/install.sh /tmp/localbox-stage
        rm -f /tmp/GoogleChrome.pkg
        curl -fsSL --retry 8 --retry-all-errors --retry-delay 3 -C - -o /tmp/GoogleChrome.pkg \(chromeInstaller)
        pkgutil --check-signature /tmp/GoogleChrome.pkg | grep -q 'Developer ID Installer: Google LLC' || { echo "the Chrome installer is not signed by Google" >&2; exit 1; }
        installer -pkg /tmp/GoogleChrome.pkg -target / >/dev/null
        test -d '/Applications/Google Chrome.app'
        rm -rf /tmp/GoogleChrome.pkg /tmp/localbox-stage \(remotePayload)
        """
    }

    /// Through the agent's root shell: no notification banners in the session, the desktop role's TCC rows
    /// (`--grant-tcc`), then the desktop role restarts so it holds them (it answers macOS's window-picker bypass prompt
    /// itself, through Accessibility).
    public static func tccScript(user: String) -> String {
        """
        set -eu
        \(waitForSession(user: user, seconds: 90))
        \(quietNotifications(user: user))
        /usr/local/localbox/localbox-agent --grant-tcc
        launchctl kickstart -k gui/$(id -u \(user))/sh.localbox.desktop
        \(waitForCaptureApproval(user: user, seconds: 25))
        """
    }

    /// Notification Center's banner agent off for good in `user`'s session: macOS's "App Background Activity" banners
    /// (for the agent's and Google's updater's launch items) and Chrome's notification-permission banners would cover
    /// the top right of every screenshot. Turning off a system agent needs SIP off, so it runs here, after `sip`.
    static func quietNotifications(user: String) -> String {
        "launchctl disable gui/$(id -u \(user))/com.apple.notificationcenterui.agent; launchctl bootout gui/$(id -u \(user))/com.apple.notificationcenterui.agent 2>/dev/null || true"
    }

    /// The restarted desktop role's first capture brings up macOS's window-picker prompt and presses Allow
    /// (`settle-capture-prompt`); macOS records that approval for 30 days (`kScreenCapturePrivacyHintPolicy`). Waiting for
    /// the record before `finish` shuts the guest down puts it in the image, so a sandbox's first capture isn't asked
    /// again. Not fatal: without it each sandbox's desktop role answers the prompt itself at start.
    static func waitForCaptureApproval(user: String, seconds: Int) -> String {
        "approvals='/Users/\(user)/Library/Group Containers/group.com.apple.replayd/ScreenCaptureApprovals.plist'; n=0; until plutil -p \"$approvals\" 2>/dev/null | grep -q localbox-agent; do n=$((n+1)); [ $n -lt \(seconds) ] || { echo 'no screen capture approval recorded; each sandbox answers the prompt at start' >&2; break; }; sleep 1; done"
    }

    /// Through the agent's root shell, last: Remote Login off for good, no sandbox identity left behind, and the Chrome
    /// version printed for the result.
    static let finishScript = """
        set -eu
        launchctl disable system/com.openssh.sshd
        launchctl bootout system/com.openssh.sshd 2>/dev/null || true
        rm -f /var/db/localbox/sandbox-id
        /usr/bin/defaults read '/Applications/Google Chrome.app/Contents/Info' CFBundleShortVersionString
        """
}
