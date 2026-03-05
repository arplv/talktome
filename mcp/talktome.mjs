#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { server } from "./talktome_server.mjs";

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("talktome MCP server running on stdio");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

