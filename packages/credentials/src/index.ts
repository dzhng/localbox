import { chmod, mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface Credentials {
  api_origin: string; convex_url: string; account_id: string; account_name: string;
  machine_id: string; machine_name: string; secret: string;
}
export async function readCredentials(path: string): Promise<Credentials | undefined> {
  try {
    const mode = (await stat(path)).mode & 0o777;
    if (mode !== 0o600) throw new Error("credentials.json must have mode 0600");
    return JSON.parse(await readFile(path, "utf8")) as Credentials;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
export async function writeCredentials(path: string, credentials: Credentials): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(credentials, null, 2)}\n`, "utf8");
    await handle.chmod(0o600); await handle.sync();
  } finally { await handle.close(); }
  await rename(temporary, path); await chmod(path, 0o600);
}
export async function deleteCredentials(path: string): Promise<void> { try { await unlink(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
