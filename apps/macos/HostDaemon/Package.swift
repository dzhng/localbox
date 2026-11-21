// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "HostDaemon",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "HostDaemonCore", targets: ["HostDaemonCore"]),
        .executable(name: "localbox-hostd", targets: ["localbox-hostd"]),
        .executable(name: "localbox-vmlab", targets: ["localbox-vmlab"]),
        .executable(name: "localbox-vsock", targets: ["localbox-vsock"]),
        .executable(name: "localbox-desktop", targets: ["localbox-desktop"]),
    ],
    targets: [
        .target(name: "HostDaemonCore"),
        .executableTarget(name: "localbox-hostd", dependencies: ["HostDaemonCore", "ImageCopyTransfer"]),
        .executableTarget(name: "localbox-vmlab", dependencies: ["HostDaemonCore"]),
        // Runs inside darwin guests, not on the host.
        .executableTarget(name: "localbox-vsock"),
        // The darwin agent's desktop helper (ScreenCaptureKit, CGEvent); runs inside darwin guests.
        .executableTarget(name: "localbox-desktop"),
        // Image transfer between Macs (chunks, AEAD, resume, LAN and punched UDP paths). Never imports HostDaemonCore.
        .target(name: "ImageTransfer"),
        // The manual transfer tool and probe 20's driver, on top of ImageTransfer.
        .executableTarget(name: "localbox-punchlab", dependencies: ["ImageTransfer"]),
        // The daemon's image copy transport: HostDaemonCore's ImageCopyTransport over ImageTransfer.
        .target(name: "ImageCopyTransfer", dependencies: ["HostDaemonCore", "ImageTransfer"]),
        .testTarget(name: "HostDaemonCoreTests", dependencies: ["HostDaemonCore"]),
        .testTarget(name: "ImageTransferTests", dependencies: ["ImageTransfer"]),
        .testTarget(name: "ImageCopyTransferTests", dependencies: ["ImageCopyTransfer", "HostDaemonCore", "ImageTransfer"]),
    ]
)
