import { join } from "node:path";
import { homedir } from "node:os";
import { DEV_BUNDLE_ID, thisAppBundle, type AppBundle } from "./app-bundle.js";

export interface MachinePaths {
  root: string;
  credentials: string;
  ipcToken: string;
  socket: string;
  /** The host daemon's lock: one daemon per root, held for its life (`MachineLock` in the daemon). */
  hostdLock: string;
  /** Localbox.app's own socket (`AppSocket`): `localbox app` reaches the app's native powers through it. */
  appSocket: string;
  /** One directory per sandbox (`<id>/sandbox.json`, `disk.img`, `state.vzsave`), owned by the host daemon. */
  sandboxes: string;
  /** One journal per long host operation (`<mutation_id>.json`), owned by the host daemon's `HostOperationStore`. */
  operations: string;
  /** One directory per image on this Mac (`<id>/image.json`, `disk.img`, `boot/`), owned by the host daemon's `ImageStore`. */
  images: string;
  /**
   * `localbox app image ensure`'s staging (`linux-<version>/`: the image's parts and its expansion), kept out of
   * `images` because the daemon's start-time sweep deletes any unfinished write it finds there.
   */
  downloads: string;
  /** The built-in image's progress as `localbox app image ensure` last reported it; `app status` and the daemon read it. */
  builtinImage: string;
  /** Where Localbox.app writes its own, the daemon's and the connector's logs. */
  logs: string;
}

/**
 * This Mac's Localbox state. `LOCALBOX_MACHINE_ROOT` relocates all of it (simulated machines, probes). Otherwise a
 * development build of the app (`app`, the bundle this CLI runs in) gets its own root, logs and credential beside
 * the release's, so a dev app and a release app never share a daemon, sandboxes or a machine identity.
 */
export function machinePaths(env: NodeJS.ProcessEnv = process.env, app: AppBundle | null = thisAppBundle()): MachinePaths {
  const relocated = env.LOCALBOX_MACHINE_ROOT;
  const home = env.HOME || homedir();
  const dev = app?.id === DEV_BUNDLE_ID;
  const name = dev ? "Localbox Dev" : "Localbox";
  const root = relocated ?? join(home, "Library", "Application Support", name);
  return {
    root,
    credentials: relocated || dev ? join(root, "credentials.json") : join(home, ".config", "localbox", "credentials.json"),
    ipcToken: join(root, "ipc-token"),
    socket: join(root, "agent.sock"),
    hostdLock: join(root, "hostd.lock"),
    appSocket: join(root, "app.sock"),
    sandboxes: join(root, "sandboxes"),
    operations: join(root, "operations"),
    images: join(root, "images"),
    downloads: join(root, "downloads"),
    builtinImage: join(root, "builtin-image.json"),
    logs: relocated ? join(root, "logs") : join(home, "Library", "Logs", name),
  };
}
