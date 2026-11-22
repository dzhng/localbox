import Foundation
import HostDaemonCore
import ImageCopyTransfer
#if os(macOS)
import Darwin
#else
import Glibc
#endif

@main
struct HostDaemonMain {
    static func main() async {
        #if os(macOS)
        // A client that dies mid-reply (a killed connector) must cost one failed write, not the daemon: SIGPIPE's
        // default action kills the process silently.
        Darwin.signal(SIGPIPE, SIG_IGN)
        let supervised = supervisedArgument()
        // Before anything touches the root (the image sweep, the socket's unlink): a twin must leave it as it found it.
        takeMachineLock()
        do {
            let token = try loadToken()
            let sandboxes = pathURL("LOCALBOX_SANDBOXES")
            try FileManager.default.createDirectory(at: sandboxes, withIntermediateDirectories: true)
            let isDev = ProcessInfo.processInfo.environment["LOCALBOX_DEV"] == "1"
            let dev = devHost()
            let operations = try HostOperationStore(operationsDirectory: pathURL("LOCALBOX_OPERATIONS"))
            let images = try ImageStore(imagesDirectory: pathURL("LOCALBOX_IMAGES"), freeBytesOverride: dev.freeDiskBytes.map { bytes in { @Sendable in bytes } })
            // A running operation's temporaries (a macOS build directory, a copy's partial files and resume bitmap) stay for its resume.
            for name in images.sweepTemps(keeping: await operations.runningSubjects()) { log("removed \(name), an image write or delete the last run left unfinished") }
            let agentSetup = ProcessInfo.processInfo.environment["LOCALBOX_CLI"].flatMap { $0.isEmpty ? nil : AgentSetupCLI(executable: URL(fileURLWithPath: expanded($0))) }
            // The guest agent build this Mac ships; without it sandboxes keep the agent their image carries.
            let guestAgent = ProcessInfo.processInfo.environment["LOCALBOX_GUEST_AGENT"].flatMap { $0.isEmpty ? nil : URL(fileURLWithPath: expanded($0), isDirectory: true) }
            let agentUpdater = guestAgent.map { GuestAgentUpdater(directory: $0) }
            if agentUpdater == nil { log("guest agent updates: no LOCALBOX_GUEST_AGENT, so sandboxes keep the agent their image carries") }
            // Only Localbox.app fetches the built-in image, so only under it does a create wait for one.
            let builtinImage = ProcessInfo.processInfo.environment["LOCALBOX_BUILTIN_IMAGE_PROGRESS"].flatMap { $0.isEmpty ? nil : BuiltinImageWait(progressFile: URL(fileURLWithPath: expanded($0))) }
            let host = SandboxHost(sandboxesDirectory: sandboxes, factory: try factory(images), operations: operations, store: images, hostCPUs: dev.cpus, hostMemoryBytes: dev.memoryBytes,
                                   admissionBytes: dev.admissionBytes, allowsSimulatedPower: isDev, agentSetup: agentSetup, agentUpdater: agentUpdater, builtinImage: builtinImage)
            let macBuilder = MacBaseBuilder(store: images, operations: operations, sandboxes: host, driver: AppleMacBuildDriver(), catalog: AppleIPSWCatalog(), guestAgent: guestAgent)
            // Copies go straight to the other Mac through ImageTransfer: the local network first, then a punched connection.
            let daemon = await HostDaemon(sandboxes: host, macBuilder: macBuilder, transport: ImageTransferCopyTransport(), dev: isDev)
            let endpoint = LocalIPCEndpoint(socketPath: required("LOCALBOX_SOCKET"))
            let server = UnixDomainSocketServer(ipc: AuthenticatedLocalIPC(daemon: daemon, token: token, endpoint: endpoint), endpoint: endpoint)
            let shutdown = DaemonShutdown(server: server, host: host, log: { log($0) })
            shutdown.onSignals([SIGTERM, SIGINT])
            // Probes and launchd start the daemon with stdin on /dev/null, which reads as an immediate end; only a
            // supervisor's pipe means "stop when I go away".
            if supervised { shutdown.onEndOfInput(STDIN_FILENO) }
            daemonShutdown = shutdown
            try await server.start()
            // Every start (including the relaunch after an update) matches the skill and CLI link to the installed
            // release, in the background so it never holds up sandbox restore.
            if let agentSetup { Task.detached { log("agent setup (daemon_start): \(await agentSetup.reconcile())") } } else { log("agent setup: no LOCALBOX_CLI, so the skill and CLI link are not reconciled") }
            // Bring back what the last run hibernated or left running; each sandbox reports woke or cold_booted.
            for (id, action) in await host.recover().sorted(by: { $0.key < $1.key }) { log("\(id) \(action["kind"] ?? ""): \(action["detail"] ?? "")") }
            // Long host work the last run left unfinished continues from its checkpoint, after the sandboxes it may
            // act on are back.
            for key in await operations.start() { log("operation \(key) resumed") }
            // The Mac's sleep and power-off notices hibernate the sandboxes first.
            do { try power(host).start() } catch { log("no power notices: \(error)") }
            // An async main already services the main queue; dispatchMain() here traps. The main task runs the idle
            // policy every second instead.
            while true {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                for (id, action) in await host.idleTick().sorted(by: { $0.key < $1.key }) { log("\(id) \(action["kind"] ?? ""): \(action["detail"] ?? "")") }
            }
        } catch {
            FileHandle.standardError.write(Data("localbox-hostd: \(error)\n".utf8))
            exit(1)
        }
        #else
        FileHandle.standardError.write(Data("localbox-hostd requires macOS Virtualization\n".utf8))
        exit(1)
        #endif
    }

    #if os(macOS)
    /// Real VMs unless the fixture is explicitly selected; an unknown value is an error, never a fallback.
    private static func factory(_ images: ImageStore) throws -> any SandboxBackendFactory {
        switch ProcessInfo.processInfo.environment["LOCALBOX_SANDBOX_BACKEND"] ?? "apple" {
        case "apple":
            return AppleSandboxFactory(images: images)
        case "process-fixture":
            let repo = pathURL("LOCALBOX_REPO_ROOT")
            return try ProcessFixtureFactory(configuration: ProcessFixtureConfiguration(
                guestCommand: ["/usr/bin/env", "node", "--import", "tsx", repo.appendingPathComponent("apps/guest-agent/src/index.ts").path],
                workingDirectory: repo
            ))
        case let other:
            throw HostDaemonError.unsupported("unknown LOCALBOX_SANDBOX_BACKEND \(other); expected apple or process-fixture")
        }
    }

    /// `--supervised` is the only argument: a mistyped one must not quietly start a daemon that outlives its parent.
    private static func supervisedArgument() -> Bool {
        let arguments = CommandLine.arguments.dropFirst()
        guard arguments.allSatisfy({ $0 == "--supervised" }) else {
            FileHandle.standardError.write(Data("usage: localbox-hostd [--supervised]\n".utf8)); exit(64)
        }
        return !arguments.isEmpty
    }

    /// Held for the process's life; the kernel releases it at exit. A daemon that cannot take it exits 75
    /// (EX_TEMPFAIL): another one serves this root, and a supervisor may retry once that one is gone.
    nonisolated(unsafe) private static var machineLock: MachineLock?
    private static func takeMachineLock() {
        let path = ProcessInfo.processInfo.environment["LOCALBOX_HOSTD_LOCK"].flatMap { $0.isEmpty ? nil : expanded($0) }
            ?? URL(fileURLWithPath: expanded(required("LOCALBOX_SOCKET"))).deletingLastPathComponent().appendingPathComponent("hostd.lock").path
        do {
            try FileManager.default.createDirectory(atPath: URL(fileURLWithPath: path).deletingLastPathComponent().path, withIntermediateDirectories: true)
            machineLock = try MachineLock(path: path)
        } catch {
            log("\(error)")
            if case MachineLockError.held = error { exit(75) }
            exit(1)
        }
    }

    /// Kept for the daemon's life: its signal sources and stdin watch call back into it.
    nonisolated(unsafe) private static var daemonShutdown: DaemonShutdown?

    /// Kept for the daemon's life: IOKit calls back into it.
    nonisolated(unsafe) private static var powerMonitor: SystemPowerMonitor?
    private static func power(_ host: SandboxHost) -> SystemPowerMonitor {
        let monitor = SystemPowerMonitor(host: host, log: { log($0) }); powerMonitor = monitor; return monitor
    }

    private static func log(_ line: String) { FileHandle.standardError.write(Data("localbox-hostd: \(line)\n".utf8)) }

    private static func required(_ name: String) -> String {
        if let value = ProcessInfo.processInfo.environment[name], !value.isEmpty { return value }
        FileHandle.standardError.write(Data("missing \(name)\n".utf8)); exit(78)
    }

    private static func pathURL(_ name: String) -> URL { URL(fileURLWithPath: expanded(required(name))) }

    private static func expanded(_ value: String) -> String {
        if value == "~" { return FileManager.default.homeDirectoryForCurrentUser.path }
        if value.hasPrefix("~/") { return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(String(value.dropFirst(2))).path }
        return value
    }

    private static func loadToken() throws -> String {
        if let value = ProcessInfo.processInfo.environment["LOCALBOX_IPC_TOKEN"], !value.isEmpty { return value }
        let path = expanded(required("LOCALBOX_IPC_TOKEN_PATH"))
        let value = try String(contentsOfFile: path, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { throw NSError(domain: "LocalboxHostDaemon", code: 78, userInfo: [NSLocalizedDescriptionKey: "IPC token file is empty"]) }
        return value
    }

    /// Proof runs give fixture machines their own CPU, RAM and free-disk sizes and cap the admission budget on real VMs
    /// (a fixed free disk keeps capacity and every image write's disk check independent of whatever else is writing to
    /// this Mac's disk); release builds ignore all four and use this Mac's.
    private static func devHost() -> (cpus: Int?, memoryBytes: UInt64?, admissionBytes: UInt64?, freeDiskBytes: UInt64?) {
        #if DEBUG
        return (optionalInteger("LOCALBOX_DEV_HOST_CPUS"), optionalInteger("LOCALBOX_DEV_HOST_MEMORY_BYTES").map(UInt64.init), optionalInteger("LOCALBOX_DEV_ADMISSION_BYTES").map(UInt64.init), optionalInteger("LOCALBOX_DEV_FREE_DISK_BYTES").map(UInt64.init))
        #else
        return (nil, nil, nil, nil)
        #endif
    }

    private static func optionalInteger(_ name: String) -> Int? {
        guard let value = ProcessInfo.processInfo.environment[name], !value.isEmpty else { return nil }
        guard let parsed = Int(value), parsed > 0 else { FileHandle.standardError.write(Data("invalid positive integer \(name)\n".utf8)); Darwin.exit(78) }
        return parsed
    }
    #endif
}
