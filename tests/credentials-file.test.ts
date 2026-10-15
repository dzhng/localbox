import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, chmod, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCredentials, writeCredentials } from "../packages/credentials/src/index.js";
test("credentials are atomically written at mode 0600 and loose files are refused", async () => { const root = await mkdtemp(join(tmpdir(), "localbox-credentials-")); const path = join(root, "credentials.json"); const value = { api_origin: "https://api.test", convex_url: "https://convex.test", account_id: "a", account_name: "brave-walrus-482", machine_id: "m", machine_name: "mac", secret: "s" }; await writeCredentials(path, value); assert.deepEqual(await readCredentials(path), value); assert.equal((await stat(path)).mode & 0o777, 0o600); await chmod(path, 0o644); await assert.rejects(() => readCredentials(path), /0600/); });
