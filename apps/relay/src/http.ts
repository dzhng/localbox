import { ConvexError } from "convex/values";

/** Small Web Request helpers shared by the relay and MCP entries. */
export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
export const bearer = (request: Request) => request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
/** Vercel sets both headers from the connection; `scripts/local-vercel.ts` overwrites them the same way. */
export const clientIp = (request: Request) => request.headers.get("x-real-ip") ?? request.headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
/** The code of an expected Convex failure (`refuse`/`fail`); production Convex redacts every other error's message. */
export const convexCode = (error: unknown): string | undefined => error instanceof ConvexError && typeof error.data?.code === "string" ? error.data.code : undefined;
