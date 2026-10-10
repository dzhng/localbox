# Slice 09 — Optional MCP adapter

## Contract unlocked

Standards-based MCP clients can discover, authorize, list, and call the same
catalog through Streamable HTTP.

## API seam and ownership

`apps/mcp` owns JSON-RPC framing, MCP initialization, tool generation, protected
resource metadata, and transport mapping. It calls the canonical client/relay
seam; it does not define business behavior or special permissions.

## Runnable artifact

`agent-computer mcp probe` runs initialize, tools/list, and tools/call for shell,
browser, and screenshot operations against a local/staging relay fixture.

## Verification

- One MCP endpoint supports POST and the required GET behavior.
- Origin validation, OAuth discovery, protocol-version headers, cancellation,
  streaming, and structured/text result mapping follow the MCP specification.
- Tool names, schemas, errors, and results equal CLI help/operation fixtures.
- stdout contains protocol messages only; diagnostics go to stderr.
- MCP remains optional: the CLI-only workflow still passes all catalog tests.
