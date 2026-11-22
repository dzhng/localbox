import Foundation

/// The built-in image a create can be told to wait for. Under Localbox.app, `localbox app image ensure` (the CLI, never
/// the daemon) downloads and installs `images/linux` after launch and keeps its progress in one file
/// (`LOCALBOX_BUILTIN_IMAGE_PROGRESS`, set by the app's `DaemonLaunch`). Until the image is here, a create from it is
/// refused `sandbox_not_ready`, retryable, with that progress, instead of `image_not_found`, since it is on its way.
public struct BuiltinImageWait: Sendable {
    public let progressFile: URL
    public init(progressFile: URL) { self.progressFile = progressFile }

    /// Why a create from the built-in image must wait, or nil when the image is here.
    func refusal(_ store: ImageStore) -> BuiltinImageRefusal? {
        if (try? store.manifest(builtInImage)) != nil { return nil }
        let line = (try? Data(contentsOf: progressFile)).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
        let phase = line["phase"] as? String
        let done = (line["done_bytes"] as? NSNumber)?.uint64Value ?? 0, total = (line["total_bytes"] as? NSNumber)?.uint64Value ?? 0
        let next = "try again when `localbox app status` shows it ready"
        let message: String
        switch phase {
        case "downloading" where total > 0: message = "the built-in image is still downloading (\(megabytes(done)) of \(megabytes(total))); \(next)"
        case "expanding", "installing": message = "the built-in image is downloaded and being unpacked (\(phase!)); \(next)"
        case "failed": message = "the built-in image did not download (\(line["error"] as? String ?? "no reason given")) and Localbox is retrying; \(next)"
        default: message = "the built-in image is still downloading; \(next)"
        }
        var details: [String: Any] = ["state": phase == "failed" ? "failed" : "downloading", "image": builtInImage, "phase": phase ?? "starting"]
        if total > 0 { details["progress"] = ["done_bytes": done, "total_bytes": total] }
        return BuiltinImageRefusal(message: message, details: details)
    }
}

/// `sandbox_not_ready`'s message and details for a create that waits for the built-in image.
struct BuiltinImageRefusal: @unchecked Sendable {
    let message: String
    let details: [String: Any]
}

/// "345 MB": decimal megabytes, as download progress is usually read.
private func megabytes(_ bytes: UInt64) -> String { "\(Int((Double(bytes) / 1_000_000).rounded())) MB" }
