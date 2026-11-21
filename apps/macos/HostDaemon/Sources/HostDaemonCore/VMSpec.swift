import Foundation

/// The operating system a sandbox's image runs. It picks the platform, the boot store and the devices.
public enum GuestOS: String, Codable, Sendable {
    case linux, macos
}

/// What a VM boots from besides its disk. Each sandbox has its own copy, made at create from its image, because a
/// saved state only restores with the boot store it was saved beside.
public enum BootStore: Equatable, Sendable {
    /// EFI firmware's variable store; GRUB and the kernel live on the disk, so there is no kernel command line.
    case linuxEFI(variableStore: URL)
    /// A macOS guest's auxiliary storage (its NVRAM).
    case macos(auxiliaryStorage: URL)

    /// The boot store a sandbox of `os` keeps in its own directory.
    public init(os: GuestOS, in directory: SandboxDirectory) {
        switch os {
        case .linux: self = .linuxEFI(variableStore: directory.bootStore(for: .linux))
        case .macos: self = .macos(auxiliaryStorage: directory.bootStore(for: .macos))
        }
    }

    var files: [URL] {
        switch self {
        case .linuxEFI(let store): return [store]
        case .macos(let storage): return [storage]
        }
    }
}

/// A virtual device the translator attaches.
public enum GuestDevice: String, Sendable {
    case virtioBlock, natNetwork, entropy, vsock, virtioConsole, macGraphics, macKeyboard, macTrackpad
}

/// The devices each guest OS gets. macOS has no entropy device or virtio console and gets Mac graphics (no window),
/// keyboard and trackpad instead, which a suspendable macOS guest needs (slice 16); neither OS gets audio.
public enum GuestPlatform {
    public static func devices(for os: GuestOS) -> [GuestDevice] {
        switch os {
        case .linux: return [.virtioBlock, .natNetwork, .entropy, .vsock, .virtioConsole]
        case .macos: return [.virtioBlock, .natNetwork, .vsock, .macGraphics, .macKeyboard, .macTrackpad]
        }
    }
}

/// Everything one boot of a sandbox's VM is made from, as plain values, so it is tested without booting.
/// `SandboxConfigurationBuilder` is the one translator to a Virtualization configuration.
public struct VMSpec: Equatable, Sendable {
    public enum Platform: Equatable, Sendable {
        /// `VZGenericMachineIdentifier.dataRepresentation`.
        case linux(machineIdentifier: Data)
        /// `VZMacMachineIdentifier` and `VZMacHardwareModel` data representations.
        case macos(machineIdentifier: Data, hardwareModel: Data)
        public var os: GuestOS {
            switch self { case .linux: return .linux; case .macos: return .macos }
        }
    }
    public let platform: Platform
    public let boot: BootStore
    public let cpus: Int
    public let memoryBytes: UInt64
    public let disk: URL
    /// Locally administered NAT MAC.
    public let mac: String
    /// Where the virtio console writes kernel and boot output; none for macOS, which has no virtio console.
    public let consoleLog: URL?
    public var devices: [GuestDevice] { GuestPlatform.devices(for: platform.os) }

    public init(platform: Platform, boot: BootStore, cpus: Int, memoryBytes: UInt64, disk: URL, mac: String, consoleLog: URL?) {
        self.platform = platform; self.boot = boot; self.cpus = cpus; self.memoryBytes = memoryBytes; self.disk = disk; self.mac = mac; self.consoleLog = consoleLog
    }

    /// A sandbox's spec from its record and directory alone: a saved state restores only into the configuration it was
    /// saved under, so nothing here may come from the environment (no shared files, no host settings).
    public init(record: SandboxRecord, in directory: SandboxDirectory) throws {
        guard let mac = record.mac else { throw HostDaemonError.invalidState("\(record.name) has no MAC address in its record") }
        guard let identifier = record.machineIdentifier.flatMap({ Data(base64Encoded: $0) }) else { throw HostDaemonError.invalidState("\(record.name) has no machine identifier in its record") }
        let platform: Platform
        switch record.os {
        case .linux: platform = .linux(machineIdentifier: identifier)
        case .macos:
            guard let model = record.hardwareModel.flatMap({ Data(base64Encoded: $0) }) else { throw HostDaemonError.invalidState("\(record.name) is a macOS sandbox with no hardware model in its record") }
            platform = .macos(machineIdentifier: identifier, hardwareModel: model)
        }
        self.init(platform: platform, boot: BootStore(os: record.os, in: directory), cpus: record.cpus, memoryBytes: record.memoryBytes, disk: directory.disk, mac: mac,
                  consoleLog: record.os == .linux ? directory.consoleLog : nil)
    }

    /// Files that must exist before a boot (the console log is created on demand).
    public var requiredFiles: [URL] { [disk] + boot.files }
}
