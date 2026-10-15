import Foundation
import HostDaemonCore
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
        do {
            let token = try loadToken()
            let sandboxes = pathURL("LOCALBOX_SANDBOXES")
            try FileManager.default.createDirectory(at: sandboxes, withIntermediateDirectories: true)
            let agentSetup = ProcessInfo.processInfo.environment["LOCALBOX_CLI"].flatMap { $0.isEmpty ? nil : AgentSetupCLI(executable: URL(fileURLWithPath: expanded($0))) }
            let host = SandboxHost(sandboxesDirectory: sandboxes, factory: try factory(),
                                   hostCPUs: optionalInteger("LOCALBOX_DEV_HOST_CPUS"), hostMemoryBytes: optionalInteger("LOCALBOX_DEV_HOST_MEMORY_BYTES").map(UInt64.init),
                                   admissionBytes: devAdmissionBytes(), allowsSimulatedPower: ProcessInfo.processInfo.environment["LOCALBOX_DEV"] == "1", agentSetup: agentSetup)
            let endpoint = LocalIPCEndpoint(socketPath: required("LOCALBOX_SOCKET"))
            let server = UnixDomainSocketServer(ipc: AuthenticatedLocalIPC(host: host, token: token, endpoint: endpoint), endpoint: endpoint)
            installSignalHandlers(server: server, host: host)
            try await server.start()
            // Every start (including the relaunch after an update) matches the skill and CLI link to the installed
            // release (D16), in the background so it never holds up sandbox restore.
            if let agentSetup { Task.detached { log("agent setup (daemon_start): \(await agentSetup.reconcile())") } } else { log("agent setup: no LOCALBOX_CLI, so the skill and CLI link are not reconciled") }
            // Bring back what the last run hibernated or left running; each sandbox reports woke or cold_booted.
            for (id, action) in await host.recover().sorted(by: { $0.key < $1.key }) { log("\(id) \(action["kind"] ?? ""): \(action["detail"] ?? "")") }
            // The Mac's sleep and power-off notices hibernate the sandboxes first (L6).
            do { try power(host).start() } catch { log("no power notices: \(error)") }
            // An async main already services the main queue; dispatchMain() here traps. The main task runs the idle
            // policy (Q5) every second instead.
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
    private static func factory() throws -> any SandboxBackendFactory {
        switch ProcessInfo.processInfo.environment["LOCALBOX_VM_BACKEND"] ?? "apple" {
        case "apple":
            return AppleSandboxFactory(artifacts: SandboxArtifacts(kernelURL: pathURL("LOCALBOX_KERNEL"), initialRamdiskURL: pathURL("LOCALBOX_INITRD"), templateDiskURL: pathURL("LOCALBOX_TEMPLATE_DISK")))
        case "process-fixture":
            let repo = pathURL("LOCALBOX_REPO_ROOT")
            return try ProcessFixtureFactory(configuration: ProcessFixtureConfiguration(
                guestCommand: ["/usr/bin/env", "node", "--import", "tsx", repo.appendingPathComponent("apps/guest-agent/src/index.ts").path],
                workingDirectory: repo
            ))
        case let other:
            throw HostDaemonError.unsupported("unknown LOCALBOX_VM_BACKEND \(other); expected apple or process-fixture")
        }
    }

    /// SIGTERM (launchd stop, update, `kickstart -k`) hibernates every running sandbox before exiting (D11);
    /// launchd's `ExitTimeOut` must cover the saves.
    private static func installSignalHandlers(server: UnixDomainSocketServer, host: SandboxHost) {
        for signal in [SIGTERM, SIGINT] {
            Darwin.signal(signal, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: signal, queue: .main)
            source.setEventHandler {
                Task {
                    await server.stop()
                    await host.shutdown()
                    exit(0)
                }
            }
            source.resume()
            signalSources.append(source)
        }
    }
    nonisolated(unsafe) private static var signalSources: [DispatchSourceSignal] = []

    /// Kept for the daemon's life: IOKit calls back into it.
    nonisolated(unsafe) private static var powerMonitor: SystemPowerMonitor?
    private static func power(_ host: SandboxHost) -> SystemPowerMonitor {
        let monitor = SystemPowerMonitor(host: host, log: { log($0) }); powerMonitor = monitor; return monitor
    }

    private static func log(_ line: String) { FileHandle.standardError.write(Data("localbox-hostd: \(line)\n".utf8)) }

    private static func required(_ name: String, defaultValue: String? = nil) -> String {
        if let value = ProcessInfo.processInfo.environment[name], !value.isEmpty { return value }
        if let defaultValue { return defaultValue }
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

    /// Proof runs cap the admission budget on real VMs (the RAM override is for fixtures); release builds ignore it.
    private static func devAdmissionBytes() -> UInt64? {
        #if DEBUG
        return optionalInteger("LOCALBOX_DEV_ADMISSION_BYTES").map(UInt64.init)
        #else
        return nil
        #endif
    }

    private static func optionalInteger(_ name: String) -> Int? {
        guard let value = ProcessInfo.processInfo.environment[name], !value.isEmpty else { return nil }
        return integer(name, defaultValue: 1)
    }

    private static func integer(_ name: String, defaultValue: Int) -> Int {
        guard let value = ProcessInfo.processInfo.environment[name], !value.isEmpty else { return defaultValue }
        guard let parsed = Int(value), parsed > 0 else { FileHandle.standardError.write(Data("invalid positive integer \(name)\n".utf8)); Darwin.exit(78) }
        return parsed
    }
    #endif
}
