#if os(macOS)
import Foundation
import HostDaemonCore
import Virtualization

/// macOS-guest experiments (proof tier `m`). The installed base is cached under the lab directory so every later macOS
/// probe starts from it instead of reinstalling:
///   vmlab macos-install --ipsw <path> --json   install the IPSW into `<lab>/macos-base`
///   vmlab macos-clones --json                  two clones with new identifiers run at once; a third is refused
///   vmlab macos-hibernate --json               save a clone in this process, restore it in a new one
struct MacLab {
    let root: URL
    var base: URL { root.appendingPathComponent("macos-base", isDirectory: true) }

    static func fromEnvironment() -> MacLab {
        let path = ProcessInfo.processInfo.environment["LOCALBOX_VMLAB_DIR"] ?? (NSHomeDirectory() as NSString).appendingPathComponent(".cache/localbox-vmlab")
        return MacLab(root: URL(fileURLWithPath: path, isDirectory: true))
    }

    /// One macOS guest's files: a disk, auxiliary storage, the hardware model it was installed for, its identity.
    struct Guest {
        let directory: URL
        var disk: URL { directory.appendingPathComponent("disk.img") }
        var aux: URL { directory.appendingPathComponent("aux.img") }
        var hardwareModelFile: URL { directory.appendingPathComponent("hardware-model") }
        var identifierFile: URL { directory.appendingPathComponent("machine-identifier") }
        var macFile: URL { directory.appendingPathComponent("mac") }
        var savedState: URL { directory.appendingPathComponent("state.vzsave") }
        var files: MacGuestFiles { MacGuestFiles(disk: disk, auxiliaryStorage: aux, hardwareModel: hardwareModelFile, machineIdentifier: identifierFile, mac: macFile) }
        func mac() throws -> String { try files.macAddress() }
        func identifier() throws -> Data { try Data(contentsOf: identifierFile) }
        func vm() throws -> VirtualMachine { try files.vm() }
    }

    /// A normal boot of `guest` reached over SSH: the lab's provisioned guests keep Remote Login on, and their password.
    func bootOverSSH(_ guest: Guest, timeout: TimeInterval = 600) async throws -> (VirtualMachine, GuestSSH) {
        let user = MacProvisioningUser(name: Self.guestUser, password: try String(contentsOf: guest.directory.appendingPathComponent("password"), encoding: .utf8))
        return try await MacProvisioning.boot(guest.files, .normal, user: user, timeout: timeout)
    }

    // MARK: install

    func install(ipsw: URL) async throws -> [String: Any] {
        let staging = root.appendingPathComponent(".macos-base-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: staging, withIntermediateDirectories: true)
        let guest = Guest(directory: staging)
        let started = Date()
        let version = try await MacProvisioning.install(ipsw: ipsw, into: guest.files, diskBytes: Self.diskBytes) { FileHandle.standardError.write(Data("install \(Int($0 * 100))%\n".utf8)) }
        let installMs = Int(Date().timeIntervalSince(started) * 1000)
        try version.write(to: staging.appendingPathComponent("macos-version"), atomically: true, encoding: .utf8)
        if FileManager.default.fileExists(atPath: base.path) { try FileManager.default.removeItem(at: base) }
        try FileManager.default.moveItem(at: staging, to: base)
        return ["ok": true, "macos_version": version, "install_ms": installMs, "cpus": VirtualMachine.macCPUs, "memory_bytes": VirtualMachine.macMemoryBytes, "disk_allocated_bytes": privateBytes(Guest(directory: base).disk) ?? -1, "ipsw_bytes": (try? FileManager.default.attributesOfItem(atPath: ipsw.path)[.size] as? Int) ?? -1]
    }

    static let diskBytes: UInt64 = 64 << 30

    // MARK: clones

    /// A new clone of the base: APFS clone of the disk, copied auxiliary storage, a new identifier and MAC.
    func clone(from source: URL? = nil) throws -> Guest {
        let from = Guest(directory: source ?? base)
        guard FileManager.default.fileExists(atPath: from.disk.path) else { throw LabError("blocked: no cached macOS base; run npm run proof -- 16 --tier m") }
        let directory = root.appendingPathComponent("macos-clone-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let guest = Guest(directory: directory)
        _ = try cloneDisk(from.disk, to: guest.disk)
        try FileManager.default.copyItem(at: from.aux, to: guest.aux)
        try FileManager.default.copyItem(at: from.hardwareModelFile, to: guest.hardwareModelFile)
        let password = from.directory.appendingPathComponent("password")
        if FileManager.default.fileExists(atPath: password.path) { try FileManager.default.copyItem(at: password, to: guest.directory.appendingPathComponent("password")) }
        try guest.files.writeNewIdentity()
        return guest
    }

    func clones() async throws -> [String: Any] {
        let guests = try (0..<3).map { _ in try clone() }
        defer { if ProcessInfo.processInfo.environment["LOCALBOX_VMLAB_KEEP"] == nil { for guest in guests { try? FileManager.default.removeItem(at: guest.directory) } } }
        let vms = try guests.map { try $0.vm() }
        let started = Date()
        try await vms[0].start(); try await vms[1].start()
        var leases: [String: Int] = [:]
        for (index, guest) in guests.prefix(2).enumerated() { leases["clone_\(index)"] = try await waitForLease(try guest.mac(), since: started) }
        var third = "started"
        do { try await vms[2].start(); try await vms[2].stop() } catch { third = describe(error) }
        let identifiers = try guests.prefix(2).map { try $0.identifier().base64EncodedString() }
        let running = vms.prefix(2).map { $0.isRunning }
        for vm in vms.prefix(2) { try await vm.stop() }
        let limited = third.contains("VZErrorDomain") && third.contains("code \(VZError.Code.virtualMachineLimitExceeded.rawValue)")
        return ["ok": running.allSatisfy { $0 } && identifiers[0] != identifiers[1] && limited, "lease_ms": leases, "both_running": running, "distinct_identifiers": identifiers[0] != identifiers[1], "third_vm": third, "third_refused_by_limit": limited, "clone_private_bytes": privateBytes(guests[0].disk) ?? -1]
    }

    // MARK: hibernate

    func hibernate() async throws -> [String: Any] {
        let guest = try clone()
        let vm = try guest.vm()
        let started = Date()
        try await vm.start()
        let leaseMs = try await waitForLease(try guest.mac(), since: started)
        try await Task.sleep(nanoseconds: 15_000_000_000)
        let saveStarted = Date()
        try await vm.pause(); try await vm.saveState(to: guest.savedState); try await vm.stop()
        let saveMs = Int(Date().timeIntervalSince(saveStarted) * 1000)
        let stateBytes = (try? FileManager.default.attributesOfItem(atPath: guest.savedState.path)[.size] as? Int) ?? -1
        let phase2 = try runSelfJSON(["macos-restore", "--scratch", guest.directory.path, "--json"])
        if ProcessInfo.processInfo.environment["LOCALBOX_VMLAB_KEEP"] == nil { try? FileManager.default.removeItem(at: guest.directory) }
        return ["ok": phase2["running_after"] as? Bool == true, "lease_ms": leaseMs, "save_ms": saveMs, "state_file_bytes": stateBytes, "phase2": phase2]
    }

    func restorePhase(scratch: URL) async throws -> [String: Any] {
        let guest = Guest(directory: scratch)
        let vm = try guest.vm()
        let started = Date()
        try await vm.restoreState(from: guest.savedState); try await vm.resume()
        let restoreMs = Int(Date().timeIntervalSince(started) * 1000)
        try await Task.sleep(nanoseconds: 15_000_000_000)
        let running = vm.isRunning
        try await vm.stop()
        return ["restore_ms": restoreMs, "running_after": running]
    }

    // MARK: helpers

    /// Milliseconds from `since` until the NAT leased `mac` an address.
    func waitForLease(_ mac: String, since: Date, timeout: TimeInterval = 600) async throws -> Int {
        _ = try await MacProvisioning.waitForAddress(mac, timeout: timeout)
        return Int(Date().timeIntervalSince(since) * 1000)
    }

    func runSelfJSON(_ arguments: [String]) throws -> [String: Any] {
        let process = Process(); process.executableURL = URL(fileURLWithPath: CommandLine.arguments[0]); process.arguments = arguments
        let stdout = Pipe(); process.standardOutput = stdout
        try process.run(); let data = stdout.fileHandleForReading.readDataToEndOfFile(); process.waitUntilExit()
        let line = String(decoding: data, as: UTF8.self).split(separator: "\n").last.map(String.init) ?? "{}"
        return (try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any]) ?? ["error": line]
    }
}

func describe(_ error: Error) -> String { let ns = error as NSError; return "\(ns.domain) code \(ns.code): \(ns.localizedDescription)" }

#endif
