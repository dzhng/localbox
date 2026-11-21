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
        .executableTarget(name: "localbox-hostd", dependencies: ["HostDaemonCore"]),
        .executableTarget(name: "localbox-vmlab", dependencies: ["HostDaemonCore"]),
        // Runs inside darwin guests, not on the host.
        .executableTarget(name: "localbox-vsock"),
        // The darwin agent's desktop helper (ScreenCaptureKit, CGEvent); runs inside darwin guests.
        .executableTarget(name: "localbox-desktop"),
        // Spike 20's transfer lab; slice 37 moves its transport into the ImageTransfer library.
        .executableTarget(name: "localbox-punchlab"),
        .testTarget(name: "HostDaemonCoreTests", dependencies: ["HostDaemonCore"]),
    ]
)
