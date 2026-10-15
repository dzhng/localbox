import assert from "node:assert/strict";
import test from "node:test";
import { accountName, machineName, sandboxName, validateLabel } from "../packages/names/src/index.js";
test("names follow the durable label contract", () => { assert.match(accountName(() => 0), /^[a-z]+-[a-z]+-\d{3}$/); assert.match(sandboxName(() => 0), /^[a-z]+-[a-z]+$/); assert.equal(machineName("My Mac.local"), "my-mac-local"); assert.equal(validateLabel("machine-1"), "machine-1"); assert.throws(() => validateLabel("Bad Label")); });
