import { makeId, nowIso } from "./protocol.js";

export const LOBBY_ROOM_ID = "lobby";

function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  return tags
    .map((t) => String(t).trim())
    .filter(Boolean)
    .slice(0, 20);
}

function createRoomState({ maxMessages }) {
  return {
    maxMessages,
    messages: [],
    clients: new Set(),
    agents: new Map()
  };
}

export class HubState {
  constructor({ maxMessagesPerRoom }) {
    this.maxMessagesPerRoom = maxMessagesPerRoom;
    /** @type {Map<string, ReturnType<typeof createRoomState>>} */
    this.rooms = new Map();
    /** @type {Map<string, any>} */
    this.issues = new Map();
  }

  upsertIssue(issue) {
    if (!issue?.id || !issue?.roomId) return;
    this.issues.set(issue.id, issue);
    this.getOrCreateRoom(issue.roomId);
  }

  getOrCreateRoom(roomId) {
    let room = this.rooms.get(roomId);
    if (!room) {
      room = createRoomState({ maxMessages: this.maxMessagesPerRoom });
      this.rooms.set(roomId, room);
    }
    return room;
  }

  listRooms() {
    return [...this.rooms.entries()].map(([roomId, room]) => ({
      roomId,
      connected: room.clients.size,
      agents: room.agents.size,
      messages: room.messages.length
    }));
  }

  appendMessage(roomId, message) {
    const room = this.getOrCreateRoom(roomId);
    room.messages.push(message);
    if (room.messages.length > room.maxMessages) {
      room.messages.splice(0, room.messages.length - room.maxMessages);
    }
  }

  getIssue(issueId) {
    return this.issues.get(issueId) ?? null;
  }

  issueRoomId(issueId) {
    return `issue:${issueId}`;
  }

  listIssues({ status } = {}) {
    const all = [...this.issues.values()];
    const filtered =
      status && status !== "all" ? all.filter((i) => i.status === status) : all;
    filtered.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return filtered;
  }

  exportIssues() {
    return [...this.issues.values()];
  }

  createIssue({ id, title, description, tags, meta, openedBy, bounty, fee }) {
    const issueId = id ?? makeId();
    const issue = {
      v: 1,
      kind: "issue",
      id: issueId,
      roomId: this.issueRoomId(issueId),
      status: "open",
      title: String(title ?? ""),
      description: String(description ?? ""),
      tags: normalizeTags(tags),
      meta: meta ?? null,
      openedBy: openedBy ? String(openedBy) : null,
      bounty: Number.isFinite(Number(bounty)) ? Number.parseInt(String(bounty), 10) : 0,
      fee: Number.isFinite(Number(fee)) ? Number.parseInt(String(fee), 10) : 0,
      claims: [],
      solver: null,
      createdAt: nowIso(),
      closedAt: null,
      closedBy: null,
      resolution: null
    };

    this.upsertIssue(issue);

    const openedEvent = this.makeEvent({
      roomId: LOBBY_ROOM_ID,
      type: "issue:opened",
      detail: { issue }
    });
    this.appendMessage(LOBBY_ROOM_ID, openedEvent);

    const openedInIssue = this.makeEvent({
      roomId: issue.roomId,
      type: "issue:opened",
      detail: { issue }
    });
    this.appendMessage(issue.roomId, openedInIssue);

    return { issue, openedEvent, openedInIssue };
  }

  addClaim(issueId, { pubkey }) {
    const issue = this.getIssue(issueId);
    if (!issue) return null;
    if (issue.status !== "open") return { issue, added: false, reason: "issue_closed" };
    const p = String(pubkey ?? "").trim();
    if (!p) return { issue, added: false, reason: "invalid_pubkey" };
    const exists = Array.isArray(issue.claims) && issue.claims.some((c) => c?.pubkey === p);
    if (exists) return { issue, added: false, reason: "already_claimed" };
    if (!Array.isArray(issue.claims)) issue.claims = [];
    issue.claims.push({ pubkey: p, createdAt: nowIso() });
    return { issue, added: true, reason: null };
  }

  closeIssue(issueId, { closedBy, resolution } = {}) {
    const issue = this.getIssue(issueId);
    if (!issue) return null;
    if (issue.status === "closed") {
      return { issue, alreadyClosed: true, closedEvent: null, closedInIssue: null };
    }

    issue.status = "closed";
    issue.closedAt = nowIso();
    issue.closedBy = closedBy ? String(closedBy) : null;
    issue.resolution = resolution ? String(resolution) : null;

    const closedEvent = this.makeEvent({
      roomId: LOBBY_ROOM_ID,
      type: "issue:closed",
      detail: { issueId: issue.id, issue }
    });
    this.appendMessage(LOBBY_ROOM_ID, closedEvent);

    const closedInIssue = this.makeEvent({
      roomId: issue.roomId,
      type: "issue:closed",
      detail: { issueId: issue.id, issue }
    });
    this.appendMessage(issue.roomId, closedInIssue);

    return { issue, alreadyClosed: false, closedEvent, closedInIssue };
  }

  makeChatMessage({ roomId, agentId, content, meta }) {
    return {
      v: 1,
      id: makeId(),
      kind: "chat",
      roomId,
      agentId,
      content: String(content ?? ""),
      meta: meta ?? null,
      createdAt: nowIso()
    };
  }

  makeEvent({ roomId, type, detail }) {
    return {
      v: 1,
      id: makeId(),
      kind: "event",
      roomId,
      type,
      detail: detail ?? null,
      createdAt: nowIso()
    };
  }
}
