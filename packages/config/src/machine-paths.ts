import { join } from "node:path";
import { homedir } from "node:os";

export interface MachinePaths {
  root: string;
  credentials: string;
  ipcToken: string;
  socket: string;
  sandboxes: string;
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
    logs: join(root, "logs"),
  };
}
