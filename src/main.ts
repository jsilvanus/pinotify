import "./load-env.js";
import { buildApp } from "./app.js";
import { configProblems, loadConfig } from "./config.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const problems = configProblems(config);
  if (problems.length) {
    console.error(`pinotify: refusing to start:\n- ${problems.join("\n- ")}`);
    process.exit(1);
  }
  const { app, hub } = buildApp(config);
  const shutdown = async () => {
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  try {
    await hub.reload();
    await app.listen({ port: config.port, host: config.host });
    app.log.info({ port: config.port, mode: config.mode }, "pinotify listening");
  } catch (err) {
    app.log.error(err, "Failed to start pinotify");
    process.exit(1);
  }
}

void main();
