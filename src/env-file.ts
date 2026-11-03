import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";

/**
 * Load a dotenv file into `env` (default process.env). Variables that are already set always win over
 * the file, so a systemd EnvironmentFile= or a shell export can override it.
 *
 * File: `PINOTIFY_ENV_FILE` if set (must exist), else `.env` in the working directory (silently skipped
 * when absent). Returns the path loaded, or null.
 */
export function loadEnvFile(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string | null {
  const explicit = env["PINOTIFY_ENV_FILE"]?.trim();
  const path = resolve(cwd, explicit || ".env");
  if (!existsSync(path)) {
    if (explicit) throw new Error(`PINOTIFY_ENV_FILE not found: ${path}`);
    return null;
  }
  for (const [key, value] of Object.entries(parseEnv(readFileSync(path, "utf8")))) {
    if (env[key] === undefined) env[key] = value;
  }
  return path;
}
