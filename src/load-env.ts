// Imported first by main.ts and cli.ts so the .env file is loaded before anything reads process.env.
import { loadEnvFile } from "./env-file.js";

try {
  loadEnvFile();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
