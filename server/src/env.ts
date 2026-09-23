// Zero-dependency .env loader shared by the server, seed script and tests.
// Existing process env always wins, so deployments inject via platform env.
import fs from "node:fs";

export function loadEnvFile(file: string): void {
  try {
    const raw = fs.readFileSync(file, "utf8");
    for (const line of raw.split("\n")) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (!m) continue;
      if (!(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {
    /* no env file — fine, real env vars or mock mode */
  }
}
