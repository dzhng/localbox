import Foundation

private let gib: UInt64 = 1024 * 1024 * 1024

/// A size for a report, e.g. "2 GiB" or "1.5 GiB".
func gibibytes(_ bytes: UInt64) -> String { "\(String(format: "%g", (Double(bytes) / Double(gib) * 10).rounded() / 10)) GiB" }

/// A duration for a report, in the largest whole unit: "5 s", "10 min", "2 h".
func spoken(_ seconds: TimeInterval) -> String {
    let whole = Int(seconds.rounded())
    if whole >= 3_600, whole % 3_600 == 0 { return "\(whole / 3_600) h" }
    if whole >= 60, whole % 60 == 0 { return "\(whole / 60) min" }
    return "\(whole) s"
}

extension OperatingSystemVersion {
    /// "27.2.1", as capacity, image manifests and the IPSW catalog name a macOS release.
    public var dotted: String { "\(majorVersion).\(minorVersion).\(patchVersion)" }
}

extension Date {
    /// Milliseconds since 1970, as the journal and the wire keep times.
    public var epochMs: Int { Int((timeIntervalSince1970 * 1000).rounded()) }
}
