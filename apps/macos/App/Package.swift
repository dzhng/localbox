// swift-tools-version: 5.9
import PackageDescription

// Localbox.app. A package of its own (not a target in HostDaemon) so the app's frameworks and flags never touch the
// daemon's build or `swift test`, and so the app cannot reach into the daemon's code: it speaks to the daemon and
// the connector only as processes, and to everything else through the bundled CLI.
let package = Package(
    name: "LocalboxApp",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "LocalboxAppCore", targets: ["LocalboxAppCore"]),
        .executable(name: "Localbox", targets: ["Localbox"]),
    ],
    targets: [
        // Lifetime and supervision, with no AppKit UI, so the Node test runners compile it into small drivers.
        .target(name: "LocalboxAppCore"),
        .executableTarget(name: "Localbox", dependencies: ["LocalboxAppCore"]),
    ]
)
