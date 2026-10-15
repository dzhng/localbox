#if os(macOS)
import Foundation
import IOKit
import IOKit.pwr_mgt

/// The Mac's sleep and power-off notices (`IORegisterForSystemPower`, L6), handed to `SandboxHost.power`. The Mac
/// may sleep or power off once the sandboxes are down (`IOAllowPowerChange`); a wake brings back what the sleep took.
public final class SystemPowerMonitor: @unchecked Sendable {
    // IOKit's message constants are C macros Swift does not import: iokit_common_msg(n) is 0xE0000000 | n.
    private static let canSystemSleep: natural_t = 0xE000_0270
    private static let systemWillSleep: natural_t = 0xE000_0280
    private static let systemHasPoweredOn: natural_t = 0xE000_0300
    private static let systemWillRestart: natural_t = 0xE000_0310
    private static let systemWillPowerOff: natural_t = 0xE000_0250

    private let host: SandboxHost
    private let log: @Sendable (String) -> Void
    private let queue = DispatchQueue(label: "org.localbox.power")
    private var rootPort: io_connect_t = 0
    private var notificationPort: IONotificationPortRef?
    private var notifier: io_object_t = 0

    public init(host: SandboxHost, log: @escaping @Sendable (String) -> Void) { self.host = host; self.log = log }

    public func start() throws {
        rootPort = IORegisterForSystemPower(Unmanaged.passUnretained(self).toOpaque(), &notificationPort, { refcon, _, message, argument in
            guard let refcon else { return }
            Unmanaged<SystemPowerMonitor>.fromOpaque(refcon).takeUnretainedValue().handle(message, notification: Int(bitPattern: argument))
        }, &notifier)
        guard rootPort != 0, let notificationPort else { throw HostDaemonError.unsupported("IORegisterForSystemPower failed") }
        IONotificationPortSetDispatchQueue(notificationPort, queue)
    }

    private func handle(_ message: natural_t, notification: Int) {
        switch message {
        case Self.canSystemSleep: IOAllowPowerChange(rootPort, notification)
        case Self.systemWillSleep: run(.willSleep, acknowledging: notification)
        case Self.systemWillPowerOff, Self.systemWillRestart: run(.willPowerOff, acknowledging: notification)
        case Self.systemHasPoweredOn: run(.didWake, acknowledging: nil)
        default: break
        }
    }

    private func run(_ event: PowerEvent, acknowledging notification: Int?) {
        let host = host, log = log, rootPort = rootPort
        Task {
            for (id, action) in await host.power(event).sorted(by: { $0.key < $1.key }) { log("\(event.rawValue) \(id) \(action["kind"] ?? ""): \(action["detail"] ?? "")") }
            if let notification { IOAllowPowerChange(rootPort, notification) }
        }
    }
}
#endif
