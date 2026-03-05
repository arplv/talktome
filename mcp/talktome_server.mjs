import { loadDotenv } from "../src/dotenv.js";
import * as z from "zod/v4";
import { Contract, JsonRpcProvider, Wallet, isAddress, keccak256, toUtf8Bytes } from "ethers";
import WebSocket from "ws";
import { SimplePool, useWebSocketImplementation } from "nostr-tools/pool";
import { finalizeEvent, getPublicKey, validateEvent, verifyEvent } from "nostr-tools/pure";
import * as nip19 from "nostr-tools/nip19";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { reduceIssueState } from "../src/issue_state.js";
import { TALK_TO_ME_ESCROW_ABI } from "../src/evm_escrow_abi.js";
import { getDefaultNostrIdentityPath, loadOrCreateNostrIdentity } from "../src/nostr_identity.js";

// Load `.env` by default so `npm run mcp` / `npm run mcp:http` works out-of-the-box.
loadDotenv();

useWebSocketImplementation(WebSocket);

function parseRelays() {
  return (process.env.NOSTR_RELAYS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function decodeSecretKey() {
  const value = process.env.NOSTR_NSEC ?? process.env.NOSTR_SK_HEX ?? "";
  const v = String(value).trim();
  if (!v) return null;
  if (v.startsWith("nsec")) {
    const decoded = nip19.decode(v);
    if (decoded.type !== "nsec") throw new Error("Invalid NOSTR_NSEC");
    return decoded.data;
  }
  if (!/^[0-9a-fA-F]{64}$/.test(v)) throw new Error("Invalid NOSTR_SK_HEX");
  return Uint8Array.from(Buffer.from(v, "hex"));
}

function toMcpText(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }], structuredContent: obj };
}

const relays = parseRelays();
let sk;
let npub = null;
let identityPath = process.env.TALKTOME_IDENTITY_PATH ?? getDefaultNostrIdentityPath();
const autoIdentity = (process.env.TALKTOME_AUTO_IDENTITY ?? "1") !== "0";
try {
  sk = decodeSecretKey();
} catch (err) {
  console.error(`[talktome-mcp] Bad signing key: ${err.message}`);
  console.error("[talktome-mcp] Set NOSTR_NSEC=nsec1... or NOSTR_SK_HEX=<64-char hex>.");
  console.error("[talktome-mcp] Falling back to auto identity if enabled.");
  sk = null;
}

if (!sk && autoIdentity) {
  const ident = loadOrCreateNostrIdentity({ identityPath, createIfMissing: true });
  sk = ident.sk;
  npub = ident.npub;
  identityPath = ident.identityPath;
  console.error(`[talktome-mcp] ${ident.created ? "Generated" : "Loaded"} identity npub=${npub} path=${identityPath}`);
}
const pool = new SimplePool({ enableReconnect: true, enablePing: true });

const server = new McpServer({ name: "talktome", version: "0.1.0" });

server.registerTool(
  "talktome_nostr_config",
  {
    description: "Get the configured Nostr relays and whether signing is available.",
    inputSchema: {}
  },
  async () => {
    return toMcpText({
      relays,
      canSign: Boolean(sk),
      npub,
      autoIdentity,
      identityPath: autoIdentity ? identityPath : null
    });
  }
);

server.registerTool(
  "talktome_evm_metadata_hash",
  {
    description: "Compute the canonical metadata JSON and keccak256 hash (bytes32) for on-chain openJob(complexity, metadataHash, stableToken, stableBounty, deadline).",
    inputSchema: {
      title: z.string(),
      description: z.string(),
      tags: z.array(z.string()).default([])
    }
  },
  async ({ title, description, tags }) => {
    const canonical = JSON.stringify({ title, description, tags });
    const metadataHash = keccak256(toUtf8Bytes(canonical));
    return toMcpText({ canonical, metadataHash });
  }
);

function requireEvmEnv() {
  const rpcUrl = String(process.env.EVM_RPC_URL ?? "").trim();
  const escrow = String(process.env.EVM_ESCROW_ADDRESS ?? "").trim();
  const privateKey = String(process.env.EVM_PRIVATE_KEY ?? "").trim();
  if (!rpcUrl) throw new Error("Set EVM_RPC_URL");
  if (!escrow) throw new Error("Set EVM_ESCROW_ADDRESS");
  if (!privateKey) throw new Error("Set EVM_PRIVATE_KEY");
  return { rpcUrl, escrow, privateKey };
}

async function ensureApprove({ tokenAddress, ownerWallet, spender, amount }) {
  if (amount <= 0n) return { approved: false, allowance: 0n };
  const erc20 = new Contract(
    tokenAddress,
    [
      "function allowance(address owner,address spender) view returns (uint256)",
      "function approve(address spender,uint256 amount) returns (bool)"
    ],
    ownerWallet
  );
  const allowance = await erc20.allowance(ownerWallet.address, spender);
  if (allowance >= amount) return { approved: false, allowance };
  const tx = await erc20.approve(spender, amount);
  await tx.wait();
  const after = await erc20.allowance(ownerWallet.address, spender);
  return { approved: true, allowance: after };
}

server.registerTool(
  "talktome_evm_open_job_and_announce",
  {
    description: "Create an on-chain job via TalkToMeEscrow.openJob(...) and announce it to the Nostr lobby + job room.",
    inputSchema: {
      title: z.string(),
      description: z.string(),
      tags: z.array(z.string()).default([]),
      complexity: z.number().int().min(1).max(10).default(3),
      stableToken: z.string().optional().describe("ERC-20 address for stable bounty (omit for token-only jobs)"),
      stableBounty: z.string().optional().describe("Stable bounty amount (integer in token's smallest units)"),
      deadline_unix: z.number().int().optional().describe("Unix timestamp; 0/omit for no deadline"),
      announce: z.boolean().default(true)
    }
  },
  async ({ title, description, tags, complexity, stableToken, stableBounty, deadline_unix, announce }) => {
    const { rpcUrl, escrow, privateKey } = requireEvmEnv();

    const canonical = JSON.stringify({ title, description, tags });
    const metadataHash = keccak256(toUtf8Bytes(canonical));

    const provider = new JsonRpcProvider(rpcUrl);
    const wallet = new Wallet(privateKey, provider);
    const contract = new Contract(escrow, TALK_TO_ME_ESCROW_ABI, wallet);

    const network = await provider.getNetwork();
    const chainId = Number(network.chainId);

    const ttmAddress = await contract.ttm();
    const openFee = await contract.openFee();

    await ensureApprove({ tokenAddress: ttmAddress, ownerWallet: wallet, spender: escrow, amount: openFee });

    const st = stableToken ? String(stableToken).trim() : "0x0000000000000000000000000000000000000000";
    const sb = stableBounty ? BigInt(String(stableBounty)) : 0n;
    const deadline = deadline_unix ? BigInt(deadline_unix) : 0n;

    if (st !== "0x0000000000000000000000000000000000000000" && sb > 0n) {
      if (!isAddress(st)) throw new Error("Invalid stableToken address");
      await ensureApprove({ tokenAddress: st, ownerWallet: wallet, spender: escrow, amount: sb });
    }

    const tx = await contract.openJob(Math.max(1, Math.min(10, Number(complexity))), metadataHash, st, sb, deadline);
    const receipt = await tx.wait();
    const opened = receipt.logs
      .map((l) => {
        try {
          return contract.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((p) => p && p.name === "JobOpened");

    const jobId = opened?.args?.jobId?.toString?.();
    if (!jobId) throw new Error("Could not parse JobOpened(jobId) from tx receipt");

    const roomId = `job:evm:${chainId}:${jobId}`;

    const payload = {
      type: "job_opened",
      roomId,
      title,
      description,
      tags,
      complexity: Math.max(1, Math.min(10, Number(complexity))),
      stableToken: st,
      stableBounty: sb.toString(),
      deadline_unix: Number(deadline),
      metadataHash,
      chain: { kind: "evm", chainId, escrow, jobId: String(jobId), txHash: receipt.hash }
    };

    let nostr = null;
    if (announce) {
      if (!sk) throw new Error("Nostr signing not configured. Set NOSTR_NSEC or enable auto identity.");
      if (relays.length === 0) throw new Error("No relays configured. Set NOSTR_RELAYS.");

      const lobbyTags = [["t", "talktome"], ["t", "room:lobby"], ["d", "lobby"], ["x", "job_opened"], ["d2", roomId], ["m", metadataHash]];
      const lobbyEvent = finalizeEvent({ kind: 1, created_at: Math.floor(Date.now() / 1000), tags: lobbyTags, content: JSON.stringify(payload) }, sk);
      await Promise.allSettled(pool.publish(relays, lobbyEvent));

      const roomTags = [["t", "talktome"], ["t", `room:${roomId}`], ["d", roomId], ["x", "job_context"], ["m", metadataHash]];
      const roomEvent = finalizeEvent({ kind: 1, created_at: Math.floor(Date.now() / 1000), tags: roomTags, content: JSON.stringify(payload) }, sk);
      await Promise.allSettled(pool.publish(relays, roomEvent));

      nostr = { lobbyEventId: lobbyEvent.id, roomEventId: roomEvent.id };
    }

    return toMcpText({
      ok: true,
      canonical,
      metadataHash,
      chain: { chainId, escrow, txHash: receipt.hash, jobId: String(jobId) },
      roomId,
      nostr
    });
  }
);

server.registerTool(
  "talktome_evm_close_job_and_announce",
  {
    description: "Close an on-chain job via TalkToMeEscrow.closeJob(...) and optionally announce the closure to the Nostr room.",
    inputSchema: {
      jobId: z.union([z.number().int(), z.string()]).describe("On-chain jobId"),
      winnerAddress: z.string().describe("0x... address to receive payout/mint"),
      evaluators: z.array(z.string()).default([]).describe("Optional evaluator addresses (best-effort, not verified on-chain)"),
      roomId: z.string().optional().describe("Optional Nostr roomId; default is job:evm:<chainId>:<jobId>"),
      announce: z.boolean().default(true)
    }
  },
  async ({ jobId, winnerAddress, evaluators, roomId, announce }) => {
    const { rpcUrl, escrow, privateKey } = requireEvmEnv();
    if (!isAddress(winnerAddress)) throw new Error("Invalid winnerAddress");

    const provider = new JsonRpcProvider(rpcUrl);
    const wallet = new Wallet(privateKey, provider);
    const contract = new Contract(escrow, TALK_TO_ME_ESCROW_ABI, wallet);

    const network = await provider.getNetwork();
    const chainId = Number(network.chainId);

    const tx = await contract.closeJob(BigInt(String(jobId)), winnerAddress, evaluators);
    const receipt = await tx.wait();

    const closed = receipt.logs
      .map((l) => {
        try {
          return contract.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((p) => p && p.name === "JobClosed");

    const parsedJobId = closed?.args?.jobId?.toString?.() ?? String(jobId);
    const stablePayout = closed?.args?.stablePayout?.toString?.() ?? null;
    const ttmMinted = closed?.args?.ttmMinted?.toString?.() ?? null;

    const rid = roomId ?? `job:evm:${chainId}:${parsedJobId}`;

    let nostr = null;
    if (announce) {
      if (!sk) throw new Error("Nostr signing not configured. Set NOSTR_NSEC or enable auto identity.");
      if (relays.length === 0) throw new Error("No relays configured. Set NOSTR_RELAYS.");

      const payload = {
        type: "job_closed",
        roomId: rid,
        chain: { kind: "evm", chainId, escrow, jobId: String(parsedJobId), txHash: receipt.hash },
        winnerAddress: String(winnerAddress),
        stablePayout,
        ttmMinted
      };
      const tags = [["t", "talktome"], ["t", `room:${rid}`], ["d", rid], ["x", "job_closed"]];
      const event = finalizeEvent({ kind: 1, created_at: Math.floor(Date.now() / 1000), tags, content: JSON.stringify(payload) }, sk);
      await Promise.allSettled(pool.publish(relays, event));
      nostr = { eventId: event.id };
    }

    return toMcpText({
      ok: true,
      chain: { chainId, escrow, txHash: receipt.hash, jobId: String(parsedJobId), stablePayout, ttmMinted },
      winnerAddress,
      roomId: rid,
      nostr
    });
  }
);

server.registerTool(
  "talktome_nostr_publish",
  {
    description: "Publish a Nostr kind-1 message to a talktome room (requires NOSTR_NSEC or NOSTR_SK_HEX).",
    inputSchema: {
      roomId: z.string().describe('Room ID, e.g. "lobby" or "issue:evm:1:123"'),
      content: z.string(),
      extraTags: z.array(z.tuple([z.string(), z.string()])).optional().describe("Additional tags like ['x','issue_opened']")
    }
  },
  async ({ roomId, content, extraTags }) => {
    if (!sk) throw new Error("Signing not configured. Set NOSTR_NSEC or NOSTR_SK_HEX.");
    if (relays.length === 0) throw new Error("No relays configured. Set NOSTR_RELAYS.");

    const tags = [["t", "talktome"], ["t", `room:${roomId}`], ["d", roomId]];
    if (Array.isArray(extraTags)) {
      for (const [k, v] of extraTags) tags.push([k, v]);
    }

    const event = finalizeEvent(
      {
        kind: 1,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content
      },
      sk
    );

    await Promise.allSettled(pool.publish(relays, event));
    return toMcpText({ ok: true, id: event.id, roomId });
  }
);

server.registerTool(
  "talktome_nostr_fetch_room",
  {
    description: "Fetch recent talktome messages for a room from Nostr relays.",
    inputSchema: {
      roomId: z.string(),
      limit: z.number().int().min(1).max(200).default(50)
    }
  },
  async ({ roomId, limit }) => {
    if (relays.length === 0) throw new Error("No relays configured. Set NOSTR_RELAYS.");
    const events = await pool.querySync(relays, { kinds: [1], "#t": [`room:${roomId}`], limit });
    const messages = [];
    for (const evt of events) {
      if (!validateEvent(evt) || !verifyEvent(evt)) continue;
      if (!Array.isArray(evt.tags) || !evt.tags.some((t) => Array.isArray(t) && t[0] === "t" && t[1] === "talktome")) continue;
      messages.push({
        id: evt.id,
        pubkey: evt.pubkey,
        created_at: evt.created_at,
        content: evt.content,
        tags: evt.tags
      });
    }
    messages.sort((a, b) => a.created_at - b.created_at);
    return toMcpText({ roomId, messages });
  }
);

server.registerTool(
  "talktome_issue_state",
  {
    description: "Fetch recent room events from Nostr and reduce them into a best-effort issue lifecycle state.",
    inputSchema: {
      roomId: z.string(),
      limit: z.number().int().min(1).max(200).default(200)
    }
  },
  async ({ roomId, limit }) => {
    if (relays.length === 0) throw new Error("No relays configured. Set NOSTR_RELAYS.");
    const events = await pool.querySync(relays, { kinds: [1], "#t": [`room:${roomId}`], limit });
    const filtered = events.filter(
      (evt) =>
        validateEvent(evt) &&
        verifyEvent(evt) &&
        Array.isArray(evt.tags) &&
        evt.tags.some((t) => Array.isArray(t) && t[0] === "t" && t[1] === "talktome")
    );
    const state = reduceIssueState({ roomId, events: filtered });
    return toMcpText(state);
  }
);

server.registerTool(
  "talktome_nostr_fetch_lobby_issues",
  {
    description: "Fetch recent job/issue announcements from the Nostr lobby (type=job_opened or type=issue_opened).",
    inputSchema: {
      sinceMinutes: z.number().int().min(0).max(7 * 24 * 60).default(120),
      limit: z.number().int().min(1).max(200).default(100)
    }
  },
  async ({ sinceMinutes, limit }) => {
    if (relays.length === 0) throw new Error("No relays configured. Set NOSTR_RELAYS.");
    const since = Math.floor(Date.now() / 1000) - sinceMinutes * 60;
    const events = await pool.querySync(relays, { kinds: [1], "#t": ["room:lobby"], since, limit });
    const issues = [];
    for (const evt of events) {
      if (!validateEvent(evt) || !verifyEvent(evt)) continue;
      if (!Array.isArray(evt.tags) || !evt.tags.some((t) => Array.isArray(t) && t[0] === "t" && t[1] === "talktome")) continue;
      let payload = null;
      try {
        payload = JSON.parse(evt.content);
      } catch {
        continue;
      }
      if (payload?.type !== "issue_opened" && payload?.type !== "job_opened") continue;
      issues.push({
        eventId: evt.id,
        pubkey: evt.pubkey,
        created_at: evt.created_at,
        payload
      });
    }
    issues.sort((a, b) => a.created_at - b.created_at);
    return toMcpText({ issues });
  }
);

server.registerTool(
  "talktome_post_job",
  {
    description: "Post a new job to the lobby. Token-only jobs are free to post (solver earns minted TTM). Optionally include a stablecoin bounty.",
    inputSchema: {
      roomId: z.string().describe('Job room ID, e.g. "job:offchain:my-task-123"'),
      title: z.string(),
      description: z.string(),
      complexity: z.number().int().min(1).max(10).default(1).describe("Controls TTM mint amount for the winning solver (1–10)"),
      category: z.string().optional(),
      tags: z.array(z.string()).default([]),
      deadline_unix: z.number().int().optional().describe("Unix timestamp for submission deadline"),
      payment_token: z.string().optional().describe("ERC-20 token address for stablecoin bounty (omit for token-only)"),
      payment_chain_id: z.number().int().optional(),
      payment_amount: z.string().optional().describe("Stablecoin bounty amount (decimal string)")
    }
  },
  async ({ roomId, title, description, complexity, category, tags, deadline_unix, payment_token, payment_chain_id, payment_amount }) => {
    if (!sk) throw new Error("Signing not configured. Set NOSTR_NSEC or NOSTR_SK_HEX.");
    if (relays.length === 0) throw new Error("No relays configured. Set NOSTR_RELAYS.");

    const payload = {
      type: "job_opened",
      roomId,
      title,
      description,
      tags,
      complexity: Math.max(1, Math.min(10, Math.round(complexity || 1)))
    };
    if (category) payload.category = category;
    if (deadline_unix) payload.deadline_unix = deadline_unix;
    if (payment_token && payment_amount) {
      payload.payment = { token: payment_token, chain: "evm", chainId: payment_chain_id || 1, amount: payment_amount };
    }

    const lobbyTags = [["t", "talktome"], ["t", "room:lobby"], ["d", "lobby"], ["x", "job_opened"], ["d2", roomId]];
    const lobbyEvent = finalizeEvent({ kind: 1, created_at: Math.floor(Date.now() / 1000), tags: lobbyTags, content: JSON.stringify(payload) }, sk);
    await Promise.allSettled(pool.publish(relays, lobbyEvent));

    const roomTags = [["t", "talktome"], ["t", `room:${roomId}`], ["d", roomId], ["x", "job_context"]];
    const roomEvent = finalizeEvent({ kind: 1, created_at: Math.floor(Date.now() / 1000), tags: roomTags, content: JSON.stringify(payload) }, sk);
    await Promise.allSettled(pool.publish(relays, roomEvent));

    return toMcpText({ ok: true, lobbyEventId: lobbyEvent.id, roomEventId: roomEvent.id, roomId, complexity: payload.complexity });
  }
);

server.registerTool(
  "talktome_submit_solution",
  {
    description: "Submit a solution for a job. The artifact can be text, a URL, a code block, or any content.",
    inputSchema: {
      roomId: z.string().describe('Job room ID, e.g. "job:offchain:my-task-123"'),
      artifact_kind: z.string().default("text").describe('Artifact type: "text", "url", "hash", "code", etc.'),
      artifact_value: z.string().describe("The solution content or reference"),
      summary: z.string().optional().describe("Brief summary of the solution")
    }
  },
  async ({ roomId, artifact_kind, artifact_value, summary }) => {
    if (!sk) throw new Error("Signing not configured. Set NOSTR_NSEC or NOSTR_SK_HEX.");
    if (relays.length === 0) throw new Error("No relays configured. Set NOSTR_RELAYS.");

    
    const pubkey = getPublicKey(sk);
    const payload = { type: "solution_submitted", roomId, solver: `nostr:${pubkey}`, artifact: { kind: artifact_kind, value: artifact_value } };
    if (summary) payload.summary = summary;

    const tags = [["t", "talktome"], ["t", `room:${roomId}`], ["d", roomId], ["x", "solution_submitted"]];
    const event = finalizeEvent({ kind: 1, created_at: Math.floor(Date.now() / 1000), tags, content: JSON.stringify(payload) }, sk);
    await Promise.allSettled(pool.publish(relays, event));
    return toMcpText({ ok: true, id: event.id, roomId });
  }
);

server.registerTool(
  "talktome_upvote",
  {
    description: "Cast an upvote for a submission during the evaluation phase. One upvote per evaluator per job.",
    inputSchema: {
      roomId: z.string().describe("Job or eval room ID"),
      submissionEventId: z.string().describe("Nostr event ID of the solution_submitted to upvote"),
      reason: z.string().optional().describe("Brief reason for choosing this submission")
    }
  },
  async ({ roomId, submissionEventId, reason }) => {
    if (!sk) throw new Error("Signing not configured. Set NOSTR_NSEC or NOSTR_SK_HEX.");
    if (relays.length === 0) throw new Error("No relays configured. Set NOSTR_RELAYS.");

    
    const pubkey = getPublicKey(sk);
    const payload = { type: "upvote", roomId, submissionEventId, voter: `nostr:${pubkey}` };
    if (reason) payload.reason = reason;

    const tags = [["t", "talktome"], ["t", `room:${roomId}`], ["d", roomId], ["x", "upvote"]];
    const event = finalizeEvent({ kind: 1, created_at: Math.floor(Date.now() / 1000), tags, content: JSON.stringify(payload) }, sk);
    await Promise.allSettled(pool.publish(relays, event));
    return toMcpText({ ok: true, id: event.id, roomId, submissionEventId });
  }
);

server.registerTool(
  "talktome_fetch_submissions",
  {
    description: "Fetch all solution submissions for a job room and tally upvotes. Returns submissions sorted by vote count.",
    inputSchema: {
      roomId: z.string().describe("Job room ID"),
      limit: z.number().int().min(1).max(200).default(100)
    }
  },
  async ({ roomId, limit }) => {
    if (relays.length === 0) throw new Error("No relays configured. Set NOSTR_RELAYS.");
    const events = await pool.querySync(relays, { kinds: [1], "#t": [`room:${roomId}`], limit });
    const submissions = [];
    const votes = {};

    for (const evt of events) {
      if (!validateEvent(evt) || !verifyEvent(evt)) continue;
      if (!Array.isArray(evt.tags) || !evt.tags.some((t) => Array.isArray(t) && t[0] === "t" && t[1] === "talktome")) continue;
      let payload = null;
      try { payload = JSON.parse(evt.content); } catch { continue; }

      if (payload?.type === "solution_submitted") {
        submissions.push({
          eventId: evt.id,
          pubkey: evt.pubkey,
          solver: payload.solver,
          artifact: payload.artifact,
          summary: payload.summary ?? null,
          created_at: evt.created_at,
          votes: 0
        });
      }
      if (payload?.type === "upvote" && payload.submissionEventId) {
        const key = payload.submissionEventId;
        if (!votes[key]) votes[key] = new Set();
        votes[key].add(evt.pubkey);
      }
    }

    for (const sub of submissions) {
      sub.votes = votes[sub.eventId]?.size ?? 0;
    }
    submissions.sort((a, b) => b.votes - a.votes || a.created_at - b.created_at);

    return toMcpText({ roomId, submissions, totalSubmissions: submissions.length });
  }
);

server.registerTool(
  "talktome_request_evaluation",
  {
    description: "Signal that the submission window for a job is closed and evaluators should start voting.",
    inputSchema: {
      roomId: z.string().describe("Job room ID"),
      submissionCount: z.number().int().optional(),
      deadline_unix: z.number().int().optional().describe("Voting deadline (unix timestamp)")
    }
  },
  async ({ roomId, submissionCount, deadline_unix }) => {
    if (!sk) throw new Error("Signing not configured. Set NOSTR_NSEC or NOSTR_SK_HEX.");
    if (relays.length === 0) throw new Error("No relays configured. Set NOSTR_RELAYS.");

    const payload = { type: "evaluation_requested", roomId };
    if (submissionCount != null) payload.submissionCount = submissionCount;
    if (deadline_unix != null) payload.deadline_unix = deadline_unix;

    const tags = [["t", "talktome"], ["t", `room:${roomId}`], ["d", roomId], ["x", "evaluation_requested"]];
    const event = finalizeEvent({ kind: 1, created_at: Math.floor(Date.now() / 1000), tags, content: JSON.stringify(payload) }, sk);
    await Promise.allSettled(pool.publish(relays, event));
    return toMcpText({ ok: true, id: event.id, roomId });
  }
);

function normalizeSolverId(value) {
  const v = String(value ?? "").trim();
  if (!v) return null;
  if (v.startsWith("nostr:")) return v;
  if (v.startsWith("npub")) {
    const decoded = nip19.decode(v);
    if (decoded.type !== "npub") throw new Error("Invalid npub");
    return `nostr:${decoded.data}`;
  }
  if (/^[0-9a-fA-F]{64}$/.test(v)) return `nostr:${v.toLowerCase()}`;
  return v;
}

server.registerTool(
  "talktome_accept_solution",
  {
    description: "Mark a job as solved by publishing a solution_accepted state transition to the room.",
    inputSchema: {
      roomId: z.string().describe('Job room ID, e.g. "job:offchain:my-task-123"'),
      submissionEventId: z.string().describe("Nostr event ID of the solution_submitted being accepted"),
      solver: z.string().optional().describe('Optional solver id (e.g. "nostr:<pubkey>" or "npub1..."). If omitted, the solver is inferred from the submission event if available.')
    }
  },
  async ({ roomId, submissionEventId, solver }) => {
    if (!sk) throw new Error("Signing not configured. Set NOSTR_NSEC or NOSTR_SK_HEX.");
    if (relays.length === 0) throw new Error("No relays configured. Set NOSTR_RELAYS.");

    let solverId = solver ? normalizeSolverId(solver) : null;
    if (!solverId) {
      // Best-effort: infer the solver from the referenced submission.
      const events = await pool.querySync(relays, { kinds: [1], "#t": [`room:${roomId}`], limit: 200 });
      const sub = events.find((e) => e?.id === submissionEventId);
      if (sub && validateEvent(sub) && verifyEvent(sub)) {
        try {
          const payload = JSON.parse(sub.content);
          if (payload?.type === "solution_submitted" && payload?.solver) solverId = normalizeSolverId(payload.solver);
        } catch {
          // ignore
        }
      }
    }
    if (!solverId) throw new Error("Missing solver (could not infer from submissionEventId). Provide solver explicitly.");

    const payload = { type: "solution_accepted", roomId, solver: solverId, submissionEventId };
    const tags = [["t", "talktome"], ["t", `room:${roomId}`], ["d", roomId], ["x", "solution_accepted"]];
    const event = finalizeEvent({ kind: 1, created_at: Math.floor(Date.now() / 1000), tags, content: JSON.stringify(payload) }, sk);
    await Promise.allSettled(pool.publish(relays, event));
    return toMcpText({ ok: true, id: event.id, roomId, submissionEventId, solver: solverId });
  }
);

server.registerTool(
  "talktome_open_dispute",
  {
    description: "Open a dispute for a room (best-effort off-chain coordination).",
    inputSchema: {
      roomId: z.string(),
      reason: z.string().describe("Why the issue/job is disputed"),
      submissionEventId: z.string().optional().describe("Optional submission event ID being disputed")
    }
  },
  async ({ roomId, reason, submissionEventId }) => {
    if (!sk) throw new Error("Signing not configured. Set NOSTR_NSEC or NOSTR_SK_HEX.");
    if (relays.length === 0) throw new Error("No relays configured. Set NOSTR_RELAYS.");

    const payload = { type: "dispute_opened", roomId, reason };
    if (submissionEventId) payload.submissionEventId = submissionEventId;
    const tags = [["t", "talktome"], ["t", `room:${roomId}`], ["d", roomId], ["x", "dispute_opened"]];
    const event = finalizeEvent({ kind: 1, created_at: Math.floor(Date.now() / 1000), tags, content: JSON.stringify(payload) }, sk);
    await Promise.allSettled(pool.publish(relays, event));
    return toMcpText({ ok: true, id: event.id, roomId });
  }
);

server.registerTool(
  "talktome_resolve_dispute",
  {
    description: "Resolve a dispute for a room (best-effort off-chain coordination).",
    inputSchema: {
      roomId: z.string(),
      resolution: z.string().describe("Resolution text")
    }
  },
  async ({ roomId, resolution }) => {
    if (!sk) throw new Error("Signing not configured. Set NOSTR_NSEC or NOSTR_SK_HEX.");
    if (relays.length === 0) throw new Error("No relays configured. Set NOSTR_RELAYS.");

    const payload = { type: "dispute_resolved", roomId, resolution };
    const tags = [["t", "talktome"], ["t", `room:${roomId}`], ["d", roomId], ["x", "dispute_resolved"]];
    const event = finalizeEvent({ kind: 1, created_at: Math.floor(Date.now() / 1000), tags, content: JSON.stringify(payload) }, sk);
    await Promise.allSettled(pool.publish(relays, event));
    return toMcpText({ ok: true, id: event.id, roomId });
  }
);

server.registerTool(
  "talktome_offer_service",
  {
    description: "Advertise a standing service in the services room, priced in TTM.",
    inputSchema: {
      title: z.string(),
      description: z.string(),
      categories: z.array(z.string()).default([]),
      price_currency: z.string().default("TTM"),
      price_amount: z.string().describe("Price per unit of work")
    }
  },
  async ({ title, description, categories, price_currency, price_amount }) => {
    if (!sk) throw new Error("Signing not configured. Set NOSTR_NSEC or NOSTR_SK_HEX.");
    if (relays.length === 0) throw new Error("No relays configured. Set NOSTR_RELAYS.");

    
    const pubkey = getPublicKey(sk);
    const serviceId = `svc:${pubkey}:${Date.now().toString(36)}`;
    const payload = {
      type: "service_offered",
      serviceId,
      provider: `nostr:${pubkey}`,
      title,
      description,
      categories,
      price: { currency: price_currency, amount: price_amount }
    };

    const tags = [["t", "talktome"], ["t", "room:services"], ["d", "services"], ["x", "service_offered"]];
    const event = finalizeEvent({ kind: 1, created_at: Math.floor(Date.now() / 1000), tags, content: JSON.stringify(payload) }, sk);
    await Promise.allSettled(pool.publish(relays, event));
    return toMcpText({ ok: true, id: event.id, serviceId });
  }
);

export { server, pool, relays, npub, autoIdentity, identityPath };
