#if os(macOS)
import Foundation
import HostDaemonCore
import ImageIO
import Vision

/// Spikes 18 and 19 (and slice 33's agent), on clones of the provisioned cache (slice 17), with tools copied in over SSH.
///   vmlab macos-tcc --agent <darwin agent> --units <dir> --evidence <dir> --json
///                                               the darwin agent's desktop role, granted by TCC rows, through an update
///   vmlab macos-vsock --json                    the vsock forwarder: framed echo, reconnect, host-only peers
extension MacLab {
    static let agentPath = "/usr/local/localbox/localbox-agent"
    static let vsockPath = "/usr/local/localbox/localbox-vsock"

    /// A booted clone of the provisioned cache and an SSH session into it.
    func bootProvisioned() async throws -> (Guest, MacVirtualMachine, GuestSSH, Date) {
        guard FileManager.default.fileExists(atPath: provisioned.appendingPathComponent("disk.img").path) else { throw LabError("blocked: no provisioned macOS base; run npm run proof -- 17 --tier m") }
        let guest = try clone(from: provisioned)
        let user = MacProvisioningUser(name: Self.guestUser, password: try String(contentsOf: guest.directory.appendingPathComponent("password"), encoding: .utf8))
        let started = Date()
        let (vm, ssh) = try await MacProvisioning.bootOverSSH(guest.files, user: user)
        return (guest, vm, ssh, started)
    }

    func hostTool(_ name: String) -> URL { URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent().appendingPathComponent(name) }

    func install(_ local: URL, at remote: String, over ssh: GuestSSH) throws {
        try ssh.copy(local, to: "/tmp/\(local.lastPathComponent)")
        let moved = try ssh.run("mkdir -p \((remote as NSString).deletingLastPathComponent) && mv /tmp/\(local.lastPathComponent) \(remote) && chown root:wheel \(remote) && chmod 755 \(remote) && echo ok", elevated: true)
        guard moved.stdout.contains("ok") else { throw LabError("installing \(remote) failed: \(moved.stderr)") }
    }

    func launchDaemon(_ label: String, _ arguments: [String], over ssh: GuestSSH) throws {
        let args = arguments.map { "<string>\($0)</string>" }.joined()
        let plist = "<?xml version=\"1.0\" encoding=\"UTF-8\"?><plist version=\"1.0\"><dict><key>Label</key><string>\(label)</string><key>ProgramArguments</key><array>\(args)</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/></dict></plist>"
        let path = "/Library/LaunchDaemons/\(label).plist"
        let loaded = try ssh.run("printf '%s' '\(plist)' > \(path) && chown root:wheel \(path) && launchctl bootstrap system \(path) && echo ok", elevated: true)
        guard loaded.stdout.contains("ok") else { throw LabError("loading \(label) failed: \(loaded.stderr)") }
    }

    // MARK: 18 (and slice 33's agent)

    /// The host's guest agent build (`--guest-agent`, `dist/guest-agent`: the darwin binary and `darwin/` with the helper,
    /// forwarder, units and `install.sh`), packed and installed exactly as the macOS base build does. Spike 18's question
    /// still gates: TCC rows grant the desktop role, a binary replaced behind the agent's back loses screen capture
    /// (recorded), and an `agent.update` keeps it because the system role rewrites the rows (P6). The grant is the base
    /// build's own `tcc` step, so whether macOS still asks to confirm the capture (slice 33's window-picker prompt) is read
    /// from every screenshot. Every desktop operation goes over vsock through the system role to the desktop role.
    func tcc(guestAgent: URL, evidence: URL) async throws -> [String: Any] {
        try FileManager.default.createDirectory(at: evidence, withIntermediateDirectories: true)
        let tarball = FileManager.default.temporaryDirectory.appendingPathComponent("localbox-payload-\(UUID().uuidString).tgz")
        try MacBaseBuilder.packPayload(guestAgent: guestAgent, to: tarball)
        defer { try? FileManager.default.removeItem(at: tarball) }
        let agent = guestAgent.appendingPathComponent("localbox-agent-darwin-arm64")

        let (guest, vm, ssh, _) = try await bootProvisioned()
        defer { if ProcessInfo.processInfo.environment["LOCALBOX_VMLAB_KEEP"] == nil { try? FileManager.default.removeItem(at: guest.directory) } }
        try ssh.copy(tarball, to: MacBaseBuilder.remotePayload)
        let installed = try ssh.run("rm -rf /tmp/localbox-stage && mkdir /tmp/localbox-stage && tar -xzf \(MacBaseBuilder.remotePayload) -C /tmp/localbox-stage && sh /tmp/localbox-stage/install.sh /tmp/localbox-stage && echo ok", elevated: true)
        guard installed.stdout.contains("ok") else { throw LabError("install.sh failed: \(installed.stderr)") }
        let uid = try ssh.run("id -u").stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        let vnc = try vm.attachVNC()
        let screen = try await MacProvisioning.connect(vnc)
        defer { screen.close(); vnc.stop() }

        let lane = RequestLane(vm: vm, sandboxID: "sandbox_lab33", name: "lab-agent-33")
        try await lane.open()
        let shell = try await lane.call("shell.exec", ["command": "id -u; uname -s"])
        func ok(_ response: [String: Any]) -> Bool { response["ok"] as? Bool == true }
        func result(_ response: [String: Any]) -> [String: Any] { response["result"] as? [String: Any] ?? [:] }
        func errorText(_ response: [String: Any]) -> String { ((response["error"] as? [String: Any])?["message"] as? String) ?? "" }
        /// The desktop role dials the system role at its own pace (launchd, then a 1 s redial); wait until it answers.
        func desktopUp() async throws -> [String: Any] {
            var last: [String: Any] = [:]
            for _ in 0..<60 { last = try await lane.call("desktop.status", [:]); if ok(last) { return last }; try await Task.sleep(nanoseconds: 1_000_000_000) }
            throw LabError("the desktop role never answered: \(errorText(last))")
        }
        /// Screenshots that showed macOS's window-picker bypass prompt, by when they were taken.
        var promptSeen: [String] = []
        func screenshot(_ name: String?, _ moment: String = "") async throws -> [String: Any] {
            let response = try await lane.call("desktop.screenshot", [:])
            if ok(response), let data = result(response)["data"] as? String, let comma = data.firstIndex(of: ","), let bytes = Data(base64Encoded: String(data[data.index(after: comma)...])) {
                // A full 1440x900 PNG is over the output cap, so the agent usually answers JPEG.
                if let name { try bytes.write(to: evidence.appendingPathComponent(name).appendingPathExtension(data.hasPrefix("data:image/jpeg") ? "jpg" : "png")) }
                if showsPickerPrompt(bytes) { promptSeen.append(name ?? moment) }
            }
            return response
        }
        func summary(_ response: [String: Any]) -> [String: Any] {
            ok(response) ? ["ok": true, "width": result(response)["width"] ?? NSNull(), "height": result(response)["height"] ?? NSNull(), "mime_type": result(response)["mime_type"] ?? NSNull()] : ["ok": false, "error": errorText(response)]
        }

        _ = try await desktopUp()
        let beforeGrant = try await screenshot(nil)
        let granted = try ssh.run(MacBaseBuilder.tccScript(user: Self.guestUser) + "\necho ok", elevated: true)
        guard granted.stdout.contains("ok") else { throw LabError("the build's tcc step failed: \(granted.stdout) \(granted.stderr)") }
        let status = try await desktopUp()
        let shot = try await screenshot("33-desktop")
        // macOS 27 may ask to confirm a capture some seconds after it; watch the screen for half a minute of captures.
        for index in 1...6 { try await Task.sleep(nanoseconds: 5_000_000_000); _ = try await screenshot(index == 6 ? "34-after-grant" : nil, "after grant +\(index * 5) s") }
        // The Apple menu; a fresh grant can take a moment to reach event posting (spike 18), so one retry.
        var clicks = 0, menuOpened = false
        while !menuOpened && clicks < 2 {
            clicks += 1
            _ = try await lane.call("desktop.click", ["x": 18, "y": 10])
            menuOpened = (try? await screen.waitForText(timeout: 12, "the Apple menu open") { $0.contains("About This Mac") }) != nil
        }
        let withMenuOpen = try await screenshot("33-menu-open")
        let escape = try await lane.call("desktop.key", ["key": "Escape"])
        try await Task.sleep(nanoseconds: 1_000_000_000)
        let afterClose = try await screenshot(nil, "after close")
        let typed = try await lane.call("desktop.type", ["text": "localbox"])
        let identity = try ssh.run("scutil --get LocalHostName; scutil --get ComputerName; cat /var/db/localbox/sandbox-id").stdout.split(separator: "\n").map(String.init)
        let chrome = try ssh.run("test -d '/Applications/Google Chrome.app' && echo yes || echo no").stdout.contains("yes")
        let browser: [String: Any] = chrome ? summary(try await lane.call("browser.open", ["url": "https://example.com"])) : ["skipped": "no Chrome in the provisioned base (slice 34 installs it)"]

        // Spike 18's fact: a binary replaced without the rewrite loses screen capture.
        let replacement = try resigned(agent)
        defer { try? FileManager.default.removeItem(at: replacement) }
        try install(replacement, at: Self.agentPath, over: ssh)
        _ = try ssh.run("launchctl kickstart -k system/sh.localbox.agent; launchctl kickstart -k gui/\(uid)/sh.localbox.desktop", elevated: true)
        try await lane.open()
        _ = try await desktopUp()
        let afterReplace = try await screenshot(nil, "after replace")

        // P6: an agent.update over the control lane; the system role rewrites the rows, the desktop role restarts itself.
        let pushed = try resigned(agent)
        defer { try? FileManager.default.removeItem(at: pushed) }
        let size = (try FileManager.default.attributesOfItem(atPath: pushed.path)[.size] as? Int) ?? 0
        let control = try await dial(vm, port: 1025)
        let channel = FramedControlChannel(reader: control, writer: control)
        let outcome = try await channel.updateAgent(AgentBinary(version: "lab", sha256: try sha256(pushed), url: pushed, size: size, chunkBytes: 4 << 20))
        await channel.close()
        try await Task.sleep(nanoseconds: 3_000_000_000)
        try await lane.open()
        _ = try await desktopUp()
        let afterUpdate = try await screenshot("33-after-update")
        await lane.close()
        try await vm.stop()

        let checks: [String: Bool] = [
            "shell_as_root": ok(shell) && result(shell)["stdout"] as? String == "0\nDarwin\n",
            "capture_granted": ok(shot), "click_opened_menu": menuOpened, "capture_with_menu_open": ok(withMenuOpen),
            "key_and_type": ok(escape) && ok(typed), "capture_after_close": ok(afterClose),
            "identity_from_hello": identity.count == 3 && identity[0] == "lab-agent-33" && identity[1] == "lab-agent-33" && identity[2] == "sandbox_lab33",
            "capture_after_update": outcome == .updated && ok(afterUpdate),
        ]
        return ["ok": checks.values.allSatisfy { $0 } && (browser["skipped"] != nil || browser["ok"] as? Bool == true), "checks": checks,
                "survives_replace": ok(afterReplace), "before_grant": summary(beforeGrant), "desktop_status": result(status), "screenshot": summary(shot),
                "with_menu_open": summary(withMenuOpen), "after_replace": summary(afterReplace), "after_update": summary(afterUpdate),
                "clicks": clicks, "browser": browser, "identity": identity, "shell": result(shell), "picker_prompt_seen": promptSeen]
    }

    /// A copy of `binary` with a new ad-hoc signature: different bytes at the same path, as an update brings.
    func resigned(_ binary: URL) throws -> URL {
        let copy = FileManager.default.temporaryDirectory.appendingPathComponent("localbox-agent-\(UUID().uuidString.prefix(8))")
        try FileManager.default.copyItem(at: binary, to: copy)
        try run("/usr/bin/codesign", ["--force", "--sign", "-", "--identifier", "sh.localbox.agent.\(UUID().uuidString.prefix(8))", copy.path])
        return copy
    }

    func run(_ tool: String, _ arguments: [String]) throws {
        let process = Process(); process.executableURL = URL(fileURLWithPath: tool); process.arguments = arguments
        try process.run(); process.waitUntilExit()
        guard process.terminationStatus == 0 else { throw LabError("\(tool) \(arguments.joined(separator: " ")) exited \(process.terminationStatus)") }
    }

    func sha256(_ file: URL) throws -> String {
        let process = Process(); process.executableURL = URL(fileURLWithPath: "/usr/bin/shasum"); process.arguments = ["-a", "256", file.path]
        let out = Pipe(); process.standardOutput = out
        try process.run(); let data = out.fileHandleForReading.readDataToEndOfFile(); process.waitUntilExit()
        return String(decoding: data, as: UTF8.self).split(separator: " ").first.map(String.init) ?? ""
    }

    // MARK: 19

    func vsock() async throws -> [String: Any] {
        let (guest, vm, ssh, booted) = try await bootProvisioned()
        defer { if ProcessInfo.processInfo.environment["LOCALBOX_VMLAB_KEEP"] == nil { try? FileManager.default.removeItem(at: guest.directory) } }
        let sshMs = Int(Date().timeIntervalSince(booted) * 1000)
        try install(hostTool("localbox-vsock"), at: Self.vsockPath, over: ssh)
        try launchDaemon("sh.localbox.echo.agent", [Self.vsockPath, "echo", "/var/run/localbox/agent.sock"], over: ssh)
        try launchDaemon("sh.localbox.echo.control", [Self.vsockPath, "echo", "/var/run/localbox/control.sock"], over: ssh)
        try launchDaemon("sh.localbox.vsock", [Self.vsockPath, "1024=/var/run/localbox/agent.sock", "1025=/var/run/localbox/control.sock"], over: ssh)
        let forwarderPID = { try ssh.run("pgrep -f 'localbox-vsock 1024'").stdout.trimmingCharacters(in: .whitespacesAndNewlines) }
        let pidBefore = try forwarderPID()
        var request = try await dial(vm, port: 1024), control = try await dial(vm, port: 1025)
        // 10,000 frames up to 64 KiB plus sixteen of 8 MiB, each echoed byte for byte; a stream on 1025 meanwhile.
        let started = Date()
        var mismatches = 0, frames = 0, bytes = 0
        let controlTask = Task { () -> Bool in
            for index in 0..<500 { let frame = Data((0..<1024).map { UInt8(truncatingIfNeeded: $0 &+ index) }); if try roundTrip(control, frame) != frame { return false } }
            return true
        }
        for index in 0..<10_016 {
            let size = index < 10_000 ? Int.random(in: 1...65_536) : 8 << 20
            var generator = SystemRandomNumberGenerator()
            let frame = Data((0..<(size + 7) / 8).flatMap { _ in withUnsafeBytes(of: generator.next() as UInt64) { Array($0) } }.prefix(size))
            if try roundTrip(request, frame) != frame { mismatches += 1 }
            frames += 1; bytes += size
        }
        let controlOK = try await controlTask.value
        let throughputMBs = Double(bytes * 2) / Date().timeIntervalSince(started) / 1_048_576
        // The host drops both connections and dials again: the forwarder keeps running.
        try request.close(); try control.close()
        try await Task.sleep(nanoseconds: 1_000_000_000)
        request = try await dial(vm, port: 1024); control = try await dial(vm, port: 1025)
        let probe = Data("after reconnect".utf8)
        let reconnected = try roundTrip(request, probe) == probe && roundTrip(control, probe) == probe
        let pidAfter = try forwarderPID()
        let fromGuest = try ssh.run("\(Self.vsockPath) dial 1024", elevated: true).stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        try await vm.stop()
        let ok = mismatches == 0 && controlOK && reconnected && pidBefore == pidAfter && !pidBefore.isEmpty && fromGuest.hasPrefix("refused")
        return ["ok": ok, "frames": frames, "bytes": bytes, "mismatches": mismatches, "control_stream_ok": controlOK, "echo_mb_per_s": Int(throughputMBs), "reconnected": reconnected, "forwarder_pid_unchanged": pidBefore == pidAfter, "guest_local_dial": fromGuest, "first_boot_to_ssh_ms": sshMs]
    }
}

/// One host-to-guest vsock stream, retried while the guest's listener comes up. The descriptor is duplicated so the
/// handle outlives Virtualization's connection object.
/// Whether a screenshot shows macOS's "… is requesting to bypass the system private window picker" prompt (Vision OCR).
func showsPickerPrompt(_ image: Data) -> Bool {
    guard let source = CGImageSourceCreateWithData(image as CFData, nil), let frame = CGImageSourceCreateImageAtIndex(source, 0, nil) else { return false }
    let request = VNRecognizeTextRequest(); request.recognitionLevel = .accurate; request.usesLanguageCorrection = false
    try? VNImageRequestHandler(cgImage: frame, options: [:]).perform([request])
    let text = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: " ").lowercased()
    return text.contains("window picker") || text.contains("bypass")
}

func dial(_ vm: MacVirtualMachine, port: UInt32) async throws -> FileHandle { try await vm.connect(port: port, within: 30) }

/// The host end of the agent's request lane, reopened after the agent restarts (an update, a kickstart).
final class RequestLane: @unchecked Sendable {
    let vm: MacVirtualMachine, sandboxID: String, name: String
    private var channel: FramedFileHandleGuestChannel?
    init(vm: MacVirtualMachine, sandboxID: String, name: String) { self.vm = vm; self.sandboxID = sandboxID; self.name = name }

    /// Dials until an agent answers with its ready frame (the forwarder accepts before the agent listens).
    func open() async throws {
        await close()
        var last: Error = LabError("never dialled")
        for _ in 0..<60 {
            let stream = try await dial(vm, port: 1024)
            let channel = FramedFileHandleGuestChannel(reader: stream, writer: stream, sandboxID: sandboxID, name: name)
            do { try await channel.waitUntilReady(); self.channel = channel; return } catch { last = error; await channel.close() }
            try await Task.sleep(nanoseconds: 1_000_000_000)
        }
        throw LabError("the agent never answered on vsock 1024: \(last)")
    }

    func call(_ operation: String, _ input: [String: Any]) async throws -> [String: Any] {
        guard let channel else { throw LabError("the request lane is closed") }
        let envelope: [String: Any] = ["protocol_version": "v1", "request_id": UUID().uuidString, "operation": operation, "sandbox_id": sandboxID, "deadline_ms": 60_000, "mutation_id": UUID().uuidString, "input": input]
        let request = try JSONSerialization.data(withJSONObject: envelope)
        // The channel has no deadline of its own, and a blocked read can't be cancelled: race it unstructured, so an
        // answer the agent never sends fails the lab instead of hanging it.
        let response: Data = try await withCheckedThrowingContinuation { continuation in
            let lock = NSLock(); var pending = true
            let finish = { (result: Result<Data, Error>) in if lock.withLock({ defer { pending = false }; return pending }) { continuation.resume(with: result) } }
            Task { do { finish(.success(try await channel.send(request))) } catch { finish(.failure(error)) } }
            Task { try? await Task.sleep(nanoseconds: 90_000_000_000); finish(.failure(LabError("no answer to \(operation) within 90 s"))) }
        }
        return try JSONSerialization.jsonObject(with: response) as? [String: Any] ?? [:]
    }

    func close() async { await channel?.close(); channel = nil }
}

/// Writes one length-prefixed frame and reads the echoed frame back. The write runs on its own thread: an echo
/// answers while the frame is still arriving, so writing all of a large frame before reading would fill both
/// directions' buffers and deadlock.
func roundTrip(_ handle: FileHandle, _ frame: Data) throws -> Data {
    var length = UInt32(frame.count).bigEndian
    let outgoing = Data(bytes: &length, count: 4) + frame
    let writer = Thread { try? handle.write(contentsOf: outgoing) }
    writer.start()
    var received = Data()
    while received.count < frame.count + 4 {
        guard let chunk = try handle.read(upToCount: frame.count + 4 - received.count), !chunk.isEmpty else { throw LabError("the echo closed after \(received.count) bytes") }
        received.append(chunk)
    }
    return received.dropFirst(4)
}

extension GuestSSH {
    func copyBack(_ remote: String, to local: URL) throws {
        let result = try run("base64 -i \(remote)", timeout: 120)
        guard result.status == 0, let data = Data(base64Encoded: result.stdout.replacingOccurrences(of: "\n", with: "")) else { throw LabError("could not read \(remote)") }
        try data.write(to: local)
    }
}
#endif

#if os(macOS)
/// Slice 34's look inside a built macOS base: `vmlab macos-image --image <images>/<id> --evidence <dir> --json` makes a
/// sandbox from it the way the daemon does (`AppleSandboxFactory`, `AppleVirtualizationBackend`, the agent over vsock)
/// and checks what the build promises: SIP disabled, Chrome present, no Xcode, Remote Login off, and no window-picker
/// prompt over the desktop while the desktop role captures it.
extension MacLab {
    func image(_ image: URL, evidence: URL) async throws -> [String: Any] {
        try FileManager.default.createDirectory(at: evidence, withIntermediateDirectories: true)
        let factory = AppleSandboxFactory(images: try ImageStore(imagesDirectory: image.deletingLastPathComponent()))
        let scratch = root.appendingPathComponent("macos-image-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)
        defer { if ProcessInfo.processInfo.environment["LOCALBOX_VMLAB_KEEP"] == nil { try? FileManager.default.removeItem(at: scratch) } }
        let directory = SandboxDirectory(scratch)
        var record = SandboxRecord(sandboxID: "sandbox_lab34", name: "lab-image-34", imageID: image.lastPathComponent, cpus: MacVirtualMachine.cpus, memoryBytes: MacVirtualMachine.memoryBytes, sleepAfterMs: .max)
        _ = try await factory.provision(&record, in: directory)
        try directory.save(record)
        let backend = AppleVirtualizationBackend(spec: try VMSpec(record: record, in: directory), sandboxID: record.sandboxID, name: record.name)
        let booted = Date()
        try await backend.start()
        let agentMs = Int(Date().timeIntervalSince(booted) * 1000)
        func call(_ operation: String, _ input: [String: Any] = [:]) async throws -> [String: Any] {
            let channel = try await backend.makeGuestChannel()
            let envelope: [String: Any] = ["protocol_version": protocolVersion, "request_id": UUID().uuidString, "operation": operation, "sandbox_id": record.sandboxID, "deadline_ms": 90_000, "mutation_id": UUID().uuidString, "input": input]
            return try JSONSerialization.jsonObject(with: try await channel.send(JSONSerialization.data(withJSONObject: envelope))) as? [String: Any] ?? [:]
        }
        func sh(_ command: String) async throws -> String { ((try await call("shell.exec", ["command": command]))["result"] as? [String: Any])?["stdout"] as? String ?? "" }
        var promptSeen: [String] = [], shots = 0
        func screenshot(_ moment: String, save name: String? = nil) async throws -> Bool {
            let response = try await call("desktop.screenshot")
            guard let data = (response["result"] as? [String: Any])?["data"] as? String, let comma = data.firstIndex(of: ","), let bytes = Data(base64Encoded: String(data[data.index(after: comma)...])) else { return false }
            shots += 1
            if let name { try bytes.write(to: evidence.appendingPathComponent(name)) }
            if showsPickerPrompt(bytes) { promptSeen.append(moment) }
            return true
        }

        let sip = try await sh("csrutil status").trimmingCharacters(in: .whitespacesAndNewlines)
        let chrome = try await sh("/usr/bin/defaults read '/Applications/Google Chrome.app/Contents/Info' CFBundleShortVersionString 2>/dev/null").trimmingCharacters(in: .whitespacesAndNewlines)
        let xcode = try await sh("ls -d /Applications/Xcode*.app /Library/Developer/CommandLineTools 2>/dev/null; true").trimmingCharacters(in: .whitespacesAndNewlines)
        let sshd = try await sh("launchctl print-disabled system | grep com.openssh.sshd; true").trimmingCharacters(in: .whitespacesAndNewlines)
        let managed = try await sh("cat '/Library/Managed Preferences/com.apple.applicationaccess.plist' 2>/dev/null | grep -c forceBypassScreenCaptureAlert; true").trimmingCharacters(in: .whitespacesAndNewlines)
        let address = try await MacProvisioning.waitForAddress(record.mac ?? "", timeout: 60)
        let port22 = Process(); port22.executableURL = URL(fileURLWithPath: "/usr/bin/nc"); port22.arguments = ["-z", "-G", "3", address, "22"]
        try port22.run(); port22.waitUntilExit()

        // The desktop role captures right away, again after Chrome opens a page, and for half a minute after.
        var desktopUp = false
        for _ in 0..<60 where !desktopUp { desktopUp = (try await call("desktop.status"))["ok"] as? Bool == true; if !desktopUp { try await Task.sleep(nanoseconds: 1_000_000_000) } }
        let first = try await screenshot("first capture", save: "34-desktop.jpg")
        let browser = try await call("browser.open", ["url": "https://example.com"])
        try await Task.sleep(nanoseconds: 3_000_000_000)
        _ = try await screenshot("after browser.open", save: "34-browser.jpg")
        for index in 1...6 { try await Task.sleep(nanoseconds: 5_000_000_000); _ = try await screenshot("+\(index * 5) s") }
        try await backend.stop()

        let checks: [String: Bool] = [
            "sip_disabled": sip.contains("disabled"), "chrome_installed": !chrome.isEmpty, "no_xcode": xcode.isEmpty,
            "remote_login_off": sshd.contains("disabled") || sshd.contains("true"), "port_22_refused": port22.terminationStatus != 0,
            "desktop_captures": desktopUp && first, "browser_opens": browser["ok"] as? Bool == true, "no_picker_prompt": promptSeen.isEmpty,
        ]
        return ["ok": checks.values.allSatisfy { $0 }, "checks": checks, "csrutil_status": sip, "chrome_version": chrome, "xcode": xcode, "sshd": sshd, "capture_restriction_installed": managed == "1",
                "agent_ready_ms": agentMs, "screenshots": shots, "picker_prompt_seen": promptSeen, "browser": (browser["result"] ?? browser["error"]) ?? NSNull()]
    }

    /// The release Apple serves this Mac now, as a build would choose it.
    func latestIPSW() async throws -> [String: Any] {
        let release = try await AppleIPSWCatalog().latest()
        return ["ok": true, "url": release.url.absoluteString, "file_name": release.fileName, "version": release.version, "build": release.build, "size_bytes": release.sizeBytes]
    }
}
#endif
