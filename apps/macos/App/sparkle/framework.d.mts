// Types for framework.mjs, which the release's TypeScript stages import.
export function frameworkProblem(framework: string): string | null;
export function frameworkIdentity(root: string): { sha256: string };
