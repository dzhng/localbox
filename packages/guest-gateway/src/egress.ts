export type AddressFamily = "ipv4" | "ipv6" | "unknown";
export interface EgressReport {
  connected: boolean;
  address_family: AddressFamily;
  public_ip: string | null;
  resolver: string | null;
  interface: string | null;
  timestamp: string;
  confidence: "high" | "medium" | "low" | "none";
  diagnostics: string[];
}
export interface EgressProbeResult { publicIp?: string; family?: AddressFamily; resolver?: string; interface?: string; }
export interface EgressDiagnosticsOptions {
  httpsProbe?: () => Promise<EgressProbeResult>;
  dnsProbe?: () => Promise<{ resolver?: string; family?: AddressFamily }>;
  interfaceProbe?: () => Promise<{ interface?: string }>;
  now?: () => Date;
}

/** Run controlled probes and return facts without making anti-bot or routing promises. */
export async function collectEgressDiagnostics(options: EgressDiagnosticsOptions = {}): Promise<EgressReport> {
  const now = options.now ?? (() => new Date());
  let https: EgressProbeResult | undefined; let dns: { resolver?: string; family?: AddressFamily } | undefined; let iface: { interface?: string } | undefined;
  const diagnostics: string[] = [];
  try { https = options.httpsProbe ? await options.httpsProbe() : undefined; } catch (error) { diagnostics.push(`HTTPS echo failed: ${error instanceof Error ? error.message : "unknown error"}`); }
  try { dns = options.dnsProbe ? await options.dnsProbe() : undefined; } catch (error) { diagnostics.push(`DNS probe failed: ${error instanceof Error ? error.message : "unknown error"}`); }
  try { iface = options.interfaceProbe ? await options.interfaceProbe() : undefined; } catch (error) { diagnostics.push(`Network interface probe failed: ${error instanceof Error ? error.message : "unknown error"}`); }
  const publicIp = https?.publicIp ?? null;
  const family = https?.family ?? dns?.family ?? (publicIp?.includes(":") ? "ipv6" : publicIp ? "ipv4" : "unknown");
  const connected = Boolean(publicIp);
  if (!connected && diagnostics.length === 0) diagnostics.push("No controlled HTTPS echo result; guest connectivity is unknown.");
  if (diagnostics.some((x) => x.startsWith("DNS"))) diagnostics.push("Check resolver configuration or captive portal interception.");
  if (diagnostics.some((x) => x.startsWith("HTTPS"))) diagnostics.push("Check VPN, Private Relay, firewall, or captive portal connectivity.");
  return { connected, address_family: family, public_ip: publicIp, resolver: https?.resolver ?? dns?.resolver ?? null, interface: https?.interface ?? iface?.interface ?? null, timestamp: now().toISOString(), confidence: publicIp && (dns || !options.dnsProbe) ? "high" : publicIp ? "medium" : "none", diagnostics };
}
export const diagnoseEgress = collectEgressDiagnostics;
