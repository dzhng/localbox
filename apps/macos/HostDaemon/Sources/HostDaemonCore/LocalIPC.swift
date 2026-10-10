import Foundation

/// Local CLI/daemon IPC request. A launchd Unix socket or an in-process test
/// transport can carry this same shape without owning lifecycle state.
public struct LocalIPCRequest: Codable, Sendable {
    public let token: String
    public let envelope: Data
    public init(token: String, envelope: Data) { self.token = token; self.envelope = envelope }
}

public enum LocalIPCError: Error, CustomStringConvertible, Sendable {
    case unauthorized
    case malformed
    public var description: String { switch self { case .unauthorized: return "local IPC authentication failed"; case .malformed: return "malformed local IPC request" } }
}

public struct LocalIPCEndpoint: Sendable, Equatable {
    public let socketPath: String
    public init(socketPath: String = "~/Library/Application Support/AgentComputer/agent.sock") { self.socketPath = socketPath }
}

/// Authenticates before forwarding to the single HostDaemon lifecycle owner.
public actor AuthenticatedLocalIPC {
    private let daemon: HostDaemon
    private let token: String
    public let endpoint: LocalIPCEndpoint
    public init(daemon: HostDaemon, token: String, endpoint: LocalIPCEndpoint = LocalIPCEndpoint()) { self.daemon = daemon; self.token = token; self.endpoint = endpoint }
    public func handle(_ request: LocalIPCRequest) async throws -> Data {
        guard !request.token.isEmpty, constantTimeEqual(request.token, token) else { throw LocalIPCError.unauthorized }
        guard !request.envelope.isEmpty else { throw LocalIPCError.malformed }
        return try await daemon.request(request.envelope)
    }
}

private func constantTimeEqual(_ lhs: String, _ rhs: String) -> Bool {
    let a = Array(lhs.utf8); let b = Array(rhs.utf8); guard a.count == b.count else { return false }
    var difference: UInt8 = 0; for index in a.indices { difference |= a[index] ^ b[index] }; return difference == 0
}
