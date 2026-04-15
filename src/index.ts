#!/usr/bin/env bun
/**
 * MCP server for Reta Vortaro (Esperanto dictionary).
 * Transport: stdio (for use with Claude Desktop, claude CLI, etc.)
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer, registerShutdownHandlers } from "./server";

registerShutdownHandlers();

const server = createMcpServer();
const transport = new StdioServerTransport();
await server.connect(transport);
