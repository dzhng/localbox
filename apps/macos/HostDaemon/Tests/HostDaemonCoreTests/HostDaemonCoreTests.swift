import XCTest
@testable import HostDaemonCore

final class HostDaemonCoreTests: XCTestCase {
    private let gib: UInt64 = 1024 * 1024 * 1024

    func testEveryRequestNamesASandboxOnThisMac() async throws {
        let host = SandboxHost(sandboxesDirectory: try scratch(), factory: FakeBackendFactory(), hostCPUs: 12, hostMemoryBytes: 24 * gib)
        let unknown = try await call(host, envelope("fs.stat", #"{"path":"/"}"#))
        XCTAssertEqual((unknown["error"] as? [String: Any])?["code"] as? String, "sandbox_not_found")
        let missing = try await call(host, Data(#"{"protocol_version":"v1","request_id":"r","operation":"sandbox.status","sandbox_id":null,"deadline_ms":1000,"mutation_id":null,"input":{}}"#.utf8))
        XCTAssertEqual((missing["error"] as? [String: Any])?["code"] as? String, "invalid_input")
        let malformed = try await call(host, Data("ping".utf8))
        XCTAssertEqual((malformed["error"] as? [String: Any])?["code"] as? String, "invalid_input")
    }

    /// Agent setup is the CLI's: the daemon runs `agents op` and answers with its result or error, never a sandbox's.
    func testAgentSetupRunsTheInstalledCLI() async throws {
        let directory = try scratch()
        let cli = directory.appendingPathComponent("localbox")
        try """
        #!/bin/sh
        printf '%s\n' "$*" > "\(directory.path)/args"
        case "$3" in
          skill.status) echo '{"ok":true,"result":{"state":"installed","source_revision":"0.2.0"}}' ;;
          agents.setup.set) echo '{"ok":false,"error":{"code":"invalid_input","message":"input.enabled is required"}}'; exit 1 ;;
          cli.status) sleep 5 ;;
          *) echo 'not json' ;;
        esac
        """.write(to: cli, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: cli.path)
        let host = SandboxHost(sandboxesDirectory: try scratch(), factory: FakeBackendFactory(), agentSetup: AgentSetupCLI(executable: cli, timeout: 1))
        let status = try await call(host, envelope("skill.status", "{}", sandboxID: nil))
        XCTAssertEqual((status["result"] as? [String: Any])?["source_revision"] as? String, "0.2.0")
        XCTAssertEqual(try String(contentsOf: directory.appendingPathComponent("args"), encoding: .utf8), "agents op skill.status --input-json {} --json\n")
        let refused = try await call(host, envelope("agents.setup.set", "{}", sandboxID: nil))
        XCTAssertEqual((refused["error"] as? [String: Any])?["code"] as? String, "invalid_input")
        let slow = try await call(host, envelope("cli.status", "{}", sandboxID: nil))
        XCTAssertEqual((slow["error"] as? [String: Any])?["code"] as? String, "operation_timeout")
        let garbled = try await call(host, envelope("skill.uninstall", "{}", sandboxID: nil))
        XCTAssertEqual((garbled["error"] as? [String: Any])?["code"] as? String, "internal")
        let without = try await call(SandboxHost(sandboxesDirectory: try scratch(), factory: FakeBackendFactory()), envelope("skill.status", "{}", sandboxID: nil))
        XCTAssertEqual((without["error"] as? [String: Any])?["code"] as? String, "unsupported")
    }

    func testSandboxHostLifecycle() async throws {
        let root = try scratch()
        let host = SandboxHost(sandboxesDirectory: root, factory: FakeBackendFactory(), hostCPUs: 12, hostMemoryBytes: 24 * gib)
        let unsized = try await call(host, envelope("sandbox.create", #"{"name":"quiet-otter"}"#, sandboxID: "sandbox_1"))
        XCTAssertEqual((unsized["error"] as? [String: Any])?["code"] as? String, "invalid_input", "the agent API sizes every sandbox it relays")
        let first = try await hostCall(host, "sandbox.create", #"{"name":"quiet-otter","cpus":6,"memory_bytes":6442450944,"sleep_after_ms":1800000}"#, sandboxID: "sandbox_1")
        XCTAssertEqual((first["produced"] as? [String: Any])?["cpus"] as? Int, 6)
        XCTAssertEqual((first["produced"] as? [String: Any])?["memory_bytes"] as? Int, 6 * 1024 * 1024 * 1024)
        XCTAssertEqual(kinds(first), ["created", "cold_booted"])
        let second = try await hostCall(host, "sandbox.create", #"{"name":"brave-fox","cpus":2,"memory_bytes":2147483648,"sleep_after_ms":1800000}"#, sandboxID: "sandbox_2")
        XCTAssertEqual(kinds(second), ["created", "cold_booted"], "each sandbox has its own runtime")
        let record = try SandboxDirectory(root.appendingPathComponent("sandbox_2")).load()
        XCTAssertEqual(record.cpus, 2); XCTAssertEqual(record.lifecycle, .running); XCTAssertNotNil(record.mac)

        // Routing: stopping one leaves the other answering.
        _ = try await hostCall(host, "sandbox.stop", "{}", sandboxID: "sandbox_1")
        let request = envelope("shell.exec", #"{"command":"true"}"#, mutation: "e1", sandboxID: "sandbox_2")
        let echoed = try await host.request(request); XCTAssertEqual(echoed, request)
        do { _ = try await host.request(envelope("shell.exec", #"{"command":"true"}"#, mutation: "e2")); XCTFail("a stopped sandbox refuses guest work") } catch {}
        let watched = try await hostCall(host, "host.watch", #"{"since":0}"#)
        XCTAssertEqual((watched["sandboxes"] as? [[String: Any]])?.map { $0["state"] as? String }, ["stopped", "running"])
        XCTAssertEqual((watched["capacity"] as? [String: Any])?["reserved_bytes"] as? Int, 2 * 1024 * 1024 * 1024, "only running sandboxes reserve memory")

        let renamed = try await hostCall(host, "sandbox.rename", #"{"name":"calm-heron"}"#, sandboxID: "sandbox_1")
        XCTAssertEqual((renamed["produced"] as? [String: Any])?["previous_name"] as? String, "quiet-otter")
        let deleted = try await hostCall(host, "sandbox.delete", "{}", sandboxID: "sandbox_2")
        XCTAssertEqual((deleted["produced"] as? [String: Any])?["removed"] as? [String], ["sandbox identity"])
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("sandbox_2").path), "delete removes the directory")

        let reloaded = SandboxHost(sandboxesDirectory: root, factory: FakeBackendFactory())
        let records = await reloaded.sandboxes()
        XCTAssertEqual(records.map(\.name), ["calm-heron"]); XCTAssertEqual(records.first?.lifecycle, .stopped)
        let listed = try await hostCall(reloaded, "sandbox.list", "{}", sandboxID: nil)
        XCTAssertEqual((listed["sandboxes"] as? [[String: Any]])?.first?["name"] as? String, "calm-heron")
    }

    func testTheMirrorFollowsNamesAndHidesASandboxItNeverListed() async throws {
        let root = try scratch()
        let host = SandboxHost(sandboxesDirectory: root, factory: FakeBackendFactory(), hostCPUs: 4, hostMemoryBytes: 8 * gib)
        _ = try await hostCall(host, "sandbox.create", #"{"name":"one","cpus":3,"memory_bytes":3221225472,"sleep_after_ms":1800000}"#, sandboxID: "sandbox_1")
        _ = try await hostCall(host, "sandbox.create", #"{"name":"two","cpus":2,"memory_bytes":2147483648,"sleep_after_ms":1800000}"#, sandboxID: "sandbox_2")
        let version = try await hostCall(host, "host.watch", #"{"since":0}"#)["version"] as! Int
        let pushed = try await hostCall(host, "sandbox.mirror", #"{"source":"catalog","machine_id":"machine_1","sandboxes":[{"sandbox_id":"sandbox_1","name":"renamed","cpus":2,"memory_bytes":2147483648,"sleep_after_ms":1800000},{"sandbox_id":"sandbox_9","name":"elsewhere","sleep_after_ms":1800000}]}"#)
        XCTAssertEqual(pushed["unknown"] as? [String], ["sandbox_2"]); XCTAssertEqual(pushed["missing"] as? [String], ["sandbox_9"])
        let records = await host.sandboxes()
        XCTAssertEqual(records.map(\.name), ["renamed"]); XCTAssertEqual(records.first?.cpus, 3, "the daemon keeps the size it runs a sandbox at")
        XCTAssertTrue(FileManager.default.fileExists(atPath: root.appendingPathComponent("sandbox_2/sandbox.json").path), "a push older than a sandbox's reservation does not delete it")
        XCTAssertEqual((pushed["deleted"] as? [Any])?.count, 0)
        let hidden = try await call(host, envelope("shell.exec", #"{"command":"true"}"#, mutation: "h", sandboxID: "sandbox_2"))
        XCTAssertEqual((hidden["error"] as? [String: Any])?["code"] as? String, "sandbox_not_found", "a sandbox the catalog no longer lists does not answer")
        let watched = try await hostCall(host, "host.watch", #"{"since":\#(version),"timeout_ms":50}"#)
        XCTAssertGreaterThan(watched["version"] as? Int ?? 0, version, "a mirror push bumps the watch version")
        XCTAssertEqual((watched["sandboxes"] as? [[String: Any]])?.compactMap { $0["sandbox_id"] as? String }, ["sandbox_1"])
    }

    /// A sandbox deleted from the catalog while this Mac was offline goes when the next catalog push leaves it out; a
    /// sign-out hides sandboxes and keeps their disks, and a later catalog push does not delete those either.
    func testACatalogPushDeletesWhatTheCatalogDroppedButASignOutKeepsDisks() async throws {
        let root = try scratch()
        let host = SandboxHost(sandboxesDirectory: root, factory: FakeBackendFactory(), hostCPUs: 12, hostMemoryBytes: 24 * gib)
        for (id, name) in [("sandbox_1", "one"), ("sandbox_2", "two")] { _ = try await hostCall(host, "sandbox.create", #"{"name":"\#(name)","cpus":2,"memory_bytes":2147483648,"sleep_after_ms":1800000}"#, sandboxID: id) }
        _ = try await hostCall(host, "sandbox.mirror", #"{"source":"catalog","machine_id":"machine_1","sandboxes":[{"sandbox_id":"sandbox_1","name":"one","sleep_after_ms":1800000},{"sandbox_id":"sandbox_2","name":"two","sleep_after_ms":1800000}]}"#)
        let dropped = try await hostCall(host, "sandbox.mirror", #"{"source":"catalog","machine_id":"machine_1","sandboxes":[{"sandbox_id":"sandbox_1","name":"one","sleep_after_ms":1800000}]}"#)
        XCTAssertEqual(dropped["deleted"] as? [[String: String]], [["sandbox_id": "sandbox_2", "name": "two", "detail": "deleted two: the account catalog no longer lists it"]])
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("sandbox_2").path), "its directory and disk are gone")
        let watched = try await hostCall(host, "host.watch", #"{"since":0}"#)
        XCTAssertEqual((watched["sandboxes"] as? [[String: Any]])?.compactMap { $0["sandbox_id"] as? String }, ["sandbox_1"])

        let otherMachine = try await hostCall(host, "sandbox.mirror", #"{"source":"catalog","machine_id":"machine_9","sandboxes":[]}"#)
        XCTAssertEqual((otherMachine["deleted"] as? [Any])?.count, 0, "only the machine whose catalog listed a sandbox deletes it by leaving it out")
        _ = try await hostCall(host, "sandbox.mirror", #"{"source":"catalog","machine_id":"machine_1","sandboxes":[{"sandbox_id":"sandbox_1","name":"one","sleep_after_ms":1800000}]}"#)
        let signedOut = try await hostCall(host, "sandbox.mirror", #"{"source":"signed_out","sandboxes":[]}"#)
        XCTAssertEqual((signedOut["deleted"] as? [Any])?.count, 0); XCTAssertEqual(signedOut["unknown"] as? [String], ["sandbox_1"])
        let afterSignIn = try await hostCall(host, "sandbox.mirror", #"{"source":"catalog","machine_id":"machine_2","sandboxes":[]}"#)
        XCTAssertEqual((afterSignIn["deleted"] as? [Any])?.count, 0, "a sandbox hidden by a sign-out is never deleted by the next sign-in's catalog")
        XCTAssertTrue(FileManager.default.fileExists(atPath: root.appendingPathComponent("sandbox_1/sandbox.json").path))

        for input in [#"{"sandboxes":[]}"#, #"{"source":"catalog","sandboxes":[]}"#] {
            let unnamed = try await call(host, envelope("sandbox.mirror", input, sandboxID: nil))
            XCTAssertEqual((unnamed["error"] as? [String: Any])?["code"] as? String, "invalid_input", "a push says whether it is a sign-out or which machine's catalog it is")
        }
        let partial = try await call(host, envelope("sandbox.mirror", #"{"source":"catalog","machine_id":"machine_1","sandboxes":[{"sandbox_id":"sandbox_1","name":"one"}]}"#, sandboxID: nil))
        XCTAssertEqual((partial["error"] as? [String: Any])?["code"] as? String, "invalid_input", "a row without its idle policy refuses the whole push, so it never reads as unlisted")
    }

    func testResizeReportsRestart() async throws {
        let ps = #"{"ok":true,"result":{"stdout":"40\n1 0 /sbin/init\n2 0 [kthreadd]\n80 1 /usr/bin/node /opt/localbox/dist/apps/guest-agent/src/index.js\n90 1 /usr/bin/socat VSOCK-LISTEN:1024,reuseaddr,fork UNIX-CONNECT:/run/localbox/agent.sock\n120 1 node server.js\n121 120 /usr/bin/python3 -m http.server\n41 40 ps -eo pid=,ppid=,args=\n"}}"#
        let factory = FakeBackendFactory { request in
            let operation = (try JSONSerialization.jsonObject(with: request) as? [String: Any])?["operation"] as? String
            return operation == "shell.exec" ? Data(ps.utf8) : request
        }
        let root = try scratch()
        let host = SandboxHost(sandboxesDirectory: root, factory: factory, hostCPUs: 12, hostMemoryBytes: 24 * gib)
        _ = try await hostCall(host, "sandbox.create", #"{"name":"one","cpus":2,"memory_bytes":2147483648,"sleep_after_ms":1800000}"#, sandboxID: "sandbox_1")
        let resized = try await hostCall(host, "sandbox.resize", #"{"cpus":3}"#, sandboxID: "sandbox_1")
        let action = (resized["actions"] as? [[String: Any]])?.first
        XCTAssertEqual(action?["kind"] as? String, "restarted")
        XCTAssertEqual(action?["detail"] as? String, "restarted one at 3 CPUs and 2 GiB; 3 processes ended: init, node, python3")
        XCTAssertEqual((resized["produced"] as? [String: Any])?["cpus"] as? Int, 3); XCTAssertEqual((resized["produced"] as? [String: Any])?["state"] as? String, "running")
        XCTAssertEqual(factory.boots, 2, "the new size needs a new boot")
        _ = try await hostCall(host, "sandbox.stop", "{}", sandboxID: "sandbox_1")
        let stopped = try await hostCall(host, "sandbox.resize", #"{"memory_bytes":4294967296}"#, sandboxID: "sandbox_1")
        XCTAssertEqual((stopped["actions"] as? [[String: Any]])?.count, 0, "a stopped sandbox only records the size")
        XCTAssertEqual(try SandboxDirectory(root.appendingPathComponent("sandbox_1")).load().memoryBytes, 4 * gib)
    }

    func testSigtermHibernates() async throws {
        let root = try scratch()
        let host = SandboxHost(sandboxesDirectory: root, factory: FakeBackendFactory(), hostCPUs: 4, hostMemoryBytes: 8 * gib)
        _ = try await hostCall(host, "sandbox.create", #"{"name":"one","cpus":2,"memory_bytes":2147483648,"sleep_after_ms":1800000}"#, sandboxID: "sandbox_1")
        _ = try await hostCall(host, "sandbox.create", #"{"name":"two","cpus":2,"memory_bytes":2147483648,"sleep_after_ms":1800000}"#, sandboxID: "sandbox_2")
        _ = try await hostCall(host, "sandbox.stop", "{}", sandboxID: "sandbox_2")
        await host.shutdown()
        let saved = try SandboxDirectory(root.appendingPathComponent("sandbox_1")).load()
        XCTAssertEqual(saved.lifecycle, .hibernated); XCTAssertNil(saved.coldBootPending)
        XCTAssertTrue(FileManager.default.fileExists(atPath: root.appendingPathComponent("sandbox_1/state.vzsave").path))

        let restarted = SandboxHost(sandboxesDirectory: root, factory: FakeBackendFactory())
        let actions = await restarted.recover()
        XCTAssertEqual(actions["sandbox_1"]?["kind"], "woke"); XCTAssertNil(actions["sandbox_2"], "a sandbox stopped on purpose stays down")
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("sandbox_1/state.vzsave").path), "a restored state is spent")
        let status = try await hostCall(restarted, "sandbox.status", "{}", sandboxID: "sandbox_1")
        XCTAssertEqual(status["state"] as? String, "running"); XCTAssertEqual((status["last_boot"] as? [String: Any])?["kind"] as? String, "woke")
    }

    func testSigtermColdBootsWhenSaveFails() async throws {
        let root = try scratch()
        let host = SandboxHost(sandboxesDirectory: root, factory: FakeBackendFactory(saveError: .unsupported("permission denied")), hostCPUs: 4, hostMemoryBytes: 8 * gib)
        _ = try await hostCall(host, "sandbox.create", #"{"name":"one","cpus":2,"memory_bytes":2147483648,"sleep_after_ms":1800000}"#, sandboxID: "sandbox_1")
        await host.shutdown()
        let record = try SandboxDirectory(root.appendingPathComponent("sandbox_1")).load()
        XCTAssertEqual(record.lifecycle, .stopped)
        XCTAssertEqual(record.coldBootPending, "could not save its state: permission denied")
        let actions = await SandboxHost(sandboxesDirectory: root, factory: FakeBackendFactory()).recover()
        XCTAssertEqual(actions["sandbox_1"], ["kind": "cold_booted", "detail": "cold-booted one: could not save its state: permission denied"])
        XCTAssertNil(try SandboxDirectory(root.appendingPathComponent("sandbox_1")).load().coldBootPending, "the debt is paid")
    }

    func testAdmitSleepsLeastRecentlyUsed() async throws {
        let clock = TestClock()
        let host = SandboxHost(sandboxesDirectory: try scratch(), factory: FakeBackendFactory(guest: JobsGuest().answer), hostCPUs: 4, hostMemoryBytes: 8 * gib, now: { clock.now })
        // 75% of 8 GiB is 6 GiB: three 2 GiB sandboxes fill it. Each boot counts as activity; then a is used.
        for name in ["a", "b", "c"] {
            clock.now += 60
            _ = try await hostCall(host, "sandbox.create", #"{"name":"\#(name)","cpus":2,"memory_bytes":2147483648,"sleep_after_ms":1800000}"#, sandboxID: "sandbox_\(name)")
        }
        clock.now += 60
        _ = try await call(host, envelope("fs.stat", #"{"path":"/"}"#, sandboxID: "sandbox_a"))
        let full = try await capacity(host)
        XCTAssertEqual(full["room_bytes"] as? Int, 0); XCTAssertEqual(full["running"] as? Int, 3)

        clock.now += 60
        let fourth = try await hostCall(host, "sandbox.create", #"{"name":"d","cpus":2,"memory_bytes":2147483648,"sleep_after_ms":1800000}"#, sandboxID: "sandbox_d")
        XCTAssertEqual(kinds(fourth), ["created", "made_room", "cold_booted"])
        XCTAssertEqual((fourth["actions"] as? [[String: Any]])?[1]["detail"] as? String, "slept b (2 GiB) to make room", "b is the least recently used")
        let states = try await hostCall(host, "sandbox.list", "{}")["sandboxes"] as? [[String: Any]]
        XCTAssertEqual(states?.map { "\($0["name"]!)=\($0["state"]!)" }, ["a=running", "b=sleeping", "c=running", "d=running"])
        let after = try await capacity(host)
        XCTAssertEqual(after["reserved_bytes"] as? Int, 6 * 1024 * 1024 * 1024); XCTAssertEqual(after["revision"] as? Int, full["revision"] as? Int, "the same reservation keeps its revision")

        // A rename is no lifecycle event, so the revision holds; waking b sleeps the next least recently used (c).
        _ = try await hostCall(host, "sandbox.rename", #"{"name":"a2"}"#, sandboxID: "sandbox_a")
        let renamed = try await capacity(host)
        XCTAssertEqual(renamed["revision"] as? Int, after["revision"] as? Int)
        clock.now += 60
        let woke = try await hostCall(host, "sandbox.start", "{}", sandboxID: "sandbox_b")
        XCTAssertEqual(kinds(woke), ["made_room", "woke"], "b restores from the state its sleep saved")
        XCTAssertEqual((woke["actions"] as? [[String: Any]])?.first?["detail"] as? String, "slept c (2 GiB) to make room")
        _ = try await hostCall(host, "sandbox.stop", "{}", sandboxID: "sandbox_d")
        let freed = try await capacity(host)
        XCTAssertEqual(freed["room_bytes"] as? Int, 2 * 1024 * 1024 * 1024); XCTAssertGreaterThan(freed["revision"] as! Int, after["revision"] as! Int)
    }

    func testRunningJobIsNeverSleptForRoom() async throws {
        let clock = TestClock(); let guest = JobsGuest()
        let root = try scratch()
        let host = SandboxHost(sandboxesDirectory: root, factory: FakeBackendFactory(guest: guest.answer), hostCPUs: 4, hostMemoryBytes: 8 * gib, now: { clock.now })
        for name in ["a", "b", "c"] {
            clock.now += 60
            _ = try await hostCall(host, "sandbox.create", #"{"name":"\#(name)","cpus":2,"memory_bytes":2147483648,"sleep_after_ms":1800000}"#, sandboxID: "sandbox_\(name)")
        }
        guest.set("sandbox_a", jobs: 1)
        let fourth = try await hostCall(host, "sandbox.create", #"{"name":"d","cpus":2,"memory_bytes":2147483648,"sleep_after_ms":1800000}"#, sandboxID: "sandbox_d")
        XCTAssertEqual((fourth["actions"] as? [[String: Any]])?.filter { $0["kind"] as? String == "made_room" }.map { $0["detail"] as? String }, ["slept b (2 GiB) to make room"], "a is older but runs a job")

        for id in ["sandbox_a", "sandbox_c", "sandbox_d"] { guest.set(id, jobs: 1) }
        let refused = try await call(host, envelope("sandbox.create", #"{"name":"e","cpus":2,"memory_bytes":2147483648,"sleep_after_ms":1800000}"#, sandboxID: "sandbox_e"))
        let error = refused["error"] as? [String: Any]
        XCTAssertEqual(error?["code"] as? String, "machine_full")
        XCTAssertEqual(error?["message"] as? String, "e needs 2 GiB, but sandboxes reserve 6 GiB of this machine's 6 GiB and not enough of them can sleep: a (2 GiB, 1 running job), c (2 GiB, 1 running job), d (2 GiB, 1 running job)")
        let held = (error?["details"] as? [String: Any])?["sandboxes"] as? [[String: Any]]
        XCTAssertEqual(held?.map { $0["name"] as? String }, ["a", "c", "d"]); XCTAssertEqual(held?.map { $0["running_jobs"] as? Int }, [1, 1, 1])
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("sandbox_e").path), "a refused create leaves nothing behind")
        let states = try await hostCall(host, "sandbox.list", "{}")["sandboxes"] as? [[String: Any]]
        XCTAssertEqual(states?.map { $0["state"] as? String }, ["running", "sleeping", "running", "running"], "nothing sleeps when the start cannot fit")
    }

    func testIdleSleepsAfterTimeout() async throws {
        let clock = TestClock(); let root = try scratch()
        let host = SandboxHost(sandboxesDirectory: root, factory: FakeBackendFactory(guest: JobsGuest().answer), hostCPUs: 4, hostMemoryBytes: 8 * gib, now: { clock.now })
        _ = try await hostCall(host, "sandbox.create", #"{"name":"one","cpus":2,"memory_bytes":2147483648,"sleep_after_ms":5000}"#, sandboxID: "sandbox_1")
        clock.now += 4
        let early = await host.idleTick()
        XCTAssertTrue(early.isEmpty, "4 s idle is under its 5 s")
        clock.now += 2
        let slept = await host.idleTick()
        XCTAssertEqual(slept["sandbox_1"], ["kind": "slept", "detail": "hibernated one: saved its state and released its 2 GiB"])
        let status = try await hostCall(host, "sandbox.status", "{}", sandboxID: "sandbox_1")
        XCTAssertEqual(status["state"] as? String, "sleeping", "status reads a sleeping sandbox without waking it"); XCTAssertEqual(status["sleep_after_ms"] as? Int, 5000)
        XCTAssertEqual(try SandboxDirectory(root.appendingPathComponent("sandbox_1")).load().lifecycle, .asleep)
        let released = try await capacity(host)
        XCTAssertEqual(released["reserved_bytes"] as? Int, 0, "hibernate releases the memory")

        let woke = try await call(host, envelope("shell.exec", #"{"command":"true"}"#, mutation: "w1"))
        XCTAssertEqual(kinds(woke["result"] as? [String: Any] ?? [:]), ["woke"], "\(woke)")
        XCTAssertEqual(((woke["result"] as? [String: Any])?["actions"] as? [[String: Any]])?.first?["detail"] as? String, "restored one from its saved state")
        let again = try await call(host, envelope("shell.exec", #"{"command":"true"}"#, mutation: "w2"))
        XCTAssertNil((again["result"] as? [String: Any])?["actions"], "an awake sandbox reports nothing")

        // Locked screen (a Mac whose lock asks for a password): the VM pauses in memory, which keeps its RAM.
        let locked = SandboxHost(sandboxesDirectory: try scratch(), factory: FakeBackendFactory(saveError: .screenLocked, guest: JobsGuest().answer), hostCPUs: 4, hostMemoryBytes: 8 * gib, now: { clock.now })
        _ = try await hostCall(locked, "sandbox.create", #"{"name":"two","cpus":2,"memory_bytes":2147483648,"sleep_after_ms":5000}"#, sandboxID: "sandbox_1")
        clock.now += 6
        let paused = await locked.idleTick()
        XCTAssertEqual(paused["sandbox_1"], ["kind": "slept", "detail": "paused two in memory: hibernate needs an unlocked screen"])
        let pausedStatus = try await hostCall(locked, "sandbox.status", "{}", sandboxID: "sandbox_1")
        XCTAssertEqual(pausedStatus["state"] as? String, "sleeping"); XCTAssertEqual(pausedStatus["detail"] as? String, "paused in memory: hibernate needs an unlocked screen")
        let held = try await capacity(locked)
        XCTAssertEqual(held["reserved_bytes"] as? Int, 2 * 1024 * 1024 * 1024, "a VM paused in memory still holds its RAM")
        let resumed = try await call(locked, envelope("fs.stat", #"{"path":"/"}"#))
        XCTAssertEqual(((resumed["result"] as? [String: Any])?["actions"] as? [[String: Any]])?.first?["detail"] as? String, "woke two from sleep")
    }

    func testRunningJobKeepsAwake() async throws {
        let clock = TestClock(); let guest = JobsGuest()
        let host = SandboxHost(sandboxesDirectory: try scratch(), factory: FakeBackendFactory(guest: guest.answer), hostCPUs: 4, hostMemoryBytes: 8 * gib, now: { clock.now })
        _ = try await hostCall(host, "sandbox.create", #"{"name":"one","cpus":2,"memory_bytes":2147483648,"sleep_after_ms":5000}"#, sandboxID: "sandbox_1")
        guest.set("sandbox_1", jobs: 1)
        for _ in 0..<12 { clock.now += 1; let ticked = await host.idleTick(); XCTAssertTrue(ticked.isEmpty, "a running job keeps it awake") }
        guest.set("sandbox_1", jobs: 0)
        for _ in 0..<4 { clock.now += 1; let ticked = await host.idleTick(); XCTAssertTrue(ticked.isEmpty, "idle time starts when the job ended") }
        clock.now += 1
        let slept = await host.idleTick()
        XCTAssertEqual(slept["sandbox_1"]?["kind"], "slept")
    }

    func testDeleteAfter() async throws {
        let clock = TestClock(); let root = try scratch()
        let host = SandboxHost(sandboxesDirectory: root, factory: FakeBackendFactory(guest: JobsGuest().answer), hostCPUs: 4, hostMemoryBytes: 8 * gib, now: { clock.now })
        _ = try await hostCall(host, "sandbox.create", #"{"name":"one","cpus":2,"memory_bytes":2147483648,"sleep_after_ms":5000,"delete_after_ms":10000}"#, sandboxID: "sandbox_1")
        _ = try await hostCall(host, "sandbox.create", #"{"name":"two","cpus":2,"memory_bytes":2147483648,"sleep_after_ms":1800000}"#, sandboxID: "sandbox_2")
        clock.now += 6
        let slept = await host.idleTick()
        XCTAssertEqual(slept.keys.sorted(), ["sandbox_1"], "two keeps the 30 min default")
        clock.now += 5
        let deleted = await host.idleTick()
        XCTAssertEqual(deleted["sandbox_1"], ["kind": "deleted", "detail": "deleted one: idle for 11 s, past its delete-after of 10 s"], "time asleep counts")
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("sandbox_1").path))
        let gone = try await call(host, envelope("fs.stat", #"{"path":"/"}"#))
        XCTAssertEqual((gone["error"] as? [String: Any])?["code"] as? String, "sandbox_not_found")
        let watched = try await hostCall(host, "host.watch", #"{"since":0}"#)
        XCTAssertEqual(watched["deleted"] as? [[String: String]], [["sandbox_id": "sandbox_1", "name": "one", "reason": "idle for 11 s, past its delete-after of 10 s"]], "the connector removes it from the catalog")
        XCTAssertEqual((watched["sandboxes"] as? [[String: Any]])?.compactMap { $0["sandbox_id"] as? String }, ["sandbox_2"])
        _ = try await hostCall(host, "sandbox.mirror", #"{"source":"catalog","machine_id":"machine_1","sandboxes":[{"sandbox_id":"sandbox_2","name":"two","sleep_after_ms":1800000,"delete_after_ms":null}]}"#)
        let after = try await hostCall(host, "host.watch", #"{"since":0}"#)
        XCTAssertEqual((after["deleted"] as? [Any])?.count, 0, "once the catalog drops it, it is no longer reported")
    }

    func testPowerNoticeHibernatesAll() async throws {
        let root = try scratch()
        let host = SandboxHost(sandboxesDirectory: root, factory: FakeBackendFactory(guest: JobsGuest().answer), hostCPUs: 12, hostMemoryBytes: 24 * gib, allowsSimulatedPower: true)
        for (id, name) in [("sandbox_1", "one"), ("sandbox_2", "two"), ("sandbox_3", "three")] { _ = try await hostCall(host, "sandbox.create", #"{"name":"\#(name)","cpus":2,"memory_bytes":2147483648,"sleep_after_ms":1800000}"#, sandboxID: id) }
        _ = try await hostCall(host, "sandbox.stop", "{}", sandboxID: "sandbox_3")
        let slept = try await hostCall(host, "host.simulate_power", #"{"event":"will_sleep"}"#)
        XCTAssertEqual((slept["sandboxes"] as? [[String: Any]])?.map { "\($0["sandbox_id"]!) \($0["kind"]!)" }, ["sandbox_1 slept", "sandbox_2 slept"], "every running sandbox sleeps; a stopped one is left alone")
        for id in ["sandbox_1", "sandbox_2"] { XCTAssertEqual(try SandboxDirectory(root.appendingPathComponent(id)).load().lifecycle, .hibernated, "comes back at the next start too") }
        let listed = try await hostCall(host, "sandbox.list", "{}")["sandboxes"] as? [[String: Any]]
        XCTAssertEqual(listed?.map { $0["state"] as? String }, ["sleeping", "sleeping", "stopped"])

        _ = try await hostCall(host, "host.simulate_power", #"{"event":"did_wake"}"#)
        let awake = try await hostCall(host, "sandbox.list", "{}")["sandboxes"] as? [[String: Any]]
        XCTAssertEqual(awake?.map { $0["state"] as? String }, ["running", "running", "stopped"], "the wake brings back what the sleep took down")
        let first = try await call(host, envelope("fs.stat", #"{"path":"/"}"#))
        XCTAssertEqual(kinds(first["result"] as? [String: Any] ?? [:]), ["woke"], "the next result reports the wake")
        let second = try await call(host, envelope("fs.stat", #"{"path":"/"}"#))
        XCTAssertNil((second["result"] as? [String: Any])?["actions"], "once")

        let off = try await hostCall(host, "host.simulate_power", #"{"event":"will_power_off"}"#)
        XCTAssertEqual((off["sandboxes"] as? [[String: Any]])?.count, 2)
        let actions = await SandboxHost(sandboxesDirectory: root, factory: FakeBackendFactory()).recover()
        XCTAssertEqual(actions.mapValues { $0["kind"] }, ["sandbox_1": "woke", "sandbox_2": "woke"], "the next daemon start restores them")

        let release = SandboxHost(sandboxesDirectory: try scratch(), factory: FakeBackendFactory())
        let refused = try await call(release, envelope("host.simulate_power", #"{"event":"will_sleep"}"#, sandboxID: nil))
        XCTAssertEqual((refused["error"] as? [String: Any])?["code"] as? String, "unsupported", "only a LOCALBOX_DEV=1 daemon simulates power")
    }

    func testColdBootReportedOnce() async throws {
        let root = try scratch()
        let host = SandboxHost(sandboxesDirectory: root, factory: FakeBackendFactory(guest: JobsGuest().answer), hostCPUs: 4, hostMemoryBytes: 8 * gib)
        _ = try await hostCall(host, "sandbox.create", #"{"name":"one","cpus":2,"memory_bytes":2147483648,"sleep_after_ms":1800000}"#, sandboxID: "sandbox_1")
        // The daemon is killed (kill -9, power loss): nothing was saved. The next one cold-boots it at start.
        let restarted = SandboxHost(sandboxesDirectory: root, factory: FakeBackendFactory(guest: JobsGuest().answer), hostCPUs: 4, hostMemoryBytes: 8 * gib)
        let recovered = await restarted.recover()
        XCTAssertEqual(recovered["sandbox_1"], ["kind": "cold_booted", "detail": "cold-booted one: the daemon exited without saving it"])
        let first = try await call(restarted, envelope("shell.exec", #"{"command":"true"}"#, mutation: "c1"))
        XCTAssertEqual((first["result"] as? [String: Any])?["actions"] as? [[String: String]], [["kind": "cold_booted", "detail": "cold-booted one: the daemon exited without saving it"]])
        let second = try await call(restarted, envelope("shell.exec", #"{"command":"true"}"#, mutation: "c2"))
        XCTAssertNil((second["result"] as? [String: Any])?["actions"], "reported exactly once")

        // A result that is not an object carries it as host_actions.
        let failing = SandboxHost(sandboxesDirectory: root, factory: FakeBackendFactory { _ in Data(#"{"ok":false,"error":{"code":"internal","message":"boom","retryable":false}}"#.utf8) })
        _ = await failing.recover()
        let failed = try await call(failing, envelope("fs.stat", #"{"path":"/"}"#))
        XCTAssertEqual((failed["host_actions"] as? [[String: String]])?.first?["kind"], "cold_booted")
    }

    func testSleepAndStartReportWhatTheyDid() async throws {
        let host = try await hostWithSandbox()
        let slept = try await hostCall(host, "sandbox.sleep", "{}", sandboxID: "sandbox_1")
        XCTAssertEqual(kinds(slept), ["slept"])
        let woke = try await hostCall(host, "sandbox.start", "{}", sandboxID: "sandbox_1")
        XCTAssertEqual(kinds(woke), ["woke"])
        XCTAssertEqual((woke["produced"] as? [String: Any])?["state"] as? String, "running")
    }

    func testAuthenticatedLocalIPCRejectsWrongTokenAndForwardsEnvelope() async throws {
        let host = try await hostWithSandbox()
        let ipc = AuthenticatedLocalIPC(host: host, token: "secret")
        let request = envelope("shell.exec", #"{"command":"true"}"#, mutation: "e1")
        do { _ = try await ipc.handle(LocalIPCRequest(token: "wrong", envelope: request)); XCTFail("expected authentication failure") } catch { }
        let echoed = try await ipc.handle(LocalIPCRequest(token: "secret", envelope: request))
        XCTAssertEqual(echoed, request)
    }

    func testHostWatchAnswersImmediatelyWhenTheCallerIsBehind() async throws {
        let host = try await hostWithSandbox()
        let started = Date()
        let watched = try await hostCall(host, "host.watch", #"{"since":0,"timeout_ms":5000}"#)
        XCTAssertLessThan(Date().timeIntervalSince(started), 1)
        XCTAssertGreaterThan(watched["version"] as? Int ?? 0, 0)
        XCTAssertEqual(((watched["capacity"] as? [String: Any])?["cpus"] as? Int), 4)
    }

    func testHostWatchWaitsForALifecycleChangeOrTheTimeout() async throws {
        let host = try await hostWithSandbox()
        try await Task.sleep(nanoseconds: 50_000_000)
        let version = try await hostCall(host, "host.watch", #"{"since":0}"#)["version"] as! Int
        let timedOut = try await hostCall(host, "host.watch", #"{"since":\#(version),"timeout_ms":50}"#)
        XCTAssertEqual(timedOut["version"] as? Int, version)
        let waiter = Task { try await hostCall(host, "host.watch", #"{"since":\#(version),"timeout_ms":5000}"#) }
        try await Task.sleep(nanoseconds: 100_000_000)
        _ = try await hostCall(host, "sandbox.sleep", "{}", sandboxID: "sandbox_1")
        let changed = try await waiter.value
        XCTAssertGreaterThan(changed["version"] as? Int ?? 0, version)
        // The watch may answer on the way down (stopping, while the state is saved); it settles asleep.
        let settled = try await hostCall(host, "host.watch", #"{"since":0}"#)
        XCTAssertEqual((settled["sandboxes"] as? [[String: Any]])?.first?["state"] as? String, "sleeping")
    }

    func testRelayStatusAnswersFromTheConnectorReport() async throws {
        let clock = TestClock()
        let host = SandboxHost(sandboxesDirectory: try scratch(), factory: FakeBackendFactory(), now: { clock.now })
        let none = try await hostCall(host, "relay.status", "{}")
        XCTAssertEqual(none["connector"] as? String, "not_running"); XCTAssertEqual(none["connected"] as? Bool, false)
        _ = try await hostCall(host, "connector.report", #"{"state":"connected"}"#)
        let connected = try await hostCall(host, "relay.status", "{}")
        XCTAssertEqual(connected["connector"] as? String, "connected"); XCTAssertEqual(connected["connected"] as? Bool, true)
        XCTAssertNotNil(connected["reported_at"] as? String)
        clock.now = clock.now.addingTimeInterval(121)
        let stale = try await hostCall(host, "relay.status", "{}")
        XCTAssertEqual(stale["connector"] as? String, "not_running"); XCTAssertEqual(stale["connected"] as? Bool, false)
    }

    func testFramedGuestChannelSpeaksTheGuestFrameProtocol() async throws {
        let toGuest = Pipe(); let fromGuest = Pipe()
        let channel = FramedFileHandleGuestChannel(reader: fromGuest.fileHandleForReading, writer: toGuest.fileHandleForWriting, sandboxID: "sandbox_1", name: "quiet-otter")
        func frame(_ value: Data) -> Data { var size = UInt32(value.count).bigEndian; return Data(bytes: &size, count: 4) + value }
        func read() throws -> [String: Any] {
            let header = try toGuest.fileHandleForReading.read(upToCount: 4)!
            let length = header.reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
            return try JSONSerialization.jsonObject(with: try toGuest.fileHandleForReading.read(upToCount: Int(length))!) as! [String: Any]
        }
        try fromGuest.fileHandleForWriting.write(contentsOf: frame(Data(#"{"kind":"ready","channel_epoch":7}"#.utf8)))
        try await channel.waitUntilReady()
        let hello = try read()
        XCTAssertEqual(hello["kind"] as? String, "hello")
        XCTAssertEqual(hello["channel_epoch"] as? Int, 8, "hello moves the guest one epoch past the one it reported")
        XCTAssertEqual(hello["sandbox_id"] as? String, "sandbox_1"); XCTAssertEqual(hello["hostname"] as? String, "quiet-otter")
        XCTAssertNotNil(hello["wall_clock_ms"] as? Int)
        let guest = Task.detached { () throws -> [String: Any] in
            let sent = try read()
            try fromGuest.fileHandleForWriting.write(contentsOf: frame(Data(#"{"kind":"response","channel_epoch":8,"response":{"ok":true}}"#.utf8)))
            return sent
        }
        let response = try await channel.send(Data(#"{"request_id":"r1"}"#.utf8))
        XCTAssertEqual(String(data: response, encoding: .utf8), #"{"ok":true}"#)
        let sent = try await guest.value
        XCTAssertEqual(sent["kind"] as? String, "request")
        XCTAssertEqual(sent["channel_epoch"] as? Int, 8, "requests carry the epoch the host moved to, one past the guest's")
        XCTAssertEqual((sent["request"] as? [String: Any])?["request_id"] as? String, "r1")
        try await channel.rename(to: "calm-heron")
        let renamed = try read()
        XCTAssertEqual(renamed["channel_epoch"] as? Int, 9, "a rename is a hello under the next epoch"); XCTAssertEqual(renamed["hostname"] as? String, "calm-heron")
        await channel.close()
    }
}

extension HostDaemonCoreTests {
    private static let repoRoot = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../../../..").standardizedFileURL
    private static let fixture = ProcessFixtureConfiguration(guestCommand: ["/usr/bin/env", "node", "--import", "tsx", repoRoot.appendingPathComponent("apps/guest-agent/src/index.ts").path], workingDirectory: repoRoot)

    func testProcessFixtureSandboxesEachRunTheirOwnGuest() async throws {
        let root = try scratch()
        let factory = try ProcessFixtureFactory(configuration: Self.fixture, environment: ["LOCALBOX_SANDBOX_BACKEND": "process-fixture"])
        let host = SandboxHost(sandboxesDirectory: root, factory: factory, hostCPUs: 4, hostMemoryBytes: 8 * gib)
        for id in ["sandbox_1", "sandbox_2"] {
            let created = try await hostCall(host, "sandbox.create", #"{"name":"\#(id)","cpus":2,"memory_bytes":2147483648,"sleep_after_ms":1800000}"#, sandboxID: id)
            XCTAssertEqual(kinds(created), ["created", "cold_booted"])
        }
        let wrote = try await call(host, envelope("fs.write", #"{"path":"/hello.txt","content":"fixture"}"#, mutation: "w1"))
        XCTAssertEqual(wrote["ok"] as? Bool, true, "\(wrote)")
        XCTAssertEqual(try String(contentsOf: root.appendingPathComponent("sandbox_1/root/hello.txt"), encoding: .utf8), "fixture", "the guest root is <sandbox>/root")
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("sandbox_2/root/hello.txt").path), "each sandbox has its own root")

        let echoed = try await call(host, envelope("shell.exec", #"{"command":"echo","args":["round trip"],"cwd":"/","env":{}}"#, mutation: "e1", sandboxID: "sandbox_2"))
        XCTAssertEqual(((echoed["result"] as? [String: Any])?["stdout"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), "round trip", "\(echoed)")

        _ = try await hostCall(host, "sandbox.sleep", "{}", sandboxID: "sandbox_1")
        _ = try await hostCall(host, "sandbox.start", "{}", sandboxID: "sandbox_1")
        let resumed = try await call(host, envelope("fs.read", #"{"path":"/hello.txt"}"#))
        XCTAssertEqual((resumed["result"] as? [String: Any])?["content"] as? String, "fixture", "SIGCONT resumes the same guest process")

        await host.shutdown()
        XCTAssertEqual(try SandboxDirectory(root.appendingPathComponent("sandbox_1")).load().coldBootPending, "fixture: the process fixture cannot save its state")
    }

    func testFixtureBackendRefusedWithoutOptIn() throws {
        XCTAssertThrowsError(try ProcessFixtureFactory(configuration: Self.fixture, environment: [:]))
        XCTAssertThrowsError(try ProcessFixtureFactory(configuration: Self.fixture, environment: ["LOCALBOX_SANDBOX_BACKEND": "apple"]))
        XCTAssertNoThrow(try ProcessFixtureFactory(configuration: Self.fixture, environment: ["LOCALBOX_SANDBOX_BACKEND": "process-fixture"]))
    }

    /// A fresh sandboxes directory, removed after the test.
    func scratch() throws -> URL {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("lb-sandboxes-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        return directory
    }

    /// A host holding a running `sandbox_1` whose guest answers each envelope with itself.
    func hostWithSandbox() async throws -> SandboxHost {
        let host = SandboxHost(sandboxesDirectory: try scratch(), factory: FakeBackendFactory(), hostCPUs: 4, hostMemoryBytes: 8 * gib)
        _ = try await hostCall(host, "sandbox.create", #"{"name":"one","cpus":2,"memory_bytes":2147483648,"sleep_after_ms":1800000}"#, sandboxID: "sandbox_1")
        return host
    }
}

private final class TestClock: @unchecked Sendable {
    var now = Date(timeIntervalSince1970: 1_800_000_000)
}

/// A guest that answers `guest.activity` with a running-job count per sandbox, and everything else with its operation.
private final class JobsGuest: @unchecked Sendable {
    private let lock = NSLock()
    private var jobs: [String: Int] = [:]
    func set(_ sandboxID: String, jobs count: Int) { lock.lock(); jobs[sandboxID] = count; lock.unlock() }
    func count(_ sandboxID: String) -> Int { lock.lock(); defer { lock.unlock() }; return jobs[sandboxID] ?? 0 }
    var answer: @Sendable (Data) async throws -> Data {
        { [self] request in
            let object = try JSONSerialization.jsonObject(with: request) as? [String: Any]
            guard object?["operation"] as? String == "guest.activity", let id = object?["sandbox_id"] as? String else { return try JSONSerialization.data(withJSONObject: ["ok": true, "result": ["operation": object?["operation"] ?? ""]]) }
            let count = count(id)
            return try JSONSerialization.data(withJSONObject: ["ok": true, "result": ["running_jobs": count]])
        }
    }
}

private func capacity(_ host: SandboxHost) async throws -> [String: Any] {
    try await hostCall(host, "host.watch", #"{"since":0}"#)["capacity"] as? [String: Any] ?? [:]
}

private func envelope(_ operation: String, _ input: String, mutation: String? = nil, sandboxID: String? = "sandbox_1") -> Data {
    Data(#"{"protocol_version":"v1","request_id":"\#(operation)-1","operation":"\#(operation)","sandbox_id":\#(sandboxID.map { "\"\($0)\"" } ?? "null"),"deadline_ms":60000,"mutation_id":\#(mutation.map { "\"\($0)\"" } ?? "null"),"input":\#(input)}"#.utf8)
}

private func call(_ host: SandboxHost, _ request: Data) async throws -> [String: Any] {
    try JSONSerialization.jsonObject(with: try await host.request(request)) as! [String: Any]
}

private func hostCall(_ host: SandboxHost, _ operation: String, _ input: String, sandboxID: String? = nil) async throws -> [String: Any] {
    let response = try await call(host, envelope(operation, input, sandboxID: sandboxID))
    XCTAssertEqual(response["ok"] as? Bool, true, "\(operation): \(response)")
    return response["result"] as? [String: Any] ?? [:]
}

private func kinds(_ report: [String: Any]) -> [String] { (report["actions"] as? [[String: Any]])?.compactMap { $0["kind"] as? String } ?? [] }

#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif

private func localSocketPath() -> String {
    "/tmp/ac-\(UUID().uuidString).sock"
}

private func socketType() -> Int32 {
    #if canImport(Darwin)
    return SOCK_STREAM
    #else
    return Int32(SOCK_STREAM.rawValue)
    #endif
}

private func connectLocalSocket(_ path: String) throws -> Int32 {
    let fd = socket(AF_UNIX, socketType(), 0)
    guard fd >= 0 else { throw POSIXTestError.systemCall("socket", errno) }
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    let bytes = Array(path.utf8)
    withUnsafeMutableBytes(of: &address.sun_path) { destination in
        destination.copyBytes(from: [UInt8](repeating: 0, count: destination.count))
        destination.copyBytes(from: bytes)
    }
    let length = socklen_t(MemoryLayout<sa_family_t>.size + bytes.count + 1)
    let result = withUnsafePointer(to: &address) { pointer in
        pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            #if canImport(Darwin)
            Darwin.connect(fd, $0, length)
            #else
            Glibc.connect(fd, $0, length)
            #endif
        }
    }
    guard result == 0 else { close(fd); throw POSIXTestError.systemCall("connect", errno) }
    return fd
}

private enum POSIXTestError: Error { case systemCall(String, Int32) }

private func readExactly(_ count: Int, from handle: FileHandle) throws -> Data {
    var data = Data(); data.reserveCapacity(count)
    while data.count < count {
        guard let chunk = try handle.read(upToCount: count - data.count), !chunk.isEmpty else { throw POSIXTestError.systemCall("read", 0) }
        data.append(chunk)
    }
    return data
}

private func sendSocketFrame(_ body: Data, to handle: FileHandle) throws {
    var length = UInt32(body.count).bigEndian
    try handle.write(contentsOf: Data(bytes: &length, count: 4))
    try handle.write(contentsOf: body)
}

private func receiveSocketFrame(from handle: FileHandle) throws -> Data {
    let header = try readExactly(4, from: handle)
    let length = header.reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
    return try readExactly(Int(length), from: handle)
}

extension HostDaemonCoreTests {
    func testUnixDomainSocketForwardsAuthenticatedRequest() async throws {
        let host = try await hostWithSandbox()
        let path = localSocketPath()
        let endpoint = LocalIPCEndpoint(socketPath: path)
        let ipc = AuthenticatedLocalIPC(host: host, token: "socket-secret", endpoint: endpoint)
        let server = UnixDomainSocketServer(ipc: ipc, endpoint: endpoint)
        try await server.start()
        defer { Task { await server.stop() } }

        let fd = try connectLocalSocket(path)
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        let sent = envelope("shell.exec", #"{"command":"true"}"#, mutation: "e1")
        let request = LocalIPCRequest(token: "socket-secret", envelope: sent)
        try sendSocketFrame(try JSONEncoder().encode(request), to: handle)
        let response = try JSONDecoder().decode(LocalIPCResponse.self, from: receiveSocketFrame(from: handle))
        XCTAssertEqual(response.envelope, sent)
        XCTAssertNil(response.error)
        try handle.close()
        await server.stop()
        XCTAssertFalse(FileManager.default.fileExists(atPath: path))
    }

    func testUnixDomainSocketReturnsUnauthorizedAndMalformedResponses() async throws {
        let host = try await hostWithSandbox()
        let path = localSocketPath()
        let endpoint = LocalIPCEndpoint(socketPath: path)
        let ipc = AuthenticatedLocalIPC(host: host, token: "socket-secret", endpoint: endpoint)
        let server = UnixDomainSocketServer(ipc: ipc, endpoint: endpoint)
        try await server.start()
        defer { Task { await server.stop() } }

        do {
            let fd = try connectLocalSocket(path)
            let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
            let request = LocalIPCRequest(token: "wrong", envelope: Data("ping".utf8))
            try sendSocketFrame(try JSONEncoder().encode(request), to: handle)
            let response = try JSONDecoder().decode(LocalIPCResponse.self, from: receiveSocketFrame(from: handle))
            XCTAssertEqual(response.error, "unauthorized")
            try handle.close()
        }
        do {
            let fd = try connectLocalSocket(path)
            let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
            try sendSocketFrame(Data("not-json".utf8), to: handle)
            let response = try JSONDecoder().decode(LocalIPCResponse.self, from: receiveSocketFrame(from: handle))
            XCTAssertEqual(response.error, "malformed")
            try handle.close()
        }
        await server.stop()
    }
}

extension HostDaemonCoreTests {
    func testUnixDomainSocketRejectsOversizedFrame() async throws {
        let host = try await hostWithSandbox()
        let path = localSocketPath()
        let endpoint = LocalIPCEndpoint(socketPath: path)
        let ipc = AuthenticatedLocalIPC(host: host, token: "socket-secret", endpoint: endpoint)
        let server = UnixDomainSocketServer(ipc: ipc, endpoint: endpoint, maxFrameBytes: 16)
        try await server.start()
        defer { Task { await server.stop() } }

        let fd = try connectLocalSocket(path)
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        var length = UInt32(17).bigEndian
        try handle.write(contentsOf: Data(bytes: &length, count: 4))
        try handle.write(contentsOf: Data(repeating: 0x41, count: 17))
        let response = try JSONDecoder().decode(LocalIPCResponse.self, from: receiveSocketFrame(from: handle))
        XCTAssertEqual(response.error, "frame_too_large")
        try handle.close()
        await server.stop()
    }
}
