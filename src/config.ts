export interface AppConfig {
  host: string;
  port: number;
  mode: "simulation" | "production";
  adminToken?: string | undefined;
  sendToken?: string | undefined;
  secretKey?: string | undefined;
  dataDir: string;
  superuser: { name?: string | undefined; email?: string | undefined; sms?: string | undefined };
  limits: { perHour: number; perDay: number };
  cooldownMs: number;
  logDays: number;
}

function int(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isNaN(n) ? fallback : n;
}

const text = (v: string | undefined): string | undefined => v?.trim() || undefined;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const config: AppConfig = {
    host: env["PINOTIFY_HOST"] ?? "0.0.0.0",
    port: int(env["PINOTIFY_PORT"], 3109),
    mode: env["PINOTIFY_MODE"] === "production" ? "production" : "simulation",
    adminToken: text(env["PINOTIFY_ADMIN_TOKEN"]),
    sendToken: text(env["PINOTIFY_SEND_TOKEN"]),
    secretKey: text(env["PINOTIFY_SECRET_KEY"]),
    dataDir: text(env["PINOTIFY_DATA_DIR"]) ?? "./data",
    superuser: {
      name: text(env["PINOTIFY_SUPERUSER_NAME"]),
      email: text(env["PINOTIFY_SUPERUSER_EMAIL"]),
      sms: text(env["PINOTIFY_SUPERUSER_SMS"])
    },
    limits: {
      perHour: Math.max(1, int(env["PINOTIFY_LIMIT_PER_HOUR"], 6)),
      perDay: Math.max(1, int(env["PINOTIFY_LIMIT_PER_DAY"], 20))
    },
    cooldownMs: Math.max(0, int(env["PINOTIFY_COOLDOWN_MS"], 60_000)),
    logDays: Math.max(1, int(env["PINOTIFY_LOG_DAYS"], 90))
  };
  return config;
}

/** Problems that make a configuration unsafe to start with. Production must be locked down. */
export function configProblems(config: AppConfig): string[] {
  const problems: string[] = [];
  if (config.mode === "production") {
    if (!config.adminToken) problems.push("PINOTIFY_ADMIN_TOKEN is required in production");
    if (!config.secretKey) problems.push("PINOTIFY_SECRET_KEY is required in production (data is always encrypted at rest)");
  }
  if (config.adminToken && config.sendToken && config.adminToken === config.sendToken) {
    problems.push("PINOTIFY_SEND_TOKEN must differ from PINOTIFY_ADMIN_TOKEN");
  }
  return problems;
}
