import path from "node:path";
import { appendJsonl, ensureDir, readJsonl } from "./storage.js";

export class MessageStore {
  constructor({ dataDir }) {
    this.dataDir = dataDir;
    this.path = path.join(dataDir, "messages.jsonl");
  }

  async init() {
    await ensureDir(this.dataDir);
  }

  async append({ roomId, entry }) {
    if (!roomId || !entry) return;
    await appendJsonl(this.path, { v: 1, roomId, entry });
  }

  async loadRecentByRoom({ maxPerRoom }) {
    const lines = await readJsonl(this.path);
    /** @type {Map<string, any[]>} */
    const map = new Map();
    for (const line of lines) {
      const roomId = line?.roomId;
      const entry = line?.entry;
      if (!roomId || !entry) continue;
      const arr = map.get(roomId) ?? [];
      arr.push(entry);
      map.set(roomId, arr);
    }
    for (const [roomId, arr] of map.entries()) {
      if (arr.length > maxPerRoom) map.set(roomId, arr.slice(arr.length - maxPerRoom));
    }
    return map;
  }
}

