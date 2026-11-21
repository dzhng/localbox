declare const LOCALBOX_AGENT_VERSION: string | undefined;

/**
 * This agent's version, embedded by `bun build --define` in `scripts/build-guest-agent.ts` (the `version` of
 * `agent-version.json`); undefined when the agent runs from source, which has no binary of its own to replace.
 */
export const AGENT_VERSION: string | undefined = typeof LOCALBOX_AGENT_VERSION === "string" && LOCALBOX_AGENT_VERSION ? LOCALBOX_AGENT_VERSION : undefined;
