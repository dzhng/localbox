import Foundation
@testable import HostDaemonCore

actor FakeGuestChannel: GuestChannel {
    private let handler: @Sendable (Data) async throws -> Data
    private(set) public var closed = false
    public private(set) var names: [String] = []
    public init(handler: @escaping @Sendable (Data) async throws -> Data) { self.handler = handler }
    public func send(_ envelope: Data) async throws -> Data { guard !closed else { throw HostDaemonError.guestUnavailable }; return try await handler(envelope) }
    public func rename(to name: String) { names.append(name) }
    public func close() { closed = true }
}

/// A VM that only records its lifecycle; its guest answers with `guest`, and `save` fails with `saveError` when set.
actor FakeSandboxBackend: HibernateBackend, GuestChannelProvider {
    public private(set) var running = false
    private let guest: @Sendable (Data) async throws -> Data
    private let saveError: HostDaemonError?
    public init(saveError: HostDaemonError? = nil, guest: @escaping @Sendable (Data) async throws -> Data = { $0 }) { self.saveError = saveError; self.guest = guest }
    public func start() { running = true }
    public func stop() { running = false }
    public func pause() { running = false }
    public func resume() { running = true }
    public func save(to url: URL) throws {
        if let saveError { throw saveError }
        try Data("saved".utf8).write(to: url); running = false
    }
    public func restore(from url: URL) throws {
        guard FileManager.default.fileExists(atPath: url.path) else { throw HostDaemonError.invalidState("saved machine state is missing") }
        running = true
    }
    public func makeGuestChannel() -> any GuestChannel { FakeGuestChannel(handler: guest) }
}

/// Makes `FakeSandboxBackend`s; `boots` counts the backends made, one per boot or restore.
final class FakeBackendFactory: SandboxBackendFactory, @unchecked Sendable {
    private let lock = NSLock()
    private var made = 0
    private let saveError: HostDaemonError?
    private let guest: @Sendable (Data) async throws -> Data
    /// `saveError`: every save fails with it, e.g. `.screenLocked` or `.unsupported("permission denied")`.
    public init(saveError: HostDaemonError? = nil, guest: @escaping @Sendable (Data) async throws -> Data = { $0 }) { self.saveError = saveError; self.guest = guest }
    public var boots: Int { lock.lock(); defer { lock.unlock() }; return made }
    public func provision(_ record: inout SandboxRecord, in directory: SandboxDirectory) throws -> [String: String] { record.mac = randomLocalMAC(); return [:] }
    public func backend(for record: SandboxRecord, in directory: SandboxDirectory) throws -> any SandboxBackend {
        lock.lock(); made += 1; lock.unlock()
        return FakeSandboxBackend(saveError: saveError, guest: guest)
    }
}
