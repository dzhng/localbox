#if os(macOS)
import Foundation

/// SSH into a macOS guest with the password its provisioning set, for the one window in a macOS image build when Remote
/// Login is on and no Localbox agent exists yet. Password auth goes through `SSH_ASKPASS`, so nothing waits on a TTY.
public struct GuestSSH: Sendable {
    public let address: String
    public let user: String
    public let password: String
    public init(address: String, user: String, password: String) { self.address = address; self.user = user; self.password = password }

    public struct Result: Sendable { public let status: Int32; public let stdout: String; public let stderr: String }

    /// Runs `command` in the guest's login shell. `sudo` reads the same password from stdin when `elevated`.
    @discardableResult
    public func run(_ command: String, elevated: Bool = false, timeout: TimeInterval = 120) throws -> Result {
        let remote = elevated ? "sudo -S -p '' sh -c \(shellQuoted(command))" : command
        return try invoke("/usr/bin/ssh", Self.options + ["\(user)@\(address)", remote], stdin: elevated ? "\(password)\n" : nil, timeout: timeout)
    }

    public func copy(_ local: URL, to remote: String, timeout: TimeInterval = 600) throws {
        let result = try invoke("/usr/bin/scp", Self.options + ["-q", local.path, "\(user)@\(address):\(remote)"], stdin: nil, timeout: timeout)
        guard result.status == 0 else { throw HostDaemonError.unsupported("scp \(local.lastPathComponent) failed: \(result.stderr)") }
    }

    /// Waits until SSH accepts the password and runs a command.
    public func waitUntilReachable(timeout: TimeInterval) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        var last = ""
        while Date() < deadline {
            if let result = try? run("true", timeout: 15), result.status == 0 { return }
            last = (try? run("true", timeout: 15))?.stderr ?? last
            try await Task.sleep(nanoseconds: 3_000_000_000)
        }
        throw HostDaemonError.unsupported("SSH to \(address) never answered within \(Int(timeout)) s: \(last)")
    }

    private static let options = ["-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "-o", "LogLevel=ERROR", "-o", "PubkeyAuthentication=no", "-o", "PreferredAuthentications=password,keyboard-interactive", "-o", "ConnectTimeout=5", "-o", "NumberOfPasswordPrompts=1"]

    private func invoke(_ tool: String, _ arguments: [String], stdin: String?, timeout: TimeInterval) throws -> Result {
        let askpass = FileManager.default.temporaryDirectory.appendingPathComponent("localbox-askpass-\(UUID().uuidString)")
        try "#!/bin/sh\nprintf '%s\\n' \"$LOCALBOX_SSH_PASSWORD\"\n".write(to: askpass, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: askpass.path)
        defer { try? FileManager.default.removeItem(at: askpass) }
        let process = Process(); process.executableURL = URL(fileURLWithPath: tool); process.arguments = arguments
        var environment = ProcessInfo.processInfo.environment
        environment["SSH_ASKPASS"] = askpass.path; environment["SSH_ASKPASS_REQUIRE"] = "force"; environment["DISPLAY"] = ":0"; environment["LOCALBOX_SSH_PASSWORD"] = password
        process.environment = environment
        let input = Pipe(), output = Pipe(), errors = Pipe()
        process.standardInput = input; process.standardOutput = output; process.standardError = errors
        try process.run()
        if let stdin { input.fileHandleForWriting.write(Data(stdin.utf8)) }
        try? input.fileHandleForWriting.close()
        let collected = Collected(), failures = Collected()
        let group = DispatchGroup()
        group.enter(); DispatchQueue.global().async { collected.data = output.fileHandleForReading.readDataToEndOfFile(); group.leave() }
        group.enter(); DispatchQueue.global().async { failures.data = errors.fileHandleForReading.readDataToEndOfFile(); group.leave() }
        if group.wait(timeout: .now() + timeout) == .timedOut { process.terminate(); throw HostDaemonError.unsupported("\(tool) \(arguments.last ?? "") timed out after \(Int(timeout)) s") }
        process.waitUntilExit()
        return Result(status: process.terminationStatus, stdout: String(decoding: collected.data, as: UTF8.self), stderr: String(decoding: failures.data, as: UTF8.self))
    }

    private func shellQuoted(_ text: String) -> String { "'" + text.replacingOccurrences(of: "'", with: "'\\''") + "'" }
    private final class Collected: @unchecked Sendable { var data = Data() }
}

/// The address the Mac's NAT DHCP server leased to `mac` (from `/var/db/dhcpd_leases`), if any.
public func dhcpLeaseAddress(for mac: String) -> String? {
    let wanted = mac.split(separator: ":").map { String(Int($0, radix: 16) ?? -1, radix: 16) }.joined(separator: ":")
    guard let leases = try? String(contentsOfFile: "/var/db/dhcpd_leases", encoding: .utf8) else { return nil }
    for block in leases.components(separatedBy: "}") where block.contains("hw_address=1,\(wanted)\n") {
        for line in block.split(separator: "\n") where line.trimmingCharacters(in: .whitespaces).hasPrefix("ip_address=") {
            return String(line.trimmingCharacters(in: .whitespaces).dropFirst("ip_address=".count))
        }
    }
    return nil
}
#endif
