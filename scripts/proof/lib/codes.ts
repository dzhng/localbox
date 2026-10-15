import { open, stat } from "node:fs/promises";

export async function waitForCode(email: string, options: { sinceByte: number; logPath?: string; timeoutMs?: number }): Promise<string> {
  const path = options.logPath ?? ".localbox/proof/dev-local.log";
  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  const pattern = new RegExp(`(?:code|verification)[^0-9]*([0-9]{6})[^\\n]*${email.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}`, "i");
  while (Date.now() < deadline) {
    try {
      const size = (await stat(path)).size;
      if (size > options.sinceByte) {
        const handle = await open(path, "r");
        const buffer = Buffer.alloc(size - options.sinceByte);
        await handle.read(buffer, 0, buffer.length, options.sinceByte); await handle.close();
        const match = pattern.exec(buffer.toString("utf8"));
        if (match) return match[1];
      }
    } catch { /* log may not exist until the server starts */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`verification code for ${email} was not found in ${path}`);
}
