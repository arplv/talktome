import fs from "node:fs/promises";
import path from "node:path";

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

export async function readJson(filePath, fallback) {
  try {
    const text = await fs.readFile(filePath, "utf-8");
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export async function writeJsonAtomic(filePath, value) {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  const text = JSON.stringify(value, null, 2) + "\n";
  await fs.writeFile(tmp, text, "utf-8");
  await fs.rename(tmp, filePath);
}

export async function appendJsonl(filePath, value) {
  const line = JSON.stringify(value) + "\n";
  await fs.appendFile(filePath, line, "utf-8");
}

export async function readJsonl(filePath) {
  try {
    const text = await fs.readFile(filePath, "utf-8");
    const lines = text.split("\n").filter(Boolean);
    const out = [];
    for (const line of lines) {
      try {
        out.push(JSON.parse(line));
      } catch {
        // skip invalid line
      }
    }
    return out;
  } catch {
    return [];
  }
}
