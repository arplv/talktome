import path from "node:path";
import { ensureDir, readJson, writeJsonAtomic } from "./storage.js";

export class IssuesStore {
  constructor({ dataDir }) {
    this.dataDir = dataDir;
    this.issuesPath = path.join(dataDir, "issues.json");
  }

  async init() {
    await ensureDir(this.dataDir);
  }

  async loadAll() {
    const data = await readJson(this.issuesPath, { v: 1, issues: [] });
    if (!data || typeof data !== "object") return [];
    if (!Array.isArray(data.issues)) return [];
    return data.issues;
  }

  async saveAll(issues) {
    await writeJsonAtomic(this.issuesPath, { v: 1, issues });
  }
}

