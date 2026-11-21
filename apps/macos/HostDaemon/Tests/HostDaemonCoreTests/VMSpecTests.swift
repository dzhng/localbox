import Foundation
import XCTest
@testable import HostDaemonCore
#if os(macOS)
import Virtualization
#endif

final class VMSpecTests: XCTestCase {
    private var scratch: URL!
    override func setUpWithError() throws {
        scratch = FileManager.default.temporaryDirectory.appendingPathComponent("lb-vmspec-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)
    }
    override func tearDownWithError() throws { try? FileManager.default.removeItem(at: scratch) }

    private func record(_ os: GuestOS) -> SandboxRecord {
        var record = SandboxRecord(sandboxID: "sandbox_1", name: "brave-otter", imageID: os == .linux ? builtInImage : "image_mac", cpus: 2, memoryBytes: 2 << 30, sleepAfterMs: 60_000)
        record.os = os
        record.mac = "02:11:22:33:44:55"
        record.machineIdentifier = Data("machine-\(os)".utf8).base64EncodedString()
        if os == .macos { record.hardwareModel = Data("model".utf8).base64EncodedString() }
        return record
    }

    /// A saved state restores only into the configuration it was saved under, so every value comes from the record and
    /// every file from the sandbox's own directory: two daemons reading the same directory build the same spec.
    func testEveryRestoreInputComesFromTheRecordOrTheSandboxDirectory() throws {
        for os in [GuestOS.linux, .macos] {
            let directory = SandboxDirectory(scratch.appendingPathComponent(os.rawValue, isDirectory: true))
            let record = record(os)
            let spec = try VMSpec(record: record, in: directory)
            XCTAssertEqual(spec, try VMSpec(record: record, in: directory))
            XCTAssertEqual(spec.cpus, record.cpus); XCTAssertEqual(spec.memoryBytes, record.memoryBytes); XCTAssertEqual(spec.mac, record.mac)
            switch spec.platform {
            case .linux(let identifier): XCTAssertEqual(os, .linux); XCTAssertEqual(identifier.base64EncodedString(), record.machineIdentifier)
            case .macos(let identifier, let model):
                XCTAssertEqual(os, .macos); XCTAssertEqual(identifier.base64EncodedString(), record.machineIdentifier); XCTAssertEqual(model.base64EncodedString(), record.hardwareModel)
            }
            for file in spec.requiredFiles + [spec.consoleLog].compactMap({ $0 }) {
                XCTAssertEqual(file.deletingLastPathComponent().standardizedFileURL, directory.url.standardizedFileURL, "\(file.path) is outside the sandbox's directory")
            }
            XCTAssertEqual(spec.boot, BootStore(os: os, in: directory))
        }
    }

    func testARecordMissingIdentityHasNoSpec() {
        let directory = SandboxDirectory(scratch)
        var noMAC = record(.linux); noMAC.mac = nil
        XCTAssertThrowsError(try VMSpec(record: noMAC, in: directory))
        var noModel = record(.macos); noModel.hardwareModel = nil
        XCTAssertThrowsError(try VMSpec(record: noModel, in: directory), "a macOS sandbox restores only with its hardware model")
    }

    func testMacOSGetsMacInputAndNoEntropyOrConsole() throws {
        let spec = try VMSpec(record: record(.macos), in: SandboxDirectory(scratch))
        XCTAssertFalse(spec.devices.contains(.entropy))
        XCTAssertFalse(spec.devices.contains(.virtioConsole))
        XCTAssertNil(spec.consoleLog)
        XCTAssertTrue(Set(spec.devices).isSuperset(of: [.macGraphics, .macKeyboard, .macTrackpad, .vsock, .natNetwork, .virtioBlock]))
        XCTAssertEqual(GuestPlatform.devices(for: .linux), [.virtioBlock, .natNetwork, .entropy, .vsock, .virtioConsole])
    }

    func testRecordRoundTripsImageAndOS() throws {
        let directory = SandboxDirectory(scratch)
        let record = record(.macos)
        try directory.save(record)
        XCTAssertEqual(try directory.load(), record)
        let json = try JSONSerialization.jsonObject(with: Data(contentsOf: directory.recordFile)) as? [String: Any]
        XCTAssertEqual(json?["image_id"] as? String, "image_mac"); XCTAssertEqual(json?["os"] as? String, "macos")
    }

    #if os(macOS)
    /// The Linux spec boots EFI firmware from the sandbox's variable store: no kernel and no command line. `validate()`
    /// needs the virtualization entitlement this test process lacks; probe 23 (tier v) validates and boots it.
    func testLinuxEFISpecTranslatesWithNoCommandLineAndValidates() throws {
        let directory = SandboxDirectory(scratch)
        var record = record(.linux)
        record.machineIdentifier = VZGenericMachineIdentifier().dataRepresentation.base64EncodedString()
        FileManager.default.createFile(atPath: directory.disk.path, contents: nil)
        try FileHandle(forWritingTo: directory.disk).truncate(atOffset: 64 << 20)
        _ = try VZEFIVariableStore(creatingVariableStoreAt: directory.bootStore(for: .linux))
        let configuration = try SandboxConfigurationBuilder.configuration(for: try VMSpec(record: record, in: directory))
        let boot = try XCTUnwrap(configuration.bootLoader as? VZEFIBootLoader)
        XCTAssertEqual(boot.variableStore?.url, directory.bootStore(for: .linux))
        XCTAssertTrue(configuration.platform is VZGenericPlatformConfiguration)
        XCTAssertEqual(configuration.entropyDevices.count, 1); XCTAssertEqual(configuration.serialPorts.count, 1)
        XCTAssertEqual((configuration.networkDevices.first as? VZVirtioNetworkDeviceConfiguration)?.macAddress.string, record.mac)
    }

    func testAMissingBootStoreRefusesToBuild() throws {
        let directory = SandboxDirectory(scratch)
        FileManager.default.createFile(atPath: directory.disk.path, contents: Data())
        var record = record(.linux)
        record.machineIdentifier = VZGenericMachineIdentifier().dataRepresentation.base64EncodedString()
        XCTAssertThrowsError(try SandboxConfigurationBuilder.configuration(for: try VMSpec(record: record, in: directory))) { error in
            XCTAssertTrue(String(describing: error).contains("efi-vars"), "\(error)")
        }
    }
    #endif
}
