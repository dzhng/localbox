import LocalboxAppCore
import SwiftUI

/// The status item's popover: draws `PopoverRows` and hands every click to `perform`. It runs nothing itself; the
/// app turns actions into CLI invocations. Chrome: 352 pt wide,
/// 16 pt outer padding, a 16 pt semibold title, 11 pt section labels, 12 pt rows of 38 pt (48 pt with a second line),
/// a separated footer, and NSPopover's own material behind a transparent view.
public struct PopoverView: View {
    public static let width: CGFloat = 352
    /// The tallest the lists get before they scroll, so a long list never pushes the popover off the screen.
    public static let listLimit: CGFloat = 400

    let rows: PopoverRows
    let perform: (PopoverAction) -> Void

    public init(rows: PopoverRows, perform: @escaping (PopoverAction) -> Void) {
        self.rows = rows; self.perform = perform
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HeaderView(header: rows.header)
                .padding(.horizontal, 16).padding(.top, 14)
            if let warning = rows.warning {
                WarningBand(warning: warning).padding(.horizontal, 16).padding(.top, 12)
            }
            switch rows.body {
            case .lists(let sandboxes, let empty, let images):
                CappedScroll(limit: Self.listLimit) {
                    VStack(alignment: .leading, spacing: 0) {
                        SectionLabel(title: rows.sandboxesTitle)
                        if let empty { EmptyLine(text: empty) }
                        ForEach(sandboxes, id: \.id) { SandboxRowView(row: $0, perform: perform) }
                        if !images.isEmpty {
                            SectionLabel(title: rows.imagesTitle)
                            ForEach(images, id: \.name) { ImageRowView(row: $0) }
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.bottom, 4)
                }
            case .stopping(let title, let pending, let note):
                StoppingView(title: title, pending: pending, note: note).padding(.horizontal, 16)
            }
            FooterView(settings: rows.settings, quit: rows.quit, perform: perform)
        }
        .frame(width: Self.width, alignment: .leading)
    }
}

private extension PopoverRows.Tone {
    var color: Color {
        switch self {
        case .good: return Color(nsColor: .systemGreen)
        case .neutral: return Color(nsColor: .tertiaryLabelColor)
        case .busy: return Color(nsColor: .systemBlue)
        case .warning: return Color(nsColor: .systemOrange)
        case .failed: return Color(nsColor: .systemRed)
        }
    }
}

private struct StatusDot: View {
    let tone: PopoverRows.Tone
    var body: some View { Circle().fill(tone.color).frame(width: 6, height: 6) }
}

private struct HeaderView: View {
    let header: PopoverRows.Header
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .center, spacing: 12) {
                AppMark()
                VStack(alignment: .leading, spacing: 2) {
                    Text(header.title)
                        .font(.system(size: 16, weight: .semibold))
                        .lineLimit(1).truncationMode(.middle)
                    HStack(spacing: 5) {
                        StatusDot(tone: header.connectionTone)
                        Text(header.connection).font(.system(size: 11)).foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 8)
                if !header.version.isEmpty {
                    Text(header.version).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            if header.room != nil || header.keepingAwake != nil {
                VStack(alignment: .leading, spacing: 3) {
                    ForEach([header.room, header.keepingAwake].compactMap { $0 }, id: \.self) { line in
                        Text(line).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1).padding(.leading, 2)
                    }
                }
            }
        }
    }
}

/// Placeholder art: the brand mark arrives with the status item's art (see the README).
private struct AppMark: View {
    var body: some View {
        RoundedRectangle(cornerRadius: 7, style: .continuous)
            .fill(LinearGradient(colors: [Color(red: 0.36, green: 0.55, blue: 0.98), Color(red: 0.20, green: 0.38, blue: 0.86)], startPoint: .top, endPoint: .bottom))
            .frame(width: 30, height: 30)
            .overlay(Image(systemName: "shippingbox.fill").font(.system(size: 14, weight: .semibold)).foregroundStyle(.white))
            .accessibilityHidden(true)
    }
}

private struct WarningBand: View {
    let warning: PopoverRows.Warning
    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 13)).foregroundStyle(Color(nsColor: .systemOrange))
                .frame(width: 16, height: 16)
            VStack(alignment: .leading, spacing: 4) {
                Text(warning.message).font(.system(size: 12, weight: .medium))
                // Stronger than .secondary: grey on the orange tint reads poorly in light mode.
                if let fix = warning.fix { Text(fix).font(.system(size: 11)).foregroundStyle(Color.primary.opacity(0.75)) }
                if let more = warning.more { Text(more).font(.system(size: 11)).foregroundStyle(Color.primary.opacity(0.75)) }
            }
            .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color(nsColor: .systemOrange).opacity(0.18)))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color(nsColor: .systemOrange).opacity(0.55), lineWidth: 1))
    }
}

private struct SectionLabel: View {
    let title: String
    var body: some View {
        Text(title).font(.system(size: 11, weight: .medium)).foregroundStyle(.secondary)
            .padding(.leading, 2).padding(.top, 14).padding(.bottom, 2)
    }
}

private struct EmptyLine: View {
    let text: String
    var body: some View {
        Text(text).font(.system(size: 12)).foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, minHeight: 38, alignment: .leading)
            .padding(.leading, 2)
    }
}

private struct ProgressBar: View {
    let fraction: Double
    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.primary.opacity(0.12))
                Capsule().fill(Color(nsColor: .controlAccentColor)).frame(width: max(4, geometry.size.width * fraction))
            }
        }
        .frame(height: 4)
        .accessibilityValue("\(Int(fraction * 100)) percent")
    }
}

/// A row: a 16 pt icon at x 22 and its name and state at x 50, centred together;
/// a progress bar or an error spans from the text to the row's right edge beneath them.
private struct RowLayout<Trailing: View>: View {
    let symbol: String
    let title: String
    let detail: String
    let tone: PopoverRows.Tone
    let progress: Double?
    let error: String?
    @ViewBuilder let trailing: Trailing

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .center, spacing: 12) {
                Image(systemName: symbol).font(.system(size: 13)).foregroundStyle(.secondary).frame(width: 16, height: 16)
                VStack(alignment: .leading, spacing: 3) {
                    Text(title).font(.system(size: 12)).lineLimit(1).truncationMode(.middle)
                    HStack(spacing: 5) {
                        StatusDot(tone: tone)
                        Text(detail).font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                trailing.frame(width: 24)
            }
            Group {
                if let progress { ProgressBar(fraction: progress).padding(.trailing, 4) }
                if let error {
                    Label { Text(error) } icon: { Image(systemName: "exclamationmark.circle.fill") }
                        .labelStyle(ErrorLabelStyle())
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(.leading, 28)
        }
        .padding(.leading, 6)
        .padding(.vertical, 6)
        .frame(minHeight: 48)
    }
}

/// A failed action's message: red, with an icon so it does not rely on colour alone.
private struct ErrorLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 4) {
            configuration.icon.font(.system(size: 10))
            configuration.title.font(.system(size: 11))
        }
        .foregroundStyle(Color(nsColor: .systemRed))
    }
}

private struct SandboxRowView: View {
    let row: PopoverRows.Sandbox
    let perform: (PopoverAction) -> Void

    var body: some View {
        RowLayout(symbol: row.os.lowercased() == "linux" ? "terminal" : "macwindow", title: row.name, detail: row.detail,
                  tone: row.tone, progress: row.progress, error: row.error) {
            Menu { items } label: { Image(systemName: "ellipsis.circle").font(.system(size: 14)) }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .fixedSize()
                .foregroundStyle(.secondary)
                .accessibilityLabel("Actions for \(row.name)")
        }
        .contentShape(Rectangle())
        .contextMenu { items }
    }

    @ViewBuilder private var items: some View {
        ForEach(row.items, id: \.title) { item in
            Button(item.title) { perform(item.action) }.disabled(!item.enabled)
        }
    }
}

private struct ImageRowView: View {
    let row: PopoverRows.Image
    var body: some View {
        RowLayout(symbol: "square.stack.3d.up", title: row.name, detail: row.detail, tone: row.tone, progress: row.progress, error: row.error) { Color.clear }
    }
}

private struct StoppingView: View {
    let title: String
    let pending: [String]
    let note: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(title).font(.system(size: 12, weight: .medium)).padding(.leading, 2).padding(.top, 16).padding(.bottom, 4)
            ForEach(pending, id: \.self) { name in
                HStack(spacing: 12) {
                    Image(systemName: "moon.zzz").font(.system(size: 13)).foregroundStyle(.secondary).frame(width: 16, height: 16)
                    Text(name).font(.system(size: 12)).lineLimit(1)
                }
                .padding(.leading, 6)
                .frame(height: 30)
            }
            if let note {
                Text(note).font(.system(size: 11)).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.leading, 2).padding(.top, 6)
            }
        }
    }
}

private struct FooterView: View {
    let settings: PopoverRows.Item?
    let quit: PopoverRows.Item
    let perform: (PopoverAction) -> Void

    var body: some View {
        VStack(spacing: 0) {
            Divider().padding(.top, 12)
            HStack {
                if let settings { FooterButton(item: settings, perform: perform) }
                Spacer()
                FooterButton(item: quit, perform: perform)
            }
            .padding(.horizontal, 20)
            .frame(height: 44)
        }
    }
}

private struct FooterButton: View {
    let item: PopoverRows.Item
    let perform: (PopoverAction) -> Void
    @State private var hovering = false

    var body: some View {
        Button { perform(item.action) } label: {
            Text(item.title).font(.system(size: 12))
                .padding(.horizontal, 6).padding(.vertical, 3)
                .background(RoundedRectangle(cornerRadius: 5).fill(Color.primary.opacity(hovering && item.enabled ? 0.08 : 0)))
        }
        .buttonStyle(.plain)
        .foregroundStyle(item.enabled ? Color.secondary : Color(nsColor: .tertiaryLabelColor))
        .disabled(!item.enabled)
        .onHover { hovering = $0 }
    }
}

/// Its content at natural height up to `limit`, then a scroll view of exactly `limit` whose bottom edge fades, so a
/// cut-off row reads as "more below" rather than as a clipping mistake.
private struct CappedScroll<Content: View>: View {
    let limit: CGFloat
    @ViewBuilder let content: Content
    @State private var height: CGFloat = 0

    var body: some View {
        ScrollView(.vertical, showsIndicators: true) {
            content.background(GeometryReader { geometry in
                Color.clear.preference(key: ContentHeight.self, value: geometry.size.height)
            })
        }
        .frame(height: min(height, limit))
        .mask(VStack(spacing: 0) {
            Rectangle()
            LinearGradient(colors: [.black, .black.opacity(height > limit ? 0 : 1)], startPoint: .top, endPoint: .bottom).frame(height: 36)
        })
        .onPreferenceChange(ContentHeight.self) { height = $0 }
    }
}

private struct ContentHeight: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}
