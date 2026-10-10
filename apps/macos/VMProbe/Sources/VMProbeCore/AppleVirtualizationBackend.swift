import Foundation

#if os(macOS)
import Virtualization

/// Native Apple Virtualization adapter. Image preparation and guest protocol
/// remain explicit inputs so this seam cannot silently fall back to the fake.
public struct AppleVirtualizationBackend: VMProbeBackend {
    public let name = "apple-virtualization"
    public let image: VMImageConfiguration?

    public init(image: VMImageConfiguration? = nil) { self.image = image }

    public func run(diskURL: URL) throws -> VMProbeReport {
        guard let image else {
            throw VMProbeError.unsupported("Apple Virtualization probe requires a pinned ARM64 image configuration")
        }
        let configuration = try image.makeConfiguration(diskURL: diskURL)
        try configuration.validate()
        // Starting a VM is intentionally performed by the host daemon, which
        // owns its run loop and guest channel. This probe validates the exact
        // native configuration without inventing a second lifecycle owner.
        throw VMProbeError.unsupported("native configuration validated; host daemon lifecycle probe is required")
    }
}

public struct VMImageConfiguration: Sendable {
    public let kernelURL: URL
    public let initialRamdiskURL: URL
    public let rootFileSystemURL: URL
    public let diskSizeBytes: UInt64

    public init(kernelURL: URL, initialRamdiskURL: URL, rootFileSystemURL: URL, diskSizeBytes: UInt64) {
        self.kernelURL = kernelURL
        self.initialRamdiskURL = initialRamdiskURL
        self.rootFileSystemURL = rootFileSystemURL
        self.diskSizeBytes = diskSizeBytes
    }

    fileprivate func makeConfiguration(diskURL: URL) throws -> VZVirtualMachineConfiguration {
        guard FileManager.default.fileExists(atPath: kernelURL.path),
              FileManager.default.fileExists(atPath: initialRamdiskURL.path),
              FileManager.default.fileExists(atPath: rootFileSystemURL.path) else {
            throw VMProbeError.invalidConfiguration("kernel, initrd, and rootfs must all exist")
        }
        let config = VZVirtualMachineConfiguration()
        let bootLoader = VZLinuxBootLoader(kernelURL: kernelURL)
        bootLoader.initialRamdiskURL = initialRamdiskURL
        bootLoader.commandLine = "console=hvc0 root=/dev/vda rw"
        config.bootLoader = bootLoader
        config.cpuCount = 2
        config.memorySize = 2 * 1024 * 1024 * 1024
        let disk = try VZDiskImageStorageDeviceAttachment(url: diskURL, readOnly: false)
        config.storageDevices = [VZVirtioBlockDeviceConfiguration(attachment: disk)]
        config.networkDevices = [VZVirtioNetworkDeviceConfiguration()]
        config.entropyDevices = [VZVirtioEntropyDeviceConfiguration()]
        config.directorySharingDevices = []
        _ = rootFileSystemURL // rootfs is copied into the persistent disk by image tooling.
        return config
    }
}
#else

/// On non-macOS hosts the symbol still exists, making dependency injection and
/// cross-platform tests straightforward; selecting it returns a clear error.
public struct AppleVirtualizationBackend: VMProbeBackend {
    public let name = "apple-virtualization"
    public init() {}
    public func run(diskURL: URL) throws -> VMProbeReport {
        throw VMProbeError.unsupported("Apple Virtualization is available only on macOS")
    }
}
#endif
