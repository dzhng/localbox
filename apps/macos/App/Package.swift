// swift-tools-version: 5.9
import Foundation
import PackageDescription

// The patched Sparkle.framework (apps/macos/App/sparkle, `npm run sparkle:build`), linked only when
// LOCALBOX_SPARKLE_FRAMEWORK names it, as Bento links its own with BENTO_SPARKLE_FRAMEWORK. Without it the package
// builds an app that cannot update itself (CI, development), whose `update` fact is null; `SparkleDriver` compiles only
// under LOCALBOX_SPARKLE.
let sparkle = ProcessInfo.processInfo.environment["LOCALBOX_SPARKLE_FRAMEWORK"].flatMap { $0.isEmpty ? nil : $0 }
let sparkleDirectory = sparkle.map {
    URL(fileURLWithPath: $0, relativeTo: URL(fileURLWithPath: #filePath).deletingLastPathComponent()).standardizedFileURL.deletingLastPathComponent().path
}

// Localbox.app. A package of its own (not a target in HostDaemon) so the app's frameworks and flags never touch the
// daemon's build or `swift test`, and so the app cannot reach into the daemon's code: it speaks to the daemon and
// the connector only as processes, and to everything else through the bundled CLI.
let package = Package(
    name: "LocalboxApp",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "LocalboxAppCore", targets: ["LocalboxAppCore"]),
        .library(name: "LocalboxMenu", targets: ["LocalboxMenu"]),
        .executable(name: "Localbox", targets: ["Localbox"]),
    ],
    targets: [
        // Lifetime and supervision, with no AppKit UI, so the Node test runners compile it into small drivers.
        .target(name: "LocalboxAppCore"),
        // The popover's SwiftUI views: they draw `PopoverRows` and spawn nothing, so view shots render them offscreen.
        .target(name: "LocalboxMenu", dependencies: ["LocalboxAppCore"]),
        .executableTarget(
            name: "Localbox", dependencies: ["LocalboxAppCore", "LocalboxMenu"],
            swiftSettings: sparkleDirectory.map { [.define("LOCALBOX_SPARKLE"), .unsafeFlags(["-F", $0])] } ?? [],
            linkerSettings: sparkleDirectory.map { [.unsafeFlags(["-F", $0, "-framework", "Sparkle", "-Xlinker", "-rpath", "-Xlinker", "@executable_path/../Frameworks"])] } ?? []),
    ]
)
