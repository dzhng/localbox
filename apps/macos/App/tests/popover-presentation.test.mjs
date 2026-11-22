import assert from "node:assert/strict";
import { before, test } from "node:test";
import { compile, run } from "./driver.mjs";

// What the popover says for each of the shared facts fixtures (written by the CLI's tests/app-facts.test.ts):
// `PopoverPresentation` is where every word the popover shows is made, so its rows are checked here and the view only
// lays them out (the view shots in view-shots/ show that).
const FIXTURES = new URL("./fixtures/facts/", import.meta.url).pathname;

const DRIVER = `
import Foundation
func opt(_ value: Any?) -> Any { value ?? NSNull() }
func item(_ item: PopoverRows.Item) -> [String: Any] { ["title": item.title, "action": item.action.description, "enabled": item.enabled, "argv": opt(item.action.arguments)] }
func json(_ rows: PopoverRows) -> [String: Any] {
  var body: [String: Any]
  switch rows.body {
  case .lists(let sandboxes, let empty, let images):
    body = ["kind": "lists", "empty": opt(empty),
      "sandboxes": sandboxes.map { ["name": $0.name, "detail": $0.detail, "tone": $0.tone.rawValue, "progress": opt($0.progress), "error": opt($0.error), "items": $0.items.map(item)] },
      "images": images.map { ["name": $0.name, "detail": $0.detail, "tone": $0.tone.rawValue, "progress": opt($0.progress)] }]
  case .stopping(let title, let pending): body = ["kind": "stopping", "title": title, "pending": pending]
  }
  let h = rows.header
  return ["header": ["title": h.title, "connection": h.connection, "tone": h.connectionTone.rawValue, "room": opt(h.room), "version": h.version],
    "warning": rows.warning.map { ["message": $0.message, "fix": opt($0.fix), "more": opt($0.more)] } ?? NSNull(),
    "body": body, "settings": opt(rows.settings.map(item)), "quit": item(rows.quit), "status_icon": rows.statusIcon.rawValue]
}
@main struct Driver {
  static func main() throws {
    let dir = URL(fileURLWithPath: CommandLine.arguments[1])
    var out: [String: Any] = [:]
    for name in try FileManager.default.contentsOfDirectory(atPath: dir.path).sorted() where name.hasSuffix(".json") {
      out[String(name.dropLast(5))] = json(PopoverPresentation.rows(try AppFacts.decode(Data(contentsOf: dir.appendingPathComponent(name)))))
    }
    let three = try AppFacts.decode(Data(contentsOf: dir.appendingPathComponent("three-sandboxes.json")))
    out["three-sandboxes+failure"] = json(PopoverPresentation.rows(three, .init(failures: ["quiet-otter": "the sandbox is busy; try again"])))
    out["three-sandboxes+quitting"] = json(PopoverPresentation.rows(three, .init(quitting: ["quiet-otter"])))
    out["three-sandboxes+quit-done"] = json(PopoverPresentation.rows(three, .init(quitting: [])))
    out["loading"] = json(PopoverPresentation.rows(nil))
    out["could-not-start"] = json(PopoverPresentation.rows(nil, .init(couldNotStart: true)))
    out["idle+settings"] = json(PopoverPresentation.rows(try AppFacts.decode(Data(contentsOf: dir.appendingPathComponent("idle.json"))), .init(settingsAvailable: true)))
    print(String(decoding: try JSONSerialization.data(withJSONObject: out, options: [.sortedKeys]), as: UTF8.self))
  }
}
`;

let rows;
before(() => { rows = JSON.parse(run(compile(DRIVER), [FIXTURES])); });

const sandbox = (fixture, name) => rows[fixture].body.sandboxes.find((row) => row.name === name);
const actions = (row) => row.items.map((item) => item.action);

test("idle and connected: the account, Connected, the room left and the version; no sandboxes is a sentence, not a blank", () => {
  const idle = rows.idle;
  assert.deepEqual(idle.header, { title: "dev@example.com", connection: "Connected", tone: "good", room: "Free: 10 of 10 CPUs · 24 of 32 GB · 210 GB disk", version: "Version 0.2.0" });
  assert.equal(idle.warning, null);
  assert.deepEqual(idle.body, { kind: "lists", empty: "No sandboxes on this Mac yet.", sandboxes: [], images: [] }, "no images section when nothing is in progress");
  assert.equal(idle.status_icon, "normal");
  assert.deepEqual([idle.quit.title, idle.quit.enabled], ["Quit", true]);
  assert.equal(idle.settings, null, "no Settings item until there is a window to open");
  assert.deepEqual(rows["idle+settings"].settings, { title: "Settings…", action: "settings", enabled: true, argv: null });
});

test("three sandboxes: running, asleep and copying 43% with a bar; each row's menu offers only what fits its state", () => {
  const running = sandbox("three-sandboxes", "quiet-otter"), asleep = sandbox("three-sandboxes", "calm-heron"), copying = sandbox("three-sandboxes", "copy-crane");
  assert.deepEqual([running.detail, asleep.detail, copying.detail], ["Running · Linux", "Asleep · Linux", "Copying 43% · Linux"]);
  assert.ok(Math.abs(copying.progress - 0.43) < 0.005, String(copying.progress));
  assert.equal(running.progress, null);
  assert.deepEqual(actions(running), ["copy_name quiet-otter", "sleep quiet-otter", "open_log quiet-otter"]);
  assert.deepEqual(actions(asleep), ["copy_name calm-heron", "wake calm-heron", "open_log calm-heron"]);
  assert.deepEqual(actions(copying), ["copy_name copy-crane", "open_log copy-crane"]);
  assert.deepEqual(running.items.map((item) => item.argv), [null, ["sandbox", "sleep", "quiet-otter"], ["sandbox", "logs", "quiet-otter"]]);
  assert.deepEqual(asleep.items[1].argv, ["sandbox", "start", "calm-heron"]);
  for (const row of rows["three-sandboxes"].body.sandboxes) for (const item of row.items) assert.doesNotMatch(item.title, /delete|create/i, "no Delete or Create");
  assert.equal(rows["three-sandboxes"].header.room, "Free: 6 of 10 CPUs · 24 of 32 GB · 210 GB disk");
});

test("twelve sandboxes: every row is listed (the view caps the height and scrolls); paused and stopped can be woken", () => {
  const list = rows["twelve-sandboxes"].body.sandboxes;
  assert.equal(list.length, 12);
  for (const row of list.filter((row) => /^(Paused|Stopped|Asleep)/.test(row.detail))) assert.ok(actions(row).includes(`wake ${row.name}`), row.name);
});

test("images in progress: an image building and the built-in image downloading as linux, with phase and progress", () => {
  const images = rows["images-in-progress"].body.images;
  assert.deepEqual(images.map((image) => [image.name, image.detail]), [["linux", "Downloading 25%"], ["img_macos", "Building · install"]]);
  assert.equal(images[0].progress, 0.25);
  assert.equal(images[1].progress, null);
  assert.equal(rows["three-sandboxes"].body.images[0].detail, "Copying 43% · receiving", "worded as a copying sandbox is");
});

test("stopping with two pending: the sleep message and their names instead of the lists; Quit disabled", () => {
  const stopping = rows.stopping;
  assert.deepEqual(stopping.body, { kind: "stopping", title: "Putting 2 sandboxes to sleep…", pending: ["calm-heron", "quiet-otter"] });
  assert.equal(stopping.quit.enabled, false);
  assert.equal(stopping.warning, null);
  assert.equal(stopping.header.connection, "Quitting…", "not the connector's stale state");
  assert.deepEqual(rows["three-sandboxes+quitting"].body, { kind: "stopping", title: "Putting 1 sandbox to sleep…", pending: ["quiet-otter"] }, "the app's own quit outranks stale facts");
  assert.equal(rows["three-sandboxes+quit-done"].body.title, "Quitting…");
});

test("warnings: the first one's message and fix in the band, a count for the rest, and the warning status icon", () => {
  const all = rows["all-warnings"];
  assert.equal(all.warning.message, "Localbox's sandbox service isn't running, so sandboxes on this Mac can't start or answer.");
  assert.match(all.warning.fix, /quit Localbox and open it again/);
  assert.equal(all.warning.more, "6 more warnings");
  assert.equal(all.status_icon, "warning");
  assert.deepEqual(all.header, { title: "Not signed in", connection: "Offline", tone: "neutral", room: null, version: "Version 0.2.0" });
  assert.equal(all.body.empty, "Sandboxes show here once Localbox is running.");
  assert.equal(rows["hibernate-blocked"].warning.more, null);
  assert.match(rows["hibernate-blocked"].warning.fix, /Lock Screen/);
  assert.equal(rows["hibernate-blocked"].status_icon, "warning");
});

test("signed out, connector down, daemon down: the header says so", () => {
  assert.deepEqual([rows["signed-out"].header.title, rows["signed-out"].header.connection], ["Not signed in", "Offline"]);
  assert.equal(rows["signed-out"].warning.message, "This Mac isn't signed in, so other computers and cloud agents can't reach its sandboxes.");
  assert.deepEqual([rows["connector-down"].header.connection, rows["connector-down"].header.tone], ["Disconnected", "warning"]);
  assert.deepEqual([rows["daemon-down"].header.connection, rows["daemon-down"].header.room], ["Connecting…", null]);
});

test("a failed action's message shows in its row; before the first read, a loading line; a failed start says what to do", () => {
  assert.equal(sandbox("three-sandboxes+failure", "quiet-otter").error, "the sandbox is busy; try again");
  assert.equal(sandbox("three-sandboxes+failure", "calm-heron").error, null);
  assert.deepEqual([rows.loading.header.title, rows.loading.body.empty, rows.loading.status_icon], ["Localbox", "Loading…", "normal"]);
  assert.deepEqual([rows["could-not-start"].header.connection, rows["could-not-start"].status_icon], ["Couldn't start", "warning"]);
});

test("copy is sentence case and plain: no raw state words or codes leak into what the popover says", () => {
  const strings = [];
  const walk = (value) => { if (typeof value === "string") strings.push(value); else if (value && typeof value === "object") Object.values(value).forEach(walk); };
  for (const [name, value] of Object.entries(rows)) walk({ header: value.header, body: value.body.kind === "lists" ? value.body.sandboxes.map((row) => row.detail).concat(value.body.empty ?? []) : value.body.title });
  for (const text of strings) assert.doesNotMatch(text, /backing_off|signed_out|_down\b|undefined|null/, text);
});
