import { join } from "node:path";
import { homedir } from "node:os";

export interface MachinePaths {
  root: string;
  credentials: string;
  ipcToken: string;
  socket: string;
  /** One directory per sandbox (`<id>/sandbox.json`, `disk.img`, `state.vzsave`), owned by the host daemon. */
  sandboxes: string;
  /** One journal per long host operation (`<mutation_id>.json`), owned by the host daemon's `HostOperationStore`. */
  operations: string;
  /** One directory per image on this Mac (`<id>/image.json`, `disk.img`, `boot/`), owned by the host daemon's `ImageStore`. */
  images: string;
  logs: string;
}

export function machinePaths(env: NodeJS.ProcessEnv = process.env): MachinePaths {
  const relocated = env.LOCALBOX_MACHINE_ROOT;
  const home = env.HOME || homedir();
  const root = relocated ?? join(home, "Library", "Application Support", "Localbox");
  return {
    root,
    credentials: relocated ? join(root, "credentials.json") : join(home, ".config", "localbox", "credentials.json"),
    ipcToken: join(root, "ipc-token"),
    socket: join(root, "agent.sock"),
    sandboxes: join(root, "sandboxes"),
    operations: join(root, "operations"),
    images: join(root, "images"),
    logs: join(root, "logs"),
  };
}
