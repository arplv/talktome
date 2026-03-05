#!/usr/bin/env node
import { loadDotenv } from "../src/dotenv.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

loadDotenv();

const url = process.env.TALKTOME_MCP_URL ?? "http://127.0.0.1:3333/mcp";

async function main() {
  const client = new Client({ name: "talktome-mcp-http-smoke", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url));
  await client.connect(transport);

  const tools = await client.listTools();
  console.log(`[smoke] tools: ${tools.tools.length}`);

  const cfg = await client.callTool({ name: "talktome_nostr_config", arguments: {} });
  console.log("[smoke] talktome_nostr_config:", cfg.structuredContent);

  // Post a small job using the auto-generated Nostr identity (no keys needed).
  const roomId = `job:offchain:smoke:${Date.now().toString(36)}`;
  const res = await client.callTool({
    name: "talktome_post_job",
    arguments: {
      roomId,
      title: "Smoke test job",
      description: "Reply with: ok",
      complexity: 1,
      tags: ["smoke"]
    }
  });
  console.log("[smoke] talktome_post_job:", res.structuredContent);

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

