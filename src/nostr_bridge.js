import { SimplePool, validateEvent, verifyEvent } from "nostr-tools";

function getTagValue(tags, name) {
  if (!Array.isArray(tags)) return null;
  for (const t of tags) {
    if (Array.isArray(t) && t[0] === name && typeof t[1] === "string") return t[1];
  }
  return null;
}

function hasTag(tags, name, value) {
  if (!Array.isArray(tags)) return false;
  return tags.some((t) => Array.isArray(t) && t[0] === name && t[1] === value);
}

function toIsoFromNostr(createdAtSeconds) {
  const ms = Number(createdAtSeconds) * 1000;
  if (!Number.isFinite(ms)) return new Date().toISOString();
  return new Date(ms).toISOString();
}

export class NostrBridge {
  constructor({ relays, nostrStore, state, messageStore, broadcastToRoom, backfillMinutes }) {
    this.relays = relays;
    this.nostrStore = nostrStore;
    this.state = state;
    this.messageStore = messageStore;
    this.broadcastToRoom = broadcastToRoom;
    this.backfillMinutes = backfillMinutes ?? 60;

    this.pool = new SimplePool({ enableReconnect: true, enablePing: true });
    this.index = null;

    /** @type {Map<string, { closer: any, refCount: number }>} */
    this.subs = new Map();
    /** @type {Set<string>} */
    this.seenIds = new Set();
  }

  enabled() {
    return Array.isArray(this.relays) && this.relays.length > 0;
  }

  async init() {
    await this.nostrStore.init();
    this.index = await this.nostrStore.load();
  }

  config() {
    return { enabled: this.enabled(), relays: this.relays };
  }

  _roomSince(roomId) {
    const saved = this.index?.rooms?.[roomId]?.since;
    if (typeof saved === "number" && Number.isFinite(saved) && saved > 0) return saved;
    const backfill = Math.max(0, Number(this.backfillMinutes) || 0) * 60;
    return Math.floor(Date.now() / 1000) - backfill;
  }

  async _setRoomSince(roomId, since) {
    if (!this.index) return;
    if (!this.index.rooms) this.index.rooms = {};
    const existing = this.index.rooms[roomId] ?? {};
    this.index.rooms[roomId] = { ...existing, since };
    await this.nostrStore.save(this.index);
  }

  _eventToMessage(event) {
    const roomId = getTagValue(event.tags, "d");
    if (!roomId) return null;
    if (!hasTag(event.tags, "t", "talktome")) return null;

    return {
      v: 1,
      id: event.id,
      kind: "chat",
      roomId,
      agentId: `nostr:${event.pubkey}`,
      content: String(event.content ?? ""),
      meta: { nostr: { pubkey: event.pubkey, created_at: event.created_at } },
      createdAt: toIsoFromNostr(event.created_at)
    };
  }

  _handleEvent(event) {
    if (!event?.id || this.seenIds.has(event.id)) return;
    this.seenIds.add(event.id);
    // Cap memory growth.
    if (this.seenIds.size > 50_000) {
      this.seenIds = new Set(Array.from(this.seenIds).slice(-25_000));
    }

    const msg = this._eventToMessage(event);
    if (!msg) return;

    this.state.appendMessage(msg.roomId, msg);
    this.messageStore?.append({ roomId: msg.roomId, entry: msg }).catch(() => {});
    this.broadcastToRoom(msg.roomId, { type: "message", message: msg });

    const since = Math.max(this._roomSince(msg.roomId), Number(event.created_at) || 0);
    this._setRoomSince(msg.roomId, since).catch(() => {});
  }

  subscribeRoom(roomId) {
    if (!this.enabled()) return;
    const existing = this.subs.get(roomId);
    if (existing) {
      existing.refCount += 1;
      return;
    }

    const since = this._roomSince(roomId);
    const closer = this.pool.subscribeMany(this.relays, { kinds: [1], "#t": ["talktome"], "#d": [roomId], since }, {
      alreadyHaveEvent: (id) => this.seenIds.has(id),
      onevent: (evt) => {
        if (!validateEvent(evt)) return;
        if (!verifyEvent(evt)) return;
        this._handleEvent(evt);
      }
    });

    this.subs.set(roomId, { closer, refCount: 1 });
  }

  unsubscribeRoom(roomId) {
    const existing = this.subs.get(roomId);
    if (!existing) return;
    existing.refCount -= 1;
    if (existing.refCount > 0) return;
    try {
      existing.closer?.close?.("room_unsubscribed");
    } catch {
      // ignore
    }
    this.subs.delete(roomId);
  }

  async publishEvent(event) {
    if (!this.enabled()) throw new Error("nostr_disabled");
    if (!validateEvent(event)) throw new Error("invalid_event");
    if (!verifyEvent(event)) throw new Error("bad_signature");
    if (event.kind !== 1) throw new Error("only_kind_1_supported");
    if (!hasTag(event.tags, "t", "talktome")) throw new Error("missing_talktome_tag");
    const roomId = getTagValue(event.tags, "d");
    if (!roomId) throw new Error("missing_room_tag");

    // Publish best-effort; still process locally.
    this.pool.publish(this.relays, event);
    this._handleEvent(event);
    return { ok: true, roomId };
  }

  async queryRoom(roomId, { limit }) {
    if (!this.enabled()) throw new Error("nostr_disabled");
    const n = Number.parseInt(String(limit ?? "50"), 10);
    const lim = Number.isFinite(n) ? Math.max(1, Math.min(200, n)) : 50;
    const events = await this.pool.querySync(this.relays, { kinds: [1], "#t": ["talktome"], "#d": [roomId], limit: lim });
    const messages = [];
    for (const evt of events) {
      if (!validateEvent(evt)) continue;
      if (!verifyEvent(evt)) continue;
      const msg = this._eventToMessage(evt);
      if (msg) messages.push(msg);
    }
    messages.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    return messages.slice(-lim);
  }
}
