import Foundation

/// The result of one host/guest viability probe. This is the stable seam consumed
/// by the CLI; adding backend details should not change the top-level keys.
public struct VMProbeReport: Codable, Equatable, Sendable {
    public let schemaVersion: String
    public let backend: String
    public let host: HostFacts
    public let boot: BootFacts
    public let guest: GuestFacts
    public let diskMarkerPersistence: CheckResult
    public let pauseResume: CheckResult
    public let outboundHTTPS: EgressFacts
    public let hostPathIsolation: CheckResult
    public let reconnect: CheckResult
    public let cleanStop: CheckResult
    public let resourceLeaks: ResourceFacts
    public let verdict: String
    public let notes: [String]

    public init(schemaVersion: String = "vm-probe.v1", backend: String,
                host: HostFacts, boot: BootFacts, guest: GuestFacts,
                diskMarkerPersistence: CheckResult, pauseResume: CheckResult,
                outboundHTTPS: EgressFacts, hostPathIsolation: CheckResult,
                reconnect: CheckResult, cleanStop: CheckResult,
                resourceLeaks: ResourceFacts, verdict: String, notes: [String] = []) {
        self.schemaVersion = schemaVersion
        self.backend = backend
        self.host = host
        self.boot = boot
        self.guest = guest
        self.diskMarkerPersistence = diskMarkerPersistence
        self.pauseResume = pauseResume
        self.outboundHTTPS = outboundHTTPS
        self.hostPathIsolation = hostPathIsolation
        self.reconnect = reconnect
        self.cleanStop = cleanStop
        self.resourceLeaks = resourceLeaks
        self.verdict = verdict
        self.notes = notes
    }
}

public struct HostFacts: Codable, Equatable, Sendable {
    public let architecture: String
    public let macOSVersion: String
    public let isAppleSilicon: Bool

    public init(architecture: String, macOSVersion: String, isAppleSilicon: Bool) {
        self.architecture = architecture
        self.macOSVersion = macOSVersion
        self.isAppleSilicon = isAppleSilicon
    }
}

public struct BootFacts: Codable, Equatable, Sendable {
    public let coldBootMs: Int
    public let warmBootMs: Int
    public let readinessMarker: String
    public let coldBootReady: Bool
    public let warmBootReady: Bool

    public init(coldBootMs: Int, warmBootMs: Int, readinessMarker: String,
                coldBootReady: Bool, warmBootReady: Bool) {
        self.coldBootMs = coldBootMs
        self.warmBootMs = warmBootMs
        self.readinessMarker = readinessMarker
        self.coldBootReady = coldBootReady
        self.warmBootReady = warmBootReady
    }
}

public struct GuestFacts: Codable, Equatable, Sendable {
    public let identity: String
    public let architecture: String
    public let kernel: String
    public let ipAddress: String

    public init(identity: String, architecture: String, kernel: String, ipAddress: String) {
        self.identity = identity
        self.architecture = architecture
        self.kernel = kernel
        self.ipAddress = ipAddress
    }
}

public struct CheckResult: Codable, Equatable, Sendable {
    public let passed: Bool
    public let detail: String

    public init(passed: Bool, detail: String) {
        self.passed = passed
        self.detail = detail
    }
}

public struct EgressFacts: Codable, Equatable, Sendable {
    public let passed: Bool
    public let url: String
    public let observedIP: String?
    public let detail: String

    public init(passed: Bool, url: String, observedIP: String?, detail: String) {
        self.passed = passed
        self.url = url
        self.observedIP = observedIP
        self.detail = detail
    }
}

public struct ResourceFacts: Codable, Equatable, Sendable {
    public let vmProcessLeaked: Bool
    public let socketLeaked: Bool
    public let diskLockLeaked: Bool

    public init(vmProcessLeaked: Bool, socketLeaked: Bool, diskLockLeaked: Bool) {
        self.vmProcessLeaked = vmProcessLeaked
        self.socketLeaked = socketLeaked
        self.diskLockLeaked = diskLockLeaked
    }

    public var passed: Bool { !vmProcessLeaked && !socketLeaked && !diskLockLeaked }
}
