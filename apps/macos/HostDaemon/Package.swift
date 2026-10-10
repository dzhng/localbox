// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "HostDaemon",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "HostDaemonCore", targets: ["HostDaemonCore"]),
    ],
    targets: [
        .target(name: "HostDaemonCore"),
        .testTarget(name: "HostDaemonCoreTests", dependencies: ["HostDaemonCore"]),
    ]
)
