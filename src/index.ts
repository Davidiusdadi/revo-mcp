/**
 * MCP server for Reta Vortaro (Esperanto dictionary).
 * Transport: stdio (for use with Claude Desktop, claude CLI, etc.)
 *
 *   pnpm start
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./server";
import { ensureNodeDatabase } from "./runtime/node-database";
import { registerShutdownHandlers } from "./runtime/shutdown";

registerShutdownHandlers();
ensureNodeDatabase();

const server = createMcpServer();
const transport = new StdioServerTransport();
await server.connect(transport);
