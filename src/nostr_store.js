import path from "node:path";
import { ensureDir, readJson, writeJsonAtomic } from "./storage.js";

export class NostrStore {
  constructor({ dataDir }) {
    this.dataDir = dataDir;
    this.path = path.join(dataDir, "nostr_index.json");
  }

  async init() {
    await ensureDir(this.dataDir);
  }

  async load() {
    const data = await readJson(this.path, { v: 1, rooms: {} });
    if (!data || typeof data !== "object") return { v: 1, rooms: {} };
    if (!data.rooms || typeof data.rooms !== "object") data.rooms = {};
    return data;
  }

  async save(index) {
    await writeJsonAtomic(this.path, index);
  }
}

