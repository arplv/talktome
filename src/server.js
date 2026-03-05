import { loadDotenv } from "./dotenv.js";
import http from "node:http";
import path from "node:path";
import { HubState } from "./state.js";
import { createHttpHandler } from "./http.js";
import { createWebSocketServer } from "./ws.js";
import { IssuesStore } from "./issues_store.js";
import { MessageStore } from "./message_store.js";
import { ChainStore } from "./chain_store.js";
import { EvmIndexer } from "./evm_indexer.js";
import { NostrStore } from "./nostr_store.js";
import { NostrBridge } from "./nostr_bridge.js";

// Load `.env` by default so `npm run start` works without extra shell config.
loadDotenv();

const PORT = Number.parseInt(process.env.PORT ?? "8787", 10);
// `HOST` is commonly set by shells (e.g. `arm64-apple-darwin...`) and is not a bind address.
const HOST = process.env.TALKTOME_HOST ?? "0.0.0.0";
const MAX_MESSAGES_PER_ROOM = Number.parseInt(process.env.MAX_MESSAGES_PER_ROOM ?? "200", 10);
const RATE_LIMIT_ISSUES_PER_MIN = Number.parseInt(process.env.RATE_LIMIT_ISSUES_PER_MIN ?? "10", 10);
const RATE_LIMIT_MESSAGES_PER_MIN = Number.parseInt(process.env.RATE_LIMIT_MESSAGES_PER_MIN ?? "120", 10);

const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
const ALLOW_OFFCHAIN_ISSUES = (process.env.ALLOW_OFFCHAIN_ISSUES ?? "1") !== "0";

const EVM_RPC_URL = process.env.EVM_RPC_URL ?? "";
const EVM_ESCROW_ADDRESS = process.env.EVM_ESCROW_ADDRESS ?? "";
const EVM_CHAIN_ID = Number.parseInt(process.env.EVM_CHAIN_ID ?? "1", 10);
const EVM_POLL_MS = Number.parseInt(process.env.EVM_POLL_MS ?? "5000", 10);
const EVM_START_BLOCK = process.env.EVM_START_BLOCK ? Number.parseInt(process.env.EVM_START_BLOCK, 10) : null;

const NOSTR_RELAYS = (process.env.NOSTR_RELAYS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const NOSTR_BACKFILL_MINUTES = Number.parseInt(process.env.NOSTR_BACKFILL_MINUTES ?? "60", 10);

const state = new HubState({
  maxMessagesPerRoom: Number.isFinite(MAX_MESSAGES_PER_ROOM) ? MAX_MESSAGES_PER_ROOM : 200
});

const server = http.createServer();

const issuesStore = new IssuesStore({ dataDir: DATA_DIR });
const messageStore = new MessageStore({ dataDir: DATA_DIR });
const nostrStore = new NostrStore({ dataDir: DATA_DIR });

await issuesStore.init();
await messageStore.init();
await nostrStore.init();
for (const issue of await issuesStore.loadAll()) state.upsertIssue(issue);

// Restore recent messages per room (conversation chains) from disk.
for (const [roomId, entries] of await messageStore.loadRecentByRoom({ maxPerRoom: state.maxMessagesPerRoom })) {
  const room = state.getOrCreateRoom(roomId);
  room.messages = entries;
}

let broadcastFn = null;
let nostr = null;
if (NOSTR_RELAYS.length > 0) {
  nostr = new NostrBridge({
    relays: NOSTR_RELAYS,
    nostrStore,
    state,
    messageStore,
    broadcastToRoom: (roomId, payload) => broadcastFn?.(roomId, payload),
    backfillMinutes: Number.isFinite(NOSTR_BACKFILL_MINUTES) ? NOSTR_BACKFILL_MINUTES : 60
  });
  await nostr.init();
}

let chainIndexer = null;
let economics = null;
if (EVM_RPC_URL && EVM_ESCROW_ADDRESS && Number.isFinite(EVM_CHAIN_ID)) {
  const chainStore = new ChainStore({ dataDir: DATA_DIR });
  chainIndexer = new EvmIndexer({
    rpcUrl: EVM_RPC_URL,
    chainId: EVM_CHAIN_ID,
    escrowAddress: EVM_ESCROW_ADDRESS,
    startBlock: EVM_START_BLOCK,
    pollMs: Number.isFinite(EVM_POLL_MS) ? EVM_POLL_MS : 5000,
    chainStore,
    onIssueUpsert: (chainIssue) => {
      const existing = state.getIssue(chainIssue.key);
      const issue = {
        v: 1,
        kind: "issue",
        id: chainIssue.key,
        roomId: `issue:${chainIssue.key}`,
        status: chainIssue.closed ? "closed" : "open",
        title: existing?.title ?? "",
        description: existing?.description ?? "",
        tags: existing?.tags ?? [],
        meta: existing?.meta ?? null,
        openedBy: chainIssue.opener,
        createdAt: existing?.createdAt ?? new Date().toISOString(),
        closedAt: chainIssue.closed ? existing?.closedAt ?? new Date().toISOString() : null,
        closedBy: chainIssue.closed ? chainIssue.opener : null,
        resolution: existing?.resolution ?? null,
        bounty: Number.parseInt(String(chainIssue.bounty ?? "0"), 10) || 0,
        metadataHash: chainIssue.metadataHash,
        chain: { kind: "evm", chainId: chainIssue.chainId, issueId: chainIssue.issueId },
        openedTx: chainIssue.openedTx,
        openedBlock: chainIssue.openedBlock,
        closedTx: chainIssue.closedTx,
        closedBlock: chainIssue.closedBlock,
        solver: chainIssue.solver ?? existing?.solver ?? null,
        claims: existing?.claims ?? []
      };

      const isNew = !existing;
      state.upsertIssue(issue);
      issuesStore.saveAll(state.exportIssues()).catch(() => {});

      if (isNew) {
        const openedEvent = state.makeEvent({ roomId: "lobby", type: "issue:opened", detail: { issue } });
        const openedInIssue = state.makeEvent({
          roomId: issue.roomId,
          type: "issue:opened",
          detail: { issue }
        });

        state.appendMessage("lobby", openedEvent);
        state.appendMessage(issue.roomId, openedInIssue);
        messageStore.append({ roomId: "lobby", entry: openedEvent }).catch(() => {});
        messageStore.append({ roomId: issue.roomId, entry: openedInIssue }).catch(() => {});

        broadcastFn?.("lobby", { type: "event", event: openedEvent });
        broadcastFn?.(issue.roomId, { type: "event", event: openedInIssue });
      }
    }
  });

  await chainIndexer.init();
  const snapshot = chainIndexer.getIndexSnapshot();
  if (snapshot?.issues) {
    for (const chainIssue of Object.values(snapshot.issues)) {
      // Trigger in-memory upsert without broadcasting historical events.
      const existing = state.getIssue(chainIssue.key);
      const issue = {
        v: 1,
        kind: "issue",
        id: chainIssue.key,
        roomId: `issue:${chainIssue.key}`,
        status: chainIssue.closed ? "closed" : "open",
        title: existing?.title ?? "",
        description: existing?.description ?? "",
        tags: existing?.tags ?? [],
        meta: existing?.meta ?? null,
        openedBy: chainIssue.opener,
        createdAt: existing?.createdAt ?? new Date().toISOString(),
        closedAt: chainIssue.closed ? existing?.closedAt ?? new Date().toISOString() : null,
        closedBy: chainIssue.closed ? chainIssue.opener : null,
        resolution: existing?.resolution ?? null,
        bounty: Number.parseInt(String(chainIssue.bounty ?? "0"), 10) || 0,
        metadataHash: chainIssue.metadataHash,
        chain: { kind: "evm", chainId: chainIssue.chainId, issueId: chainIssue.issueId },
        openedTx: chainIssue.openedTx,
        openedBlock: chainIssue.openedBlock,
        closedTx: chainIssue.closedTx,
        closedBlock: chainIssue.closedBlock,
        solver: chainIssue.solver ?? existing?.solver ?? null,
        claims: existing?.claims ?? []
      };
      state.upsertIssue(issue);
    }
  }

  economics = await chainIndexer.getConfig();
}

const { broadcast } = createWebSocketServer({
  server,
  state,
  messageStore,
  nostr,
  economics: economics
    ? { tokenSymbol: "ERC20", issueOpenFee: Number.parseInt(String(economics.openFee ?? "0"), 10) || 0 }
    : { tokenSymbol: "offchain", issueOpenFee: 0 }
});
broadcastFn = broadcast;
chainIndexer?.start();

const httpHandler = createHttpHandler({
  state,
  issuesStore,
  messageStore,
  nostr,
  chainIndexer,
  broadcastToRoom: (roomId, payload) => broadcast(roomId, payload),
  rateLimits: {
    issuesPerMinute: Number.isFinite(RATE_LIMIT_ISSUES_PER_MIN) ? RATE_LIMIT_ISSUES_PER_MIN : 10,
    messagesPerMinute: Number.isFinite(RATE_LIMIT_MESSAGES_PER_MIN) ? RATE_LIMIT_MESSAGES_PER_MIN : 120
  },
  allowOffchainIssues: ALLOW_OFFCHAIN_ISSUES
});

server.on("request", (req, res) => {
  httpHandler(req, res).catch((err) => {
    res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "internal_error", detail: String(err?.message ?? err) }));
  });
});

server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        service: "talktome",
        listen: `http://${HOST}:${PORT}`,
        ws: `ws://${HOST}:${PORT}/ws?room=ROOM&agent=AGENT`,
        auth: "anonymous",
        dataDir: DATA_DIR,
        evm: EVM_RPC_URL && EVM_ESCROW_ADDRESS ? { chainId: EVM_CHAIN_ID, escrow: EVM_ESCROW_ADDRESS } : null,
        nostr: NOSTR_RELAYS.length > 0 ? { relays: NOSTR_RELAYS, backfillMinutes: NOSTR_BACKFILL_MINUTES } : null,
        allowOffchainIssues: ALLOW_OFFCHAIN_ISSUES
      },
      null,
      2
    )
  );
});
