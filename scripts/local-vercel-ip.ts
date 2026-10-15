import type { IncomingHttpHeaders } from "node:http";

export function forwardedHeaders(input: IncomingHttpHeaders, socketAddress: string, trustClientIp = false): Record<string, string> {
  const headers = Object.fromEntries(Object.entries(input).flatMap(([key, value]) => value === undefined ? [] : [[key, Array.isArray(value) ? value.join(", ") : value]]));
  const clientIp = trustClientIp ? headers["x-forwarded-for"]?.split(",", 1)[0]?.trim() || socketAddress : socketAddress;
  headers["x-forwarded-for"] = clientIp; headers["x-real-ip"] = clientIp; headers["x-vercel-forwarded-for"] = clientIp;
  return headers;
}
