#if LOCALBOX_SPARKLE
import AppKit
import LocalboxAppCore
import Sparkle

/// The Sparkle boundary, a port of Bento's `SparkleDriver`: a user driver that shows no Sparkle UI at all. Sparkle owns
/// the schedule, the automatic-check preference (its own `SUEnableAutomaticChecks` default), the signed feed, the
/// verified download and the replacement; `UpdateCoordinator` owns the app's permission to install. Built only when
/// the package links the patched framework (`LOCALBOX_SPARKLE_FRAMEWORK`, apps/macos/App/sparkle).
@MainActor
final class SparkleDriver: NSObject, SPUUpdaterDelegate, SPUUserDriver {
    private let owner: UpdateCoordinator
    private var updater: SPUUpdater!
    private var requestCancellation: (() -> Void)?

    /// Nil for a bundle with no feed, key or launch lock (a development build), or when Sparkle will not start.
    init?(owner: UpdateCoordinator, bundle: Bundle = .main, lock: LaunchLock?, failed: (String) -> Void) {
        guard let feed = bundle.object(forInfoDictionaryKey: "SUFeedURL") as? String, !feed.isEmpty,
              let key = bundle.object(forInfoDictionaryKey: "SUPublicEDKey") as? String, !key.isEmpty, let lock else { return nil }
        self.owner = owner
        super.init()
        do {
            // Sparkle's helper refuses a lock file that is not already a private one; the launcher may never have run.
            try lock.prepare()
            updater = SPUUpdater(hostBundle: bundle, applicationBundle: bundle, userDriver: self, delegate: self)
            try updater.start()
        } catch {
            failed("Sparkle did not start: \(error.localizedDescription)")
            return nil
        }
        owner.startCheck = { [weak self] in self?.updater.checkForUpdates() }
        owner.sparkleCanCheck = { [weak self] in self?.updater.canCheckForUpdates ?? false }
        owner.preferenceChanged = { [weak self] enabled in
            self?.updater.automaticallyChecksForUpdates = enabled
            if !enabled { self?.requestCancellation?() }
        }
        // Settings and `localbox update status` read the result through `app.info`; nothing is pushed to them.
        owner.setAvailability(enabled: updater.automaticallyChecksForUpdates)
    }

    // MARK: - SPUUpdaterDelegate

    func updater(_ updater: SPUUpdater, shouldProceedWithUpdate item: SUAppcastItem, updateCheck: SPUUpdateCheck) throws {
        guard item.signingValidationStatus == .succeeded else {
            throw NSError(domain: "sh.localbox.update", code: 1, userInfo: [NSLocalizedDescriptionKey: "the update is not signed by Localbox's key"])
        }
    }

    func updater(_ updater: SPUUpdater, didFinishUpdateCycleFor updateCheck: SPUUpdateCheck, error: Error?) {
        requestCancellation = nil
        let error = error as NSError?
        // Sparkle ends a check that found nothing newer with an error sentinel.
        let upToDate = error?.domain == SUSparkleErrorDomain && error?.code == Int(SUError.noUpdateError.rawValue)
        owner.cycleFinished(error: upToDate ? nil : error.map { Self.sentence($0) }, upToDate: upToDate)
    }

    func updaterWillRelaunchApplication(_ updater: SPUUpdater) { owner.willRelaunch() }

    // MARK: - SPUUserDriver (no UI)

    func show(_ request: SPUUpdatePermissionRequest, reply: @escaping (SUUpdatePermissionResponse) -> Void) {
        // Automatic checks are on by default (slice 15); the person's switch is Settings', never a Sparkle prompt.
        reply(SUUpdatePermissionResponse(automaticUpdateChecks: true, sendSystemProfile: false))
    }

    func showUserInitiatedUpdateCheck(cancellation: @escaping () -> Void) {
        requestCancellation = cancellation
        owner.checking()
    }

    func showUpdateFound(with appcastItem: SUAppcastItem, state: SPUUserUpdateState, reply: @escaping (SPUUserUpdateChoice) -> Void) {
        guard !appcastItem.isInformationOnlyUpdate else { reply(.dismiss); return }
        owner.downloading(version: appcastItem.displayVersionString)
        // An update already staged by an earlier cycle goes straight to the gate; any other is downloaded first.
        if state.stage == .installing { owner.ready(install: { reply(.install) }, cancel: { reply(.dismiss) }) } else { reply(.install) }
    }

    func showUpdateReleaseNotes(with downloadData: SPUDownloadData) {}
    func showUpdateReleaseNotesFailedToDownloadWithError(_ error: Error) {}
    func showUpdateNotFoundWithError(_ error: Error, acknowledgement: @escaping () -> Void) { acknowledgement() }

    func showUpdaterError(_ error: Error, acknowledgement: @escaping () -> Void) {
        owner.fail(Self.sentence(error as NSError))
        acknowledgement()
    }

    func showDownloadInitiated(cancellation: @escaping () -> Void) { requestCancellation = cancellation }
    func showDownloadDidReceiveExpectedContentLength(_ expectedContentLength: UInt64) {}
    func showDownloadDidReceiveData(ofLength length: UInt64) {}
    func showDownloadDidStartExtractingUpdate() { requestCancellation = nil }
    func showExtractionReceivedProgress(_ progress: Double) {}

    func showReady(toInstallAndRelaunch reply: @escaping (SPUUserUpdateChoice) -> Void) {
        owner.ready(install: { reply(.install) }, cancel: { reply(.skip) })
    }

    func showInstallingUpdate(withApplicationTerminated applicationTerminated: Bool, retryTerminatingApplication: @escaping () -> Void) {
        // The patched SDK's retry callback requests final authorization; the app's children are already down.
        owner.installing(authorize: retryTerminatingApplication)
    }

    func showUpdateInstalledAndRelaunched(_ relaunched: Bool, acknowledgement: @escaping () -> Void) { acknowledgement() }
    func dismissUpdateInstallation() {}

    /// Sparkle's message, without its closing full stop (the coordinator puts it in a sentence).
    private static func sentence(_ error: NSError) -> String {
        var text = error.localizedDescription
        if let reason = error.localizedFailureReason, !text.contains(reason) { text += " (\(reason))" }
        while text.hasSuffix(".") { text.removeLast() }
        return text.prefix(1).lowercased() + text.dropFirst()
    }
}
#endif
