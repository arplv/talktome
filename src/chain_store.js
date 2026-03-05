import path from "node:path";
import { ensureDir, readJson, writeJsonAtomic } from "./storage.js";

export class ChainStore {
  constructor({ dataDir }) {
    this.dataDir = dataDir;
    this.path = path.join(dataDir, "chain_index.json");
  }

  async init() {
    await ensureDir(this.dataDir);
  }

  async load() {
    const data = await readJson(this.path, {
      v: 1,
      lastProcessedBlock: null,
      issues: {}
    });
    if (!data || typeof data !== "object") {
      return { v: 1, lastProcessedBlock: null, issues: {} };
    }
    if (!data.issues || typeof data.issues !== "object") data.issues = {};
    return data;
  }

  async save(index) {
    await writeJsonAtomic(this.path, index);
  }
}

