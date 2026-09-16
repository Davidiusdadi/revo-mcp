/**
 * MCP HTTP server for Reta Vortaro (Esperanto dictionary).
 * Transport: Streamable HTTP (for remote access via HTTPS)
 * Compatible with Claude.ai custom connectors and other MCP HTTP clients.
 * Environment: PORT (default: 3000)
 *
 *   pnpm start:http
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "./server";
import { ensureNodeDatabase } from "./runtime/node-database";
import { registerShutdownHandlers } from "./runtime/shutdown";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
};

const MCP_PATH = "/mcp";

registerShutdownHandlers();
ensureNodeDatabase();

const PORT = parseInt(process.env.PORT ?? "3000", 10);

/** A complete response; `end(body)` before any header is sent sets Content-Length. */
function send(res: ServerResponse, status: number, contentType: string, body: string): void {
  res.statusCode = status;
  res.setHeader("Content-Type", contentType);
  res.end(body);
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const t0 = performance.now();
  console.log(`[http] ${req.method} ${MCP_PATH}`);
  // Fresh transport per request (stateless mode).
  // enableJsonResponse avoids SSE streaming so we can safely close after responding.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  const server = createMcpServer();
  res.on("close", () => void server.close());
  // The transport writes its own headers with writeHead, which keeps these.
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v);
  await server.connect(transport);
  await transport.handleRequest(req, res);
  const ms = (performance.now() - t0).toFixed(0);
  console.log(`[http] ${req.method} ${MCP_PATH} → ${res.statusCode} (${ms}ms)`);
}

const httpServer = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS_HEADERS).end();
      return;
    }

    if (url.pathname === "/" && req.method === "GET") {
      send(res, 200, "application/json", JSON.stringify({ status: "ok", name: "revo-vortaro" }));
      return;
    }

    if (url.pathname === MCP_PATH && req.method === "POST") {
      await handleMcp(req, res);
      return;
    }

    // Stateless: no session to end, and no stream to keep open for messages
    // the server never sends unasked. Clients take 405 as "not offered".
    if (url.pathname === MCP_PATH) {
      res.writeHead(405, { ...CORS_HEADERS, Allow: "POST, OPTIONS", "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }));
      return;
    }

    send(res, 404, "text/plain;charset=utf-8", "Not Found");
  } catch (err) {
    console.error(err);
    if (res.headersSent) res.end();
    else send(res, 500, "text/plain;charset=utf-8", "Internal Server Error");
  }
});

httpServer.listen(PORT, () => {
  console.log(`Revo MCP HTTP server listening on port ${PORT}`);
  console.log(`MCP endpoint: http://localhost:${PORT}${MCP_PATH}`);
});
