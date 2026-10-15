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
        do {
            let vmID = required("LOCALBOX_VM_ID", defaultValue: "vm_01")
            let token = try loadToken()
            let image = AppleVMConfiguration(
                kernelURL: pathURL("LOCALBOX_KERNEL"),
                initialRamdiskURL: pathURL("LOCALBOX_INITRD"),
                diskURL: pathURL("LOCALBOX_DISK"),
                templateDiskURL: optionalURL("LOCALBOX_TEMPLATE_DISK"),
                cpuCount: integer("LOCALBOX_CPU_COUNT", defaultValue: 4),
                memorySize: UInt64(integer("LOCALBOX_MEMORY_BYTES", defaultValue: 4 * 1024 * 1024 * 1024))
            )
            let daemon = HostDaemon(vmID: vmID, backend: AppleVirtualizationBackend(image: image))
            let endpoint = LocalIPCEndpoint(socketPath: required("LOCALBOX_SOCKET"))
            let server = UnixDomainSocketServer(ipc: AuthenticatedLocalIPC(daemon: daemon, token: token, endpoint: endpoint), endpoint: endpoint)
            try await server.start()
            try await daemon.start()
            installSignalHandlers(server: server, daemon: daemon)
            dispatchMain()
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
    private static func installSignalHandlers(server: UnixDomainSocketServer, daemon: HostDaemon) {
        for signal in [SIGTERM, SIGINT] {
            Darwin.signal(signal, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: signal, queue: .main)
            source.setEventHandler {
                Task {
                    await server.stop()
                    try? await daemon.stop()
                    exit(0)
                }
            }
            source.resume()
        }
    }

    private static func required(_ name: String, defaultValue: String? = nil) -> String {
        if let value = ProcessInfo.processInfo.environment[name], !value.isEmpty { return value }
        if let defaultValue { return defaultValue }
        FileHandle.standardError.write(Data("missing \(name)\n".utf8)); exit(78)
    }

    private static func optionalURL(_ name: String) -> URL? {
        guard let value = ProcessInfo.processInfo.environment[name], !value.isEmpty else { return nil }
        return URL(fileURLWithPath: expanded(value))
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

    private static func integer(_ name: String, defaultValue: Int) -> Int {
        guard let value = ProcessInfo.processInfo.environment[name], !value.isEmpty else { return defaultValue }
        guard let parsed = Int(value), parsed > 0 else { FileHandle.standardError.write(Data("invalid positive integer \(name)\n".utf8)); Darwin.exit(78) }
        return parsed
    }
    #endif
}
