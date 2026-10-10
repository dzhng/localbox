// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "VMProbe",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "VMProbeCore", targets: ["VMProbeCore"]),
        .executable(name: "vm-probe", targets: ["vm-probe"]),
    ],
    targets: [
        .target(name: "VMProbeCore"),
        .executableTarget(name: "vm-probe", dependencies: ["VMProbeCore"]),
        .testTarget(name: "VMProbeCoreTests", dependencies: ["VMProbeCore"]),
    ]
)
