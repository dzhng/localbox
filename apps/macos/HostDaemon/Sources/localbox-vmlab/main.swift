import Foundation
import HostDaemonCore

@main
struct VMLabMain {
    static func main() async {
        #if os(macOS)
        var consoleLog: URL?
        var lab: AppleVirtualizationBackend?
        do {
            let arguments = Array(CommandLine.arguments.dropFirst())
            guard arguments.first == "boot", let artifacts = option("--artifacts", in: arguments), arguments.contains("--json") else {
                throw UsageError.message("usage: localbox-vmlab vmlab boot --artifacts <dir> --json")
            }
            let directory = URL(fileURLWithPath: expanded(artifacts), isDirectory: true)
            // Boot a scratch clone (APFS copy-on-write) so a lab run never writes the template.
            let scratch = FileManager.default.temporaryDirectory.appendingPathComponent("localbox-vmlab-\(UUID().uuidString)", isDirectory: true)
            try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)
            consoleLog = scratch.appendingPathComponent("console.log")
            defer { if ProcessInfo.processInfo.environment["LOCALBOX_VMLAB_KEEP"] == nil { try? FileManager.default.removeItem(at: scratch) } }
            let disk = scratch.appendingPathComponent("disk.img")
            try FileManager.default.copyItem(at: directory.appendingPathComponent("template.img"), to: disk)
            let image = AppleVMConfiguration(
                kernelURL: directory.appendingPathComponent("kernel"),
                initialRamdiskURL: directory.appendingPathComponent("initrd"),
                diskURL: disk,
                templateDiskURL: directory.appendingPathComponent("template.img"),
                cpuCount: 4,
                memorySize: 4 * 1024 * 1024 * 1024,
                consoleLogURL: scratch.appendingPathComponent("console.log"),
                extraKernelArguments: option("--kernel-args", in: arguments) ?? ""
            )
            let backend = AppleVirtualizationBackend(image: image); lab = backend
            let daemon = HostDaemon(backend: backend)
            try await daemon.start()
            _ = try await daemon.request(Data(#"{"protocol_version":"v1","request_id":"vmlab-create","operation":"sandbox.create","sandbox_id":"sandbox_vmlab","deadline_ms":30000,"mutation_id":"vmlab-create","input":{"name":"vmlab"}}"#.utf8))
            let request = Data(#"{"protocol_version":"v1","request_id":"vmlab-uname","operation":"shell.exec","sandbox_id":"sandbox_vmlab","deadline_ms":30000,"mutation_id":"vmlab-uname","input":{"command":"uname -m"}}"#.utf8)
            let response = try await daemon.request(request)
            let object = try JSONSerialization.jsonObject(with: response) as? [String: Any]
            guard let result = object?["result"] as? [String: Any], object?["ok"] as? Bool == true else {
                throw UsageError.message("guest uname request failed: \(String(data: response, encoding: .utf8) ?? "invalid response")")
            }
            let uname = (result["stdout"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let output: [String: Any] = ["ready": true, "uname": uname, "response": result]
            let encoded = try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys])
            FileHandle.standardOutput.write(encoded); FileHandle.standardOutput.write(Data("\n".utf8))
            try await daemon.stop()
        } catch {
            let reason = await lab?.stopReason()
            let output: [String: Any] = ["ready": false, "error": String(describing: error), "stop_reason": reason ?? "running"]
            if let log = consoleLog, let text = try? String(contentsOf: log, encoding: .utf8) { FileHandle.standardError.write(Data(String(text.suffix(6000)).utf8)) }
            if let encoded = try? JSONSerialization.data(withJSONObject: output, options: [.sortedKeys]) { FileHandle.standardOutput.write(encoded); FileHandle.standardOutput.write(Data("\n".utf8)) }
            exit(1)
        }
        #else
        FileHandle.standardError.write(Data("localbox-vmlab requires macOS Virtualization\n".utf8))
        exit(1)
        #endif
    }

    #if os(macOS)
    private static func option(_ name: String, in arguments: [String]) -> String? {
        guard let index = arguments.firstIndex(of: name), arguments.indices.contains(arguments.index(after: index)) else { return nil }
        return arguments[arguments.index(after: index)]
    }
    private static func expanded(_ value: String) -> String {
        if value == "~" { return FileManager.default.homeDirectoryForCurrentUser.path }
        if value.hasPrefix("~/") { return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(String(value.dropFirst(2))).path }
        return value
    }
    #endif
}

private enum UsageError: Error, CustomStringConvertible {
    case message(String)
    var description: String { if case let .message(value) = self { return value }; return "invalid vmlab arguments" }
}
