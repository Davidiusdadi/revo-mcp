#!/usr/bin/env bun
/**
 * MCP HTTP server for Reta Vortaro (Esperanto dictionary).
 * Transport: Streamable HTTP (for remote access via HTTPS)
 * Compatible with Claude.ai custom connectors and other MCP HTTP clients.
 * Environment: PORT (default: 3000)
 */

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMcpServer, registerShutdownHandlers } from "./server";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
};

const MCP_PATH = "/mcp";

registerShutdownHandlers();

const PORT = parseInt(process.env.PORT ?? "3000", 10);

Bun.serve({
  port: PORT,
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (url.pathname === "/" && req.method === "GET") {
      return Response.json({ status: "ok", name: "revo-vortaro" });
    }

    if (url.pathname === MCP_PATH) {
      // SDK stateless mode requires a fresh transport per request.
      const transport = new WebStandardStreamableHTTPServerTransport();
      const server = createMcpServer();
      await server.connect(transport);
      try {
        const response = await transport.handleRequest(req);
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: { ...Object.fromEntries(response.headers), ...CORS_HEADERS },
        });
      } finally {
        await server.close();
      }
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`Revo MCP HTTP server listening on port ${PORT}`);
console.log(`MCP endpoint: http://localhost:${PORT}${MCP_PATH}`);
