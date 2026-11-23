import Foundation

/// Holds or lets go of the Mac's idle-sleep prevention. `SandboxHost` is its only caller and says what it should be
/// after every change; an implementation only acts when that differs from what it holds. Display sleep, a closed lid
/// and a sleep the user asks for are never held off. Nothing lets go at exit: macOS drops a process's assertions when it
/// ends, however it ends.
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

#if os(macOS)
import IOKit.pwr_mgt

/// The idle-sleep assertion (`IOPMAssertionCreateWithName`, `PreventUserIdleSystemSleep`, shown by
/// `pmset -g assertions`). A closed lid or a sleep asked for still sleeps the Mac: `SystemPowerMonitor` hibernates the
/// sandboxes first.
public final class IOKitIdleSleepPrevention: IdleSleepPrevention, @unchecked Sendable {
    public static let reason = "Localbox is running sandboxes"
    private let log: @Sendable (String) -> Void
    private let lock = NSLock()
    private var assertion: IOPMAssertionID?

    public init(log: @escaping @Sendable (String) -> Void) { self.log = log }

    public func hold(_ held: Bool) {
        lock.lock(); defer { lock.unlock() }
        if held, assertion == nil {
            var id: IOPMAssertionID = 0
            let status = IOPMAssertionCreateWithName(kIOPMAssertionTypePreventUserIdleSystemSleep as CFString, IOPMAssertionLevel(kIOPMAssertionLevelOn), Self.reason as CFString, &id)
            if status == kIOReturnSuccess { assertion = id; log("keeping this Mac awake while sandboxes run") } else { log("could not keep this Mac awake: IOPMAssertionCreateWithName returned \(status)") }
        } else if !held, let id = assertion {
            IOPMAssertionRelease(id); assertion = nil
            log("letting this Mac idle-sleep again")
        }
    }
}
#endif
