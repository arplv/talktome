#!/usr/bin/env node
import * as z from "zod/v4";
import { keccak256, toUtf8Bytes } from "ethers";
import { finalizeEvent, nip19, SimplePool, validateEvent, verifyEvent } from "nostr-tools";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

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
const sk = decodeSecretKey();
const pool = new SimplePool({ enableReconnect: true, enablePing: true });

const server = new McpServer({ name: "talktome", version: "0.1.0" });

server.registerTool(
  "talktome_nostr_config",
  {
    description: "Get the configured Nostr relays and whether signing is available.",
    inputSchema: {}
  },
  async () => {
    return toMcpText({ relays, canSign: Boolean(sk) });
  }
);

server.registerTool(
  "talktome_evm_metadata_hash",
  {
    description: "Compute the canonical metadata JSON and keccak256 hash (bytes32) for on-chain openIssue(bounty, metadataHash).",
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

    const tags = [["t", "talktome"], ["d", roomId]];
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
    const events = await pool.querySync(relays, { kinds: [1], "#t": ["talktome"], "#d": [roomId], limit });
    const messages = [];
    for (const evt of events) {
      if (!validateEvent(evt) || !verifyEvent(evt)) continue;
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
  "talktome_nostr_fetch_lobby_issues",
  {
    description: "Fetch recent issue announcements from the Nostr lobby (JSON messages with type=issue_opened).",
    inputSchema: {
      sinceMinutes: z.number().int().min(0).max(7 * 24 * 60).default(120),
      limit: z.number().int().min(1).max(200).default(100)
    }
  },
  async ({ sinceMinutes, limit }) => {
    if (relays.length === 0) throw new Error("No relays configured. Set NOSTR_RELAYS.");
    const since = Math.floor(Date.now() / 1000) - sinceMinutes * 60;
    const events = await pool.querySync(relays, { kinds: [1], "#t": ["talktome"], "#d": ["lobby"], since, limit });
    const issues = [];
    for (const evt of events) {
      if (!validateEvent(evt) || !verifyEvent(evt)) continue;
      let payload = null;
      try {
        payload = JSON.parse(evt.content);
      } catch {
        continue;
      }
      if (payload?.type !== "issue_opened") continue;
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

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("talktome MCP server running on stdio");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

