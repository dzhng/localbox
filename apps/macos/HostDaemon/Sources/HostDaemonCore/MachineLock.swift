import Foundation

#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif

/// One daemon per machine root. An exclusive `flock` on the root's lock file, held for the process's life: the kernel
/// drops it when the process exits however it exits, so a crashed daemon never leaves a stale lock, and no supervisor's
/// bookkeeping is needed to keep a twin from stealing the socket of a daemon that still runs VMs.
public final class MachineLock: Sendable {
    public let path: String
    private let descriptor: Int32

    /// Takes the lock at `path` or throws `MachineLockError.held` at once; never waits. The holder writes its pid into
    /// the file, so a refusal can say who holds it.
    public init(path: String) throws {
        let descriptor = open(path, O_RDWR | O_CREAT | O_CLOEXEC, 0o600)
        guard descriptor >= 0 else { throw MachineLockError.systemCall("open \(path)", errno) }
        guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
            let code = errno
            defer { close(descriptor) }
            guard code == EWOULDBLOCK else { throw MachineLockError.systemCall("flock \(path)", code) }
            throw MachineLockError.held(path: path, pid: Self.recordedPID(descriptor))
        }
        let pid = Data("\(getpid())\n".utf8)
        _ = ftruncate(descriptor, 0)
        _ = pid.withUnsafeBytes { pwrite(descriptor, $0.baseAddress, pid.count, 0) }
        self.path = path; self.descriptor = descriptor
    }

    /// Gives the lock up before the process exits (tests); a daemon holds it until it exits.
    deinit { close(descriptor) }

    private static func recordedPID(_ descriptor: Int32) -> Int32? {
        var buffer = [UInt8](repeating: 0, count: 32)
        let count = pread(descriptor, &buffer, buffer.count, 0)
        guard count > 0 else { return nil }
        return Int32(String(decoding: buffer[..<count], as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines))
    }
}

public enum MachineLockError: Error, CustomStringConvertible, Sendable {
    /// Another process holds the lock: a daemon already serves this machine root.
    case held(path: String, pid: Int32?)
    case systemCall(String, Int32)

    public var description: String {
        switch self {
        case .held(let path, let pid): return "another daemon\(pid.map { " (pid \($0))" } ?? "") holds \(path), so this one exits without serving its machine root"
        case .systemCall(let operation, let code): return "could not take the machine lock: \(operation) failed (errno \(code))"
        }
    }
}
