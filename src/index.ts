#!/usr/bin/env bun
/**
 * MCP server for Reta Vortaro (Esperanto dictionary).
 * Transport: stdio (for use with Claude Desktop, claude CLI, etc.)
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./server";
import { ensureBunDatabase } from "./runtime/bun-database";
import { registerShutdownHandlers } from "./runtime/bun-shutdown";

registerShutdownHandlers();
ensureBunDatabase();

const server = createMcpServer();
const transport = new StdioServerTransport();
await server.connect(transport);
