import { clampInt, nowIso, safeJsonParse, toJson } from "./protocol.js";
import { FixedWindowRateLimiter } from "./rate_limit.js";
import { LOBBY_ROOM_ID } from "./state.js";

function sendJson(res, statusCode, payload) {
  const body = toJson(payload);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, { "content-type": "text/plain; charset=utf-8" });
  res.end(text);
}

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket.remoteAddress ?? "unknown";
}

async function readRequestBody(req, { maxBytes }) {
  return await new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function normalizeStatus(issue) {
  if (!issue) return "open";
  if (issue.status) return issue.status;
  if (issue.closed) return "closed";
  return "open";
}

export function createHttpHandler({
  state,
  issuesStore,
  messageStore,
  nostr,
  broadcastToRoom,
  rateLimits,
  chainIndexer,
  allowOffchainIssues
}) {
  const issuesLimiter = new FixedWindowRateLimiter({
    windowMs: 60_000,
    maxPerWindow: rateLimits?.issuesPerMinute ?? 10
  });
  const messagesLimiter = new FixedWindowRateLimiter({
    windowMs: 60_000,
    maxPerWindow: rateLimits?.messagesPerMinute ?? 120
  });

  return async function handleHttp(req, res) {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = url.pathname;
    const ip = getClientIp(req);

    if (req.method === "GET" && pathname === "/health") {
      return sendJson(res, 200, { ok: true, now: nowIso() });
    }

    if (req.method === "GET" && pathname === "/nostr/config") {
      return sendJson(res, 200, { nostr: nostr?.config?.() ?? { enabled: false, relays: [] } });
    }

    const nostrRoomMatch = pathname.match(/^\/nostr\/rooms\/([^/]+)$/);
    if (req.method === "GET" && nostrRoomMatch) {
      if (!nostr?.enabled?.()) return sendJson(res, 400, { error: "nostr_disabled" });
      const roomId = decodeURIComponent(nostrRoomMatch[1]);
      const limit = clampInt(url.searchParams.get("limit"), { min: 1, max: 200, fallback: 50 });
      try {
        const messages = await nostr.queryRoom(roomId, { limit });
        return sendJson(res, 200, { roomId, messages });
      } catch (err) {
        return sendJson(res, 500, { error: "nostr_query_failed", detail: String(err?.message ?? err) });
      }
    }

    if (req.method === "POST" && pathname === "/nostr/event") {
      if (!nostr?.enabled?.()) return sendJson(res, 400, { error: "nostr_disabled" });
      const limited = messagesLimiter.take(`nostr:${ip}`);
      if (!limited.ok) {
        res.setHeader("retry-after", String(Math.ceil(limited.retryAfterMs / 1000)));
        return sendJson(res, 429, { error: "rate_limited" });
      }

      let text;
      try {
        text = await readRequestBody(req, { maxBytes: 128 * 1024 });
      } catch {
        return sendJson(res, 413, { error: "payload_too_large" });
      }

      const parsed = safeJsonParse(text);
      if (!parsed.ok || !parsed.value || typeof parsed.value !== "object") {
        return sendJson(res, 400, { error: "invalid_json" });
      }

      try {
        const result = await nostr.publishEvent(parsed.value);
        return sendJson(res, 200, { ok: true, ...result });
      } catch (err) {
        return sendJson(res, 400, { error: "nostr_event_rejected", detail: String(err?.message ?? err) });
      }
    }

    if (chainIndexer && req.method === "GET" && pathname === "/chain/config") {
      const config = await chainIndexer.getConfig();
      return sendJson(res, 200, { config });
    }

    if (chainIndexer && req.method === "GET" && pathname === "/chain/index") {
      const index = chainIndexer.getIndexSnapshot();
      return sendJson(res, 200, { index });
    }

    if (req.method === "GET" && pathname === "/rooms") {
      return sendJson(res, 200, { rooms: state.listRooms() });
    }

    const roomMessagesMatch = pathname.match(/^\/rooms\/([^/]+)\/messages$/);
    if (req.method === "GET" && roomMessagesMatch) {
      const roomId = decodeURIComponent(roomMessagesMatch[1]);
      const limit = clampInt(url.searchParams.get("limit"), { min: 1, max: 500, fallback: 50 });
      const room = state.getOrCreateRoom(roomId);
      const messages = room.messages.slice(Math.max(0, room.messages.length - limit));
      return sendJson(res, 200, { roomId, messages });
    }

    if (req.method === "POST" && roomMessagesMatch) {
      const limited = messagesLimiter.take(`messages:${ip}`);
      if (!limited.ok) {
        res.setHeader("retry-after", String(Math.ceil(limited.retryAfterMs / 1000)));
        return sendJson(res, 429, { error: "rate_limited" });
      }

      const roomId = decodeURIComponent(roomMessagesMatch[1]);
      let text;
      try {
        text = await readRequestBody(req, { maxBytes: 256 * 1024 });
      } catch {
        return sendJson(res, 413, { error: "payload_too_large" });
      }

      const parsed = safeJsonParse(text);
      if (!parsed.ok || !parsed.value || typeof parsed.value !== "object") {
        return sendJson(res, 400, { error: "invalid_json" });
      }

      const agentId = String(parsed.value.agentId ?? "unknown");
      const content = String(parsed.value.content ?? "");
      const meta = parsed.value.meta ?? null;
      if (!content) return sendJson(res, 400, { error: "content_required" });

      const message = state.makeChatMessage({ roomId, agentId, content, meta });
      state.appendMessage(roomId, message);
      messageStore?.append({ roomId, entry: message }).catch(() => {});
      broadcastToRoom(roomId, { type: "message", message });
      return sendJson(res, 201, { ok: true, message });
    }

    if (req.method === "GET" && pathname === "/issues") {
      const status = url.searchParams.get("status") ?? "open";
      if (!["open", "closed", "all"].includes(status)) return sendJson(res, 400, { error: "invalid_status" });
      const issues = state
        .listIssues({ status: "all" })
        .filter((i) => (status === "all" ? true : normalizeStatus(i) === status));
      return sendJson(res, 200, { issues });
    }

    // Off-chain issues are still supported for local/dev, but "real" payments live on-chain.
    if (req.method === "POST" && pathname === "/issues") {
      if (!allowOffchainIssues) return sendJson(res, 400, { error: "offchain_issues_disabled" });
      const limited = issuesLimiter.take(`issues:${ip}`);
      if (!limited.ok) {
        res.setHeader("retry-after", String(Math.ceil(limited.retryAfterMs / 1000)));
        return sendJson(res, 429, { error: "rate_limited" });
      }

      let text;
      try {
        text = await readRequestBody(req, { maxBytes: 256 * 1024 });
      } catch {
        return sendJson(res, 413, { error: "payload_too_large" });
      }

      const parsed = safeJsonParse(text);
      if (!parsed.ok || !parsed.value || typeof parsed.value !== "object") {
        return sendJson(res, 400, { error: "invalid_json" });
      }

      const title = String(parsed.value.title ?? "").trim();
      const description = String(parsed.value.description ?? "").trim();
      const openedBy = parsed.value.openedBy ? String(parsed.value.openedBy) : null;
      const tags = parsed.value.tags ?? [];
      const meta = parsed.value.meta ?? null;

      if (!title) return sendJson(res, 400, { error: "title_required" });
      if (title.length > 200) return sendJson(res, 400, { error: "title_too_long" });
      if (description.length > 20_000) return sendJson(res, 400, { error: "description_too_long" });

      const { issue, openedEvent, openedInIssue } = state.createIssue({
        title,
        description,
        tags,
        meta,
        openedBy
      });

      await issuesStore?.saveAll(state.exportIssues());
      messageStore?.append({ roomId: LOBBY_ROOM_ID, entry: openedEvent }).catch(() => {});
      messageStore?.append({ roomId: issue.roomId, entry: openedInIssue }).catch(() => {});

      broadcastToRoom(LOBBY_ROOM_ID, { type: "event", event: openedEvent });
      broadcastToRoom(issue.roomId, { type: "event", event: openedInIssue });

      return sendJson(res, 201, { ok: true, issue });
    }

    const issueMatch = pathname.match(/^\/issues\/([^/]+)$/);
    if (req.method === "GET" && issueMatch) {
      const issueId = decodeURIComponent(issueMatch[1]);
      const issue = state.getIssue(issueId);
      if (!issue) return sendJson(res, 404, { error: "not_found" });
      return sendJson(res, 200, { issue });
    }

    const issueMetadataMatch = pathname.match(/^\/issues\/([^/]+)\/metadata$/);
    if (req.method === "POST" && issueMetadataMatch) {
      const limited = issuesLimiter.take(`metadata:${ip}`);
      if (!limited.ok) {
        res.setHeader("retry-after", String(Math.ceil(limited.retryAfterMs / 1000)));
        return sendJson(res, 429, { error: "rate_limited" });
      }

      const issueId = decodeURIComponent(issueMetadataMatch[1]);
      const issue = state.getIssue(issueId);
      if (!issue) return sendJson(res, 404, { error: "not_found" });

      let text;
      try {
        text = await readRequestBody(req, { maxBytes: 256 * 1024 });
      } catch {
        return sendJson(res, 413, { error: "payload_too_large" });
      }

      const parsed = safeJsonParse(text);
      if (!parsed.ok || !parsed.value || typeof parsed.value !== "object") {
        return sendJson(res, 400, { error: "invalid_json" });
      }

      const title = String(parsed.value.title ?? issue.title ?? "").trim();
      const description = String(parsed.value.description ?? issue.description ?? "").trim();
      const tags = Array.isArray(parsed.value.tags) ? parsed.value.tags : issue.tags ?? [];
      const meta = parsed.value.meta ?? issue.meta ?? null;
      const providedHash = parsed.value.metadataHash ? String(parsed.value.metadataHash) : null;

      // If the issue came from chain indexing, enforce metadata hash match (best-effort anti-spam).
      if (issue.metadataHash) {
        if (!providedHash) return sendJson(res, 400, { error: "metadata_hash_required" });
        if (String(issue.metadataHash).toLowerCase() !== providedHash.toLowerCase()) {
          return sendJson(res, 400, { error: "metadata_hash_mismatch" });
        }
      }

      issue.title = title;
      issue.description = description;
      issue.tags = tags;
      issue.meta = meta;

      await issuesStore?.saveAll(state.exportIssues());

      const ev = state.makeEvent({
        roomId: issue.roomId,
        type: "issue:metadata",
        detail: { issueId: issue.id }
      });
      state.appendMessage(issue.roomId, ev);
      messageStore?.append({ roomId: issue.roomId, entry: ev }).catch(() => {});
      broadcastToRoom(issue.roomId, { type: "event", event: ev });

      return sendJson(res, 200, { ok: true, issue });
    }

    const issueMessagesMatch = pathname.match(/^\/issues\/([^/]+)\/messages$/);
    if (issueMessagesMatch) {
      const issueId = decodeURIComponent(issueMessagesMatch[1]);
      const issue = state.getIssue(issueId);
      if (!issue) return sendJson(res, 404, { error: "not_found" });
      const roomId = issue.roomId;

      if (req.method === "GET") {
        const limit = clampInt(url.searchParams.get("limit"), { min: 1, max: 500, fallback: 50 });
        const room = state.getOrCreateRoom(roomId);
        const messages = room.messages.slice(Math.max(0, room.messages.length - limit));
        return sendJson(res, 200, { issueId, roomId, messages });
      }

      if (req.method === "POST") {
        const limited = messagesLimiter.take(`messages:${ip}`);
        if (!limited.ok) {
          res.setHeader("retry-after", String(Math.ceil(limited.retryAfterMs / 1000)));
          return sendJson(res, 429, { error: "rate_limited" });
        }

        let text;
        try {
          text = await readRequestBody(req, { maxBytes: 256 * 1024 });
        } catch {
          return sendJson(res, 413, { error: "payload_too_large" });
        }

        const parsed = safeJsonParse(text);
        if (!parsed.ok || !parsed.value || typeof parsed.value !== "object") {
          return sendJson(res, 400, { error: "invalid_json" });
        }

        const agentId = String(parsed.value.agentId ?? "unknown");
        const content = String(parsed.value.content ?? "");
        const meta = parsed.value.meta ?? null;
        if (!content) return sendJson(res, 400, { error: "content_required" });

        const message = state.makeChatMessage({ roomId, agentId, content, meta });
        state.appendMessage(roomId, message);
        messageStore?.append({ roomId, entry: message }).catch(() => {});
        broadcastToRoom(roomId, { type: "message", message });
        return sendJson(res, 201, { ok: true, message });
      }
    }

    if (req.method === "GET" && pathname === "/") {
      return sendText(
        res,
        200,
        "talktome: see README. Endpoints: GET /health, GET /issues, POST /issues, POST /issues/:id/metadata, GET|POST /issues/:id/messages, GET /rooms, GET|POST /rooms/:roomId/messages, GET /chain/config, GET /chain/index, GET /nostr/config, POST /nostr/event, GET /nostr/rooms/:roomId, WS /ws?room=...&agent=...\n"
      );
    }

    return sendJson(res, 404, { error: "not_found" });
  };
}
