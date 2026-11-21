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
        .executable(name: "localbox-tccprobe", targets: ["localbox-tccprobe"]),
    ],
    targets: [
        .target(name: "HostDaemonCore"),
        .executableTarget(name: "localbox-hostd", dependencies: ["HostDaemonCore"]),
        .executableTarget(name: "localbox-vmlab", dependencies: ["HostDaemonCore"]),
        // Runs inside darwin guests, not on the host.
        .executableTarget(name: "localbox-vsock"),
        // Spike 18's desktop-role stand-in, run inside a darwin guest; slice 33's agent replaces it.
        .executableTarget(name: "localbox-tccprobe"),
        .testTarget(name: "HostDaemonCoreTests", dependencies: ["HostDaemonCore"]),
    ]
)
