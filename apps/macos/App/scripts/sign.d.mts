// Types for sign.mjs, which the release's TypeScript stages import.
export interface SigningIdentity { identity: string; keychain?: string }
export const CLI_IDENTIFIER: string;
export const ENTITLEMENTS: string;
export const SEALED: string;
export function signApp(app: string, identity: SigningIdentity): string[];
export function certificateOf(identity: { p12: string; passwordFile: string }): { sha1: string; sha256: string; name: string | undefined };
export function withIdentity<T>(identity: { p12: string; passwordFile: string; sha1?: string }, action: (identity: Required<SigningIdentity>) => T | Promise<T>): Promise<T>;
