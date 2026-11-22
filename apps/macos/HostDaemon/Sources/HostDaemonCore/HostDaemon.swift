import Foundation

/// The daemon's parts, wired once, and its one entry for requests: the catalog's image operations and the connector's
/// image calls go to `ImageHost` (`ImageHost.answers`), everything else to `SandboxHost`. Every host operation kind is
/// registered here, before the journal starts.
public struct HostDaemon: Sendable {
    public let sandboxes: SandboxHost
    public let images: ImageHost
    public var operations: HostOperationStore { sandboxes.operations }

    /// Wires image capture, copy (over `transport`) and create-after-copy to `sandboxes`, and the macOS builds
    /// `macBuilder` runs, and registers their kinds (with the proof's fixture kind when `dev`); host work starting and
    /// ending reaches `sandboxes`' idle-sleep prevention.
    public init(sandboxes: SandboxHost, macBuilder: MacBaseBuilder, transport: any ImageCopyTransport, copyPeerWaitMs: Int = 120_000, dev: Bool = false) async {
        let operations = sandboxes.operations, store = sandboxes.store
        let capture = ImageCapture(store: store, operations: operations, sandboxes: sandboxes)
        let copy = ImageCopy(store: store, operations: operations, transport: transport, peerWaitMs: copyPeerWaitMs)
        await operations.register(capture)
        await operations.register(copy)
        await operations.register(macBuilder)
        await operations.register(SandboxCreateAfterCopy(operations: operations, sandboxes: sandboxes))
        if dev { await operations.register(SleepStepsOperation()) }
        // Long host work keeps the Mac awake like a running sandbox does.
        await operations.onRunningChange { [weak sandboxes] in Task { await sandboxes?.hostWorkChanged() } }
        self.sandboxes = sandboxes
        images = ImageHost(operations: operations, store: store, capture: capture, copy: copy, macBuilder: macBuilder, allowsDirectOperations: dev)
    }

    public func request(_ envelope: Data) async throws -> Data {
        let operation = (try? JSONSerialization.jsonObject(with: envelope) as? [String: Any])?["operation"] as? String
        if let operation, ImageHost.answers(operation) { return await images.request(envelope) }
        return try await sandboxes.request(envelope)
    }
}
