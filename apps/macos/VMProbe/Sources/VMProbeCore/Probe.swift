import Foundation

public enum VMProbeError: Error, CustomStringConvertible, Sendable {
    case unsupported(String)
    case invalidConfiguration(String)
    case backend(String)

    public var description: String {
        switch self {
        case .unsupported(let message), .invalidConfiguration(let message), .backend(let message):
            return message
        }
    }
}

/// A backend owns VM resources. The probe owns the evidence/report shape.
public protocol VMProbeBackend: Sendable {
    var name: String { get }
    func run(diskURL: URL) throws -> VMProbeReport
}

public enum VMProbeFactory {
    public static func makeDefault() -> any VMProbeBackend {
        #if os(macOS)
        return AppleVirtualizationBackend()
        #else
        return FakeVMBackend()
        #endif
    }

    public static func makeFake() -> any VMProbeBackend { FakeVMBackend() }
}

public enum VMProbeRunner {
    public static func run(backend: any VMProbeBackend, diskURL: URL) throws -> VMProbeReport {
        try backend.run(diskURL: diskURL)
    }
}
