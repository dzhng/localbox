import Foundation

/// Holds or lets go of the Mac's idle-sleep prevention. `SandboxHost` is its only caller and says what it should be
/// after every change; an implementation only acts when that differs from what it holds. Display sleep, a closed lid
/// and a sleep the user asks for are never held off.
public protocol IdleSleepPrevention: Sendable {
    func hold(_ held: Bool)
}

/// Holds nothing: tests, and daemons on the process fixture, which runs no VM a sleep could cut.
public struct NoIdleSleepPrevention: IdleSleepPrevention {
    public init() {}
    public func hold(_ held: Bool) {}
}

/// When the Mac must stay awake: while a sandbox is up or between states (an idle sleep would cut a boot, a guest's work,
/// a disk clone or a save half done), or while long host work runs (an image build, capture or copy). Asleep, paused,
/// stopped or failed sandboxes hold nothing.
enum KeepAwake {
    static func shouldStayAwake(_ lifecycles: [RuntimeLifecycle], hostWorkRunning: Bool) -> Bool {
        hostWorkRunning || lifecycles.contains(where: keepsAwake)
    }

    private static func keepsAwake(_ lifecycle: RuntimeLifecycle) -> Bool {
        switch lifecycle {
        case .starting, .ready, .freezing, .stopping: return true
        case .paused, .asleep, .stopped, .error: return false
        }
    }
}
