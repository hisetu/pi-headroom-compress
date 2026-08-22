/** Resolve the Python executable used for Headroom parity/benchmark runners. */
import { homedir, platform as osPlatform } from "node:os";
import { posix, win32 } from "node:path";

/** Explicit HEADROOM_PYTHON override, otherwise uv's platform-specific tool path. */
export function resolveHeadroomPython(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? osPlatform();
  const home = options.home ?? homedir();
  const override = env.HEADROOM_PYTHON?.trim();
  if (override) return override;

  const { join } = platform === "win32" ? win32 : posix;
  let toolRoot = env.UV_TOOL_DIR?.trim();
  if (!toolRoot && platform === "win32") {
    const appData = env.APPDATA?.trim()
      || join(env.USERPROFILE?.trim() || home, "AppData", "Roaming");
    toolRoot = join(appData, "uv", "tools");
  } else if (!toolRoot) {
    const dataHome = env.XDG_DATA_HOME?.trim() || join(home, ".local", "share");
    toolRoot = join(dataHome, "uv", "tools");
  }

  const installRoot = join(toolRoot, "headroom-ai");
  return platform === "win32"
    ? join(installRoot, "Scripts", "python.exe")
    : join(installRoot, "bin", "python");
}

/** Human-readable parity reference label for logs and CI matrix jobs. */
export function describeHeadroomReference(env = process.env) {
  return env.HEADROOM_REFERENCE?.trim()
    || env.HEADROOM_VERSION?.trim()
    || "default uv tool installation";
}
