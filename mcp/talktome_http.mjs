#!/usr/bin/env node
import http from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { server } from "./talktome_server.mjs";

const HOST = process.env.TALKTOME_MCP_HTTP_HOST ?? "127.0.0.1";
const PORT = Number.parseInt(process.env.TALKTOME_MCP_HTTP_PORT ?? "3333", 10);
const PATHNAME = process.env.TALKTOME_MCP_HTTP_PATH ?? "/mcp";

async function main() {
  const transport = new StreamableHTTPServerTransport({
    // Single-session transport is enough for Codex/local usage. Restart the process for a new session.
    sessionIdGenerator: () => randomUUID()
  });

  await server.connect(transport);

  const srv = http.createServer(async (req, res) => {
    try {
      if (!req.url) {
        res.statusCode = 400;
        res.end("Bad Request");
        return;
      }

      const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

      if (url.pathname === "/healthz") {
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (url.pathname !== PATHNAME) {
        res.statusCode = 404;
        res.end("Not Found");
        return;
      }

      await transport.handleRequest(req, res);
    } catch (err) {
      res.statusCode = 500;
      res.end("Internal Server Error");
      console.error(err);
    }
  });

  srv.listen(PORT, HOST, () => {
    console.error(`talktome MCP server (Streamable HTTP) listening on http://${HOST}:${PORT}${PATHNAME}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

