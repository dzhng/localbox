import { writeFile } from "node:fs/promises";
import { catalogSnapshot, cliHelpSnapshot, mcpToolsSnapshot, PROTOCOL_VERSION, type RequestEnvelope } from "../../../packages/contract/src/index.js";
import { FakeDispatcher } from "../../../packages/runtime/src/index.js";

const command = process.argv.slice(2).join(" ");

async function contractProbe(): Promise<void> {
  const dispatcher = new FakeDispatcher();
  const request: RequestEnvelope = { protocol_version: PROTOCOL_VERSION, request_id: "probe-0001", operation: "system.info", vm_id: "vm_01", deadline_ms: 30_000, mutation_id: null, input: {} };
  const systemInfo = await dispatcher.dispatch(request);
  const payload = { catalog: catalogSnapshot(), cli_help: cliHelpSnapshot(), mcp_tools: mcpToolsSnapshot(), system_info: systemInfo };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

async function generateSnapshots(): Promise<void> {
  await writeFile("snapshots/catalog.json", `${JSON.stringify(catalogSnapshot(), null, 2)}\n`);
  await writeFile("snapshots/cli-help.json", `${JSON.stringify(cliHelpSnapshot(), null, 2)}\n`);
  await writeFile("snapshots/mcp-tools.json", `${JSON.stringify(mcpToolsSnapshot(), null, 2)}\n`);
  process.stdout.write("Generated contract snapshots.\n");
}

if (command === "contract probe") await contractProbe();
else if (command === "contract generate-snapshots") await generateSnapshots();
else {
  process.stderr.write("Usage: agent-computer contract probe\n");
  process.exitCode = 2;
}
