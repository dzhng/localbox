import AppKit
import LocalboxAppCore
import SwiftUI

/// The Settings window's form: About, General (agent setup, open at login, updates) and Account (email-code
/// sign-in), in a grouped form matched to the reference shots in specs/menu-bar-app/assets. Every change goes through `SettingsModel`, which runs the CLI; the view spawns nothing.
public struct SettingsView: View {
    @ObservedObject var model: SettingsModel
    /// Opens System Settings › General › Login Items (the app's own: `SMAppService.openSystemSettingsLoginItems`).
    let openLoginItems: () -> Void
    @State private var confirmingSignOut = false

    public init(model: SettingsModel, openLoginItems: @escaping () -> Void) {
        self.model = model; self.openLoginItems = openLoginItems
    }

    public var body: some View {
        Form {
            Section("About") {
                LabeledContent("Version", value: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "Development")
            }
            accountSection
            generalSection
        }
        .formStyle(.grouped)
    }

    // MARK: - Account

    private var accountSection: some View {
        Section {
            switch model.account {
            case .loading:
                detailRow("Account", "Reading this Mac's account…") {
                    ProgressView().controlSize(.small)
                }
            case .signedOut:
                LabeledContent("Email") {
                    HStack(spacing: 8) {
                        if model.busy == .sendingCode { ProgressView().controlSize(.small) }
                        field(TextField("Email", text: $model.email, prompt: Text(verbatim: "you@example.com"))) {
                            Task { await model.sendCode() }
                        }
                        Button("Send Code") { Task { await model.sendCode() } }
                            .disabled(!model.canSendCode)
                    }
                }
            case .codeSent(let email):
                detailRow("Check your email", "Enter the code we emailed to \(email).") {
                    Button("Use a Different Email") { model.useDifferentEmail() }
                        .disabled(model.busy != nil)
                        .fixedSize()
                }
                LabeledContent("Code") {
                    HStack(spacing: 8) {
                        if model.busy == .signingIn { ProgressView().controlSize(.small) }
                        field(TextField("Code", text: $model.code, prompt: Text(verbatim: "6 digits")).textContentType(.oneTimeCode)) {
                            Task { await model.signIn() }
                        }
                        Button("Sign In") { Task { await model.signIn() } }
                            .disabled(!model.canSignIn)
                    }
                }
            case .signedIn(let email, let machineName):
                detailRow("Account", email ?? "Signed in") {
                    HStack(spacing: 8) {
                        if model.busy == .signingOut { ProgressView().controlSize(.small) }
                        Button("Sign Out…") { confirmingSignOut = true }
                            .disabled(model.busy != nil)
                    }
                    .fixedSize()
                }
                .confirmationDialog("Sign this Mac out of Localbox?", isPresented: $confirmingSignOut) {
                    Button("Sign Out", role: .destructive) { Task { await model.signOut() } }
                } message: {
                    Text("Signing out removes this Mac from your Localbox account, so other computers and cloud agents can no longer reach its sandboxes.")
                }
                LabeledContent("This Mac", value: machineName)
            }
            if let failure = model.accountFailure {
                Label(failure, systemImage: "exclamationmark.circle.fill")
                    .labelStyle(StatusLabelStyle(tint: .orange))
            }
        } header: {
            Text("Account")
        } footer: {
            if case .signedIn = model.account {
                Text("Other computers and cloud agents signed in to this account can use this Mac's sandboxes.")
                    .foregroundStyle(.secondary)
            } else {
                Text("Signing in connects this Mac to your Localbox account.")
                    .foregroundStyle(.secondary)
            }
        }
    }

    /// A bordered field of a fixed width, so an empty one reads as a place to type and its prompt as a prompt.
    private func field(_ field: some View, submit: @escaping () -> Void) -> some View {
        field
            .labelsHidden()
            .textFieldStyle(.roundedBorder)
            .multilineTextAlignment(.leading)
            .frame(width: 200)
            .onSubmit(submit)
            .disabled(model.busy != nil)
    }

    // MARK: - General

    /// A row whose label runs to a second explanatory line. `LabeledContent` aligns its value with
    /// the first line, which leaves a status and its button riding high against two lines of text,
    /// so this centers the value against the whole label the way System Settings does.
    private func detailRow(
        _ title: String, _ detail: String, @ViewBuilder content: () -> some View
    ) -> some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                if !detail.isEmpty { Text(detail).font(.callout).foregroundStyle(.secondary) }
            }
            Spacer(minLength: 12)
            content()
        }
    }

    private var generalSection: some View {
        Section {
            Toggle("Show this window when Localbox starts", isOn: $model.showAtLaunch)
            detailRow("Set up my agents", model.agentSummary) {
                Toggle("", isOn: setUpAgents).labelsHidden()
            }
            if let failure = model.agentSetupFailure {
                Text(failure).foregroundStyle(.red)
            }
            detailRow("Open at login", model.loginItemDescription) {
                Toggle("", isOn: openAtLogin).labelsHidden()
            }
            if let failure = model.loginFailure {
                Text(failure).foregroundStyle(.red)
            }
            // The toggle registers the login item by itself. Only when macOS keeps that decision
            // for a person to confirm, or does not recognise this copy, does anyone need the pane.
            if model.needsLoginItemsSettings {
                HStack {
                    Spacer(minLength: 12)
                    Button("Open Login Items Settings…") { openLoginItems() }
                }
            }
            if let updates = model.updates {
                Toggle("Automatically download and install updates", isOn: Binding(
                    get: { updates.enabled },
                    set: { value in Task { await model.setAutomaticUpdates(value) } }))
                HStack {
                    Spacer()
                    Button("Check for Updates") { Task { await model.checkForUpdates() } }
                        .disabled(!updates.canCheck)
                }
                if let status = updates.status {
                    Text(status).font(.callout).foregroundStyle(.secondary)
                }
                if let failure = model.updateFailure {
                    Text(failure).foregroundStyle(.red)
                }
            } else {
                Text("Updates are installed manually in this build.")
                    .foregroundStyle(.secondary)
            }
        } header: {
            Text("General")
        } footer: {
            if let updates = model.updates {
                Text(updates.enabled
                    ? "Installs when sandboxes and background work are idle."
                    : "Automatic updates are off. You can still check and install manually.")
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var setUpAgents: Binding<Bool> {
        Binding(get: { model.setUpAgents }, set: { value in Task { await model.setAgentSetup(value) } })
    }

    private var openAtLogin: Binding<Bool> {
        Binding(get: { model.openAtLogin }, set: { value in Task { await model.setOpenAtLogin(value) } })
    }
}

/// A status word with a tinted symbol, the way System Settings states an access.
private struct StatusLabelStyle: LabelStyle {
    let tint: Color
    var titleTint: Color?

    init(tint: Color, titleTint: Color? = nil) {
        self.tint = tint
        self.titleTint = titleTint
    }

    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 4) {
            configuration.icon.foregroundStyle(tint)
            configuration.title.foregroundStyle(titleTint ?? .secondary)
        }
    }
}
