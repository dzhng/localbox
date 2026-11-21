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

/// A macOS base build's working files, in its `ImageStore` build directory (`images/.<id>.build/`): the installed
/// disk and auxiliary storage kept pristine, the hardware model and identity they were installed with, and the work
/// copies (`disk.img`, `boot/aux.img`) laid out as an image's, so committing is one rename once the private files go.
public struct MacBuildDirectory: Sendable {
    public let root: URL
    public init(root: URL) { self.root = root }
    public var installedDisk: URL { root.appendingPathComponent("installed.img") }
    public var installedAux: URL { root.appendingPathComponent("installed-aux.img") }
    public var hardwareModel: URL { root.appendingPathComponent("hardware-model") }
    public var machineIdentifier: URL { root.appendingPathComponent("machine-identifier") }
    public var mac: URL { root.appendingPathComponent("mac") }
    public var payload: URL { root.appendingPathComponent("payload.tgz") }
    public var disk: URL { root.appendingPathComponent(ImageStore.diskName) }
    public var aux: URL { root.appendingPathComponent("boot", isDirectory: true).appendingPathComponent("aux.img") }

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

/// The VM side of a macOS base build. `AppleMacBuildDriver` boots real guests; tests pass a fake.
public protocol MacBuildDriver: Sendable {
    /// Installs `ipsw` as the build's pristine guest: its installed disk of `diskBytes`, auxiliary storage, hardware
    /// model and identity.
    func install(ipsw: URL, into build: MacBuildDirectory, diskBytes: UInt64, progress: @escaping @Sendable (Double) -> Void) async throws
    /// Boots the work copy for the first time with `user` provisioned (auto-login, Remote Login on); the guest answers
    /// over SSH as that user.
    func provision(_ build: MacBuildDirectory, user: MacProvisioningUser) async throws -> any MacBuildGuest
    /// Boots the work copy normally; the guest answers through the Localbox agent's root shell over vsock.
    func boot(_ build: MacBuildDirectory) async throws -> any MacBuildGuest
}

/// A booted build guest.
public protocol MacBuildGuest: Sendable {
    /// Runs `script` with `/bin/sh` as root; throws with its output unless it exits 0, else returns its stdout.
    func root(_ script: String, timeout: TimeInterval) async throws -> String
    /// Copies a host file into the guest (SSH only).
    func upload(_ local: URL, to remote: String) async throws
    /// Shuts the guest down from inside and waits for it to power off.
    func shutDown() async throws
    /// Shuts down, boots Recovery and runs `csrutil disable` as `user` on its Terminal; ends powered off.
    func disableSIP(as user: MacProvisioningUser) async throws
    /// Stops the VM at once (a failed phase leaves nothing running).
    func abandon() async
}

/// Host operation kind `macos.build` (`image create --macos`): builds the account's macOS base on this Mac from
/// Apple's latest IPSW with no human step, and commits it through `ImageStore` as an `os: macos` image.
///
/// Phases, each journaled as the checkpoint's next phase before it runs: `download` (resumable, into the IPSW cache),
/// `install`, `provision` (a fresh clone of the installed disk, first boot with a random password and Remote Login),
/// `bootstrap` (over SSH: the darwin agent, its forwarder, helper and units, and Chrome from Google's installer, P12),
/// `sip` (Recovery's Terminal, slice 17), `tcc` and `finish` (through the agent's root shell: grants, then Remote
/// Login off, shut down, commit). The password lives only in this process's memory: a restart during `bootstrap` or
/// `sip` resumes from `provision` on a fresh clone; `tcc` and `finish` need no password and resume where they were.
/// The IPSW (URL, version, size) is chosen once at `begin` and kept in the checkpoint.
public actor MacBaseBuilder {
    public static let kind = "macos.build"
    /// The guest's disk: inside the 50–80 GB the spec delegates; a fresh install allocates about 27 GB of it.
    public static let diskBytes: UInt64 = 60 << 30
    /// How a building guest is named in the agent's hello (its host name until a sandbox renames it).
    static let guestName = "localbox-macos-base"

    public enum Phase: String, Codable, Sendable, CaseIterable {
        case download, install, provision, bootstrap, sip, tcc, finish
    }

    /// The checkpoint: the phase to run next and the release chosen at `begin`.
    struct Checkpoint: Codable, Equatable {
        var phase: Phase
        let ipsw: IPSWRelease
    }

    private let store: ImageStore
    private let operations: HostOperationStore
    private let driver: any MacBuildDriver
    private let catalog: any IPSWCatalog
    private let http: any RangedHTTP
    private let guestAgent: URL?
    private let hostVersion: @Sendable () -> String
    private let freeBytes: @Sendable () throws -> UInt64
    private let cache: IPSWCache

    /// `guestAgent` is the host's guest agent build (`LOCALBOX_GUEST_AGENT`: the darwin binary, `agent-version.json` and
    /// `darwin/`); without it `begin` refuses. The rest default to the real Mac, Apple and the images volume.
    public init(store: ImageStore, operations: HostOperationStore, driver: any MacBuildDriver, catalog: any IPSWCatalog, http: any RangedHTTP = URLSessionRangedHTTP(), guestAgent: URL?,
                hostVersion: (@Sendable () -> String)? = nil, freeBytes: (@Sendable () throws -> UInt64)? = nil) {
        self.store = store; self.operations = operations; self.driver = driver; self.catalog = catalog; self.http = http; self.guestAgent = guestAgent
        self.hostVersion = hostVersion ?? { let v = ProcessInfo.processInfo.operatingSystemVersion; return "\(v.majorVersion).\(v.minorVersion).\(v.patchVersion)" }
        self.freeBytes = freeBytes ?? { [store] in try store.freeBytes() }
        cache = IPSWCache(directory: store.ipswDirectory)
    }

    /// Registers the kind; before the operation store starts.
    public func register() async {
        await operations.register(kind: Self.kind) { [self] context in try await self.run(context) }
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
        let release: IPSWRelease
        do { release = try await catalog.latest() } catch { throw HostOperationFailure(code: "internal", message: "could not ask Apple for the latest macOS restore image: \(explain(error))", nextStep: "check this Mac's internet connection, then build again") }
        let needed = cache.missingBytes(release) + Self.diskBytes
        let free: UInt64
        do { free = try freeBytes() } catch { throw HostOperationFailure(code: "internal", message: "could not read this Mac's free disk: \(explain(error))") }
        guard free >= needed else {
            let ipsw = cache.missingBytes(release) > 0 ? "the macOS \(release.version) IPSW (\(gibibytes(cache.missingBytes(release)))) plus " : ""
            throw HostOperationFailure(code: "disk_full", message: "building a macOS image needs \(ipsw)a \(gibibytes(Self.diskBytes)) disk free on this Mac, \(gibibytes(needed)) in all, and \(gibibytes(free)) is free",
                                       nextStep: "free at least \(gibibytes(needed - free)) on this Mac (delete sandboxes or images it no longer needs), then build again")
        }
        return try await operations.begin(kind: Self.kind, key: key, subject: imageID, checkpoint: try encode(Checkpoint(phase: .download, ipsw: release)))
    }

    private func run(_ context: HostOperationContext) async throws -> JSONValue {
        var checkpoint: Checkpoint
        do { checkpoint = try decode(context.checkpoint) } catch { throw HostOperationFailure(code: "invalid_input", message: "macos.build needs a checkpoint { phase, ipsw }") }
        let imageID = context.subject
        if let manifest = try? store.manifest(imageID) { return result(manifest, checkpoint.ipsw, chrome: nil) }
        let build = MacBuildDirectory(root: try store.buildDirectory(imageID))
        var chrome: String?
        func advance(to phase: Phase) async throws {
            checkpoint.phase = phase
            try await context.report(HostOperationProgress(phase: phase.rawValue), checkpoint: try encode(checkpoint))
        }
        do {
            loop: while true {
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
                        try stagePayload(into: build)
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
                            _ = try await guest.root(Self.tccScript(user: MacProvisioningUser.defaultName), timeout: 300)
                            try await advance(to: .finish)
                        }
                        chrome = try await guest.root(Self.finishScript, timeout: 300).trimmingCharacters(in: .whitespacesAndNewlines)
                        try await guest.shutDown()
                    } catch { await guest.abandon(); throw error }
                    break loop
                }
            }
            let hardwareModel = try Data(contentsOf: build.hardwareModel).base64EncodedString()
            for file in build.privateFiles { try? FileManager.default.removeItem(at: file) }
            let manifest = try store.seal(build.root, imageID: imageID, os: .macos, hardwareModel: hardwareModel, minMacOS: Self.minMacOS(checkpoint.ipsw), agentVersion: agentVersion())
            try store.commit(build.root, as: imageID)
            return result(manifest, checkpoint.ipsw, chrome: chrome)
        } catch let failure as HostOperationFailure { throw failure }
        catch is CancellationError { throw CancellationError() }
        catch {
            throw HostOperationFailure(code: "internal", message: "the macOS build stopped in \(checkpoint.phase.rawValue): \(explain(error))", nextStep: "delete the failed image and build again; the downloaded IPSW is kept")
        }
    }

    /// The IPSW into the cache, journaling bytes held about every 2 s.
    private func download(_ checkpoint: Checkpoint, _ context: HostOperationContext) async throws {
        let release = checkpoint.ipsw, encoded = try encode(checkpoint)
        let held = Held()
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

    private func stagePayload(into build: MacBuildDirectory) throws {
        guard let guestAgent else { throw HostOperationFailure(code: "unsupported", message: "this Mac's Localbox has no guest agent build") }
        try Self.packPayload(guestAgent: guestAgent, to: build.payload)
    }

    /// The darwin agent (as `localbox-agent`) with everything in the build's `darwin/` (helper, forwarder, units,
    /// `install.sh`), as one tarball for the guest's `install.sh`.
    public static func packPayload(guestAgent: URL, to tarball: URL) throws {
        let stage = tarball.deletingLastPathComponent().appendingPathComponent(".payload-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: stage, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: stage) }
        try FileManager.default.copyItem(at: guestAgent.appendingPathComponent("localbox-agent-darwin-arm64"), to: stage.appendingPathComponent("localbox-agent"))
        let darwin = guestAgent.appendingPathComponent("darwin", isDirectory: true)
        for name in try FileManager.default.contentsOfDirectory(atPath: darwin.path) { try FileManager.default.copyItem(at: darwin.appendingPathComponent(name), to: stage.appendingPathComponent(name)) }
        try? FileManager.default.removeItem(at: tarball)
        let tar = Process(); tar.executableURL = URL(fileURLWithPath: "/usr/bin/tar"); tar.arguments = ["-czf", tarball.path, "-C", stage.path, "."]
        try tar.run(); tar.waitUntilExit()
        guard tar.terminationStatus == 0 else { throw HostDaemonError.unsupported("could not pack the guest agent for the macOS guest (tar exited \(tar.terminationStatus))") }
    }

    private func agentVersion() -> String {
        guard let guestAgent, let data = try? Data(contentsOf: guestAgent.appendingPathComponent("agent-version.json")),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let version = object["version"] as? String else { return "unknown" }
        return version
    }

    /// What the connector reports to the account (`size_bytes`, `min_macos`, `ipsw_version`) and the relay words from.
    private func result(_ manifest: ImageManifest, _ release: IPSWRelease, chrome: String?) -> JSONValue {
        var result: [String: JSONValue] = ["size_bytes": .number(Double(manifest.sizeBytes)), "os": .string(manifest.os.rawValue), "ipsw_version": .string(release.version), "ipsw_build": .string(release.build), "agent_version": .string(manifest.agentVersion)]
        if let minMacOS = manifest.minMacOS { result["min_macos"] = .string(minMacOS) }
        if let chrome, !chrome.isEmpty { result["chrome_version"] = .string(chrome) }
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

    /// Over SSH as root, on the first boot: wait for the auto-login session the agent's desktop role runs in, install
    /// the agent (`install.sh`), then Chrome from Google's package, checked to be signed by Google.
    public static func bootstrapScript(user: String) -> String {
        """
        set -eu
        uid=$(id -u \(user))
        n=0; until launchctl print gui/$uid >/dev/null 2>&1 && pgrep -x -u \(user) Finder >/dev/null; do n=$((n+1)); [ $n -lt 150 ] || { echo "the desktop session of \(user) never came up" >&2; exit 1; }; sleep 2; done
        rm -rf /tmp/localbox-stage && mkdir /tmp/localbox-stage && tar -xzf \(remotePayload) -C /tmp/localbox-stage
        sh /tmp/localbox-stage/install.sh /tmp/localbox-stage
        curl -fsSL --retry 5 --retry-delay 3 -o /tmp/GoogleChrome.pkg \(chromeInstaller)
        pkgutil --check-signature /tmp/GoogleChrome.pkg | grep -q 'Developer ID Installer: Google LLC' || { echo "the Chrome installer is not signed by Google" >&2; exit 1; }
        installer -pkg /tmp/GoogleChrome.pkg -target / >/dev/null
        test -d '/Applications/Google Chrome.app'
        rm -rf /tmp/GoogleChrome.pkg /tmp/localbox-stage \(remotePayload)
        """
    }

    /// Through the agent's root shell: the desktop role's TCC rows (`--grant-tcc`), and the managed restriction that
    /// keeps macOS from asking to confirm its screen capture (`forceBypassScreenCaptureAlert` in
    /// `com.apple.applicationaccess`, as a forced preference for the machine and the desktop user), then the desktop role
    /// restarts so it holds both.
    public static func tccScript(user: String) -> String {
        """
        set -eu
        /usr/local/localbox/localbox-agent --grant-tcc
        for dir in '/Library/Managed Preferences' '/Library/Managed Preferences/\(user)'; do
          mkdir -p "$dir"
          printf '%s\\n' '<?xml version="1.0" encoding="UTF-8"?>' '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">' '<plist version="1.0"><dict><key>forceBypassScreenCaptureAlert</key><true/></dict></plist>' > "$dir/com.apple.applicationaccess.plist"
          chown root:wheel "$dir/com.apple.applicationaccess.plist"; chmod 0644 "$dir/com.apple.applicationaccess.plist"
        done
        launchctl kickstart -k gui/$(id -u \(user))/sh.localbox.desktop
        """
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

private final class Held: @unchecked Sendable {
    private let lock = NSLock(); private var bytes: UInt64 = 0
    var value: UInt64 { get { lock.withLock { bytes } } set { lock.withLock { bytes = newValue } } }
}

private func encode<T: Encodable>(_ value: T) throws -> JSONValue {
    try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(value))
}

private func decode<T: Decodable>(_ value: JSONValue) throws -> T {
    try JSONDecoder().decode(T.self, from: JSONEncoder().encode(value))
}
