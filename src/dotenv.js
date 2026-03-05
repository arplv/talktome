import fs from "node:fs";
import path from "node:path";

// Minimal `.env` loader to make the repo work out-of-the-box without extra deps.
// - Does not override already-set environment variables by default.
// - Supports: KEY=value, KEY="value", KEY='value', and comments starting with `#`.
export function loadDotenv({ dotenvPath = path.join(process.cwd(), ".env"), override = false } = {}) {
  let raw = "";
  try {
    raw = fs.readFileSync(dotenvPath, "utf8");
  } catch {
    return { loaded: false, dotenvPath };
  }

  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;

    const key = trimmed.slice(0, idx).trim();
    if (!key) continue;

    let value = trimmed.slice(idx + 1).trim();
    // Strip surrounding quotes.
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    // Very small escape support.
    value = value.replace(/\\n/g, "\n");

    if (!override && process.env[key] != null) continue;
    process.env[key] = value;
  }

  return { loaded: true, dotenvPath };
}

