import Foundation

/// Deterministic backend for host CI and contract tests. The marker is written
/// to the supplied disk path, so two invocations demonstrate persistence.
public struct FakeVMBackend: VMProbeBackend {
    public let name = "fake"
    private let marker = "localbox-vm-probe-marker-v1"

    public init() {}

    public func run(diskURL: URL) throws -> VMProbeReport {
        let fm = FileManager.default
        try fm.createDirectory(at: diskURL, withIntermediateDirectories: true)
        let markerURL = diskURL.appendingPathComponent("probe-marker")
        let warm = fm.fileExists(atPath: markerURL.path)
        if !warm { try marker.data(using: .utf8)!.write(to: markerURL, options: .atomic) }

        let host = HostFacts(
            architecture: ProcessInfo.processInfo.machineArchitecture,
            macOSVersion: ProcessInfo.processInfo.operatingSystemVersionString,
            isAppleSilicon: ProcessInfo.processInfo.machineArchitecture == "arm64"
        )
        let guestIP = "192.168.64.2"
        let egressIP = "198.51.100.42"
        // A cold run creates the marker; a warm run proves it survived the
        // previous stop/start. Both are successful probe outcomes.
        let checks = [true, true, true, true, true]
        let resourceFacts = ResourceFacts(vmProcessLeaked: false, socketLeaked: false, diskLockLeaked: false)
        let allPassed = checks.allSatisfy { $0 } && resourceFacts.passed
        return VMProbeReport(
            backend: name,
            host: host,
            boot: BootFacts(coldBootMs: warm ? 0 : 42, warmBootMs: warm ? 17 : 0,
                             readinessMarker: "READY vm-probe-v1", coldBootReady: true, warmBootReady: true),
            guest: GuestFacts(identity: "localbox-fake-guest", architecture: "aarch64",
                              kernel: "linux-fake-6.6", ipAddress: guestIP),
            diskMarkerPersistence: CheckResult(passed: warm || fm.fileExists(atPath: markerURL.path),
                                                detail: warm ? "marker survived a prior stop/start" : "marker created for next run"),
            pauseResume: CheckResult(passed: true, detail: "pause/resume preserved guest marker"),
            outboundHTTPS: EgressFacts(passed: true, url: "https://example.com/", observedIP: egressIP,
                                       detail: "deterministic fake NAT egress"),
            hostPathIsolation: CheckResult(passed: true, detail: "guest channel exposes no host paths"),
            reconnect: CheckResult(passed: true, detail: "injected channel drop reconnected without disk changes"),
            cleanStop: CheckResult(passed: true, detail: "stop completed and guest resources were released"),
            resourceLeaks: resourceFacts,
            verdict: allPassed ? "pass" : "fail",
            notes: warm ? ["fake backend: warm persistence run"] : ["fake backend: cold run; repeat with the same disk for persistence"]
        )
    }
}

private extension ProcessInfo {
    var machineArchitecture: String {
        #if arch(arm64)
        return "arm64"
        #elseif arch(x86_64)
        return "x86_64"
        #else
        return "unknown"
        #endif
    }
}
