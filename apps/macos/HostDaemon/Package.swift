// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "HostDaemon",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "HostDaemonCore", targets: ["HostDaemonCore"]),
        .executable(name: "localbox-hostd", targets: ["localbox-hostd"]),
        .executable(name: "localbox-vmlab", targets: ["localbox-vmlab"]),
    ],
    targets: [
        .target(name: "HostDaemonCore"),
        .executableTarget(name: "localbox-hostd", dependencies: ["HostDaemonCore"]),
        .executableTarget(name: "localbox-vmlab", dependencies: ["HostDaemonCore"]),
        .testTarget(name: "HostDaemonCoreTests", dependencies: ["HostDaemonCore"]),
    ]
)
