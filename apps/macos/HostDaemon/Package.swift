// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "HostDaemon",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "HostDaemonCore", targets: ["HostDaemonCore"]),
        .executable(name: "localbox-hostd", targets: ["localbox-hostd"]),
    ],
    targets: [
        .target(name: "HostDaemonCore"),
        .executableTarget(name: "localbox-hostd", dependencies: ["HostDaemonCore"]),
        .testTarget(name: "HostDaemonCoreTests", dependencies: ["HostDaemonCore"]),
    ]
)
