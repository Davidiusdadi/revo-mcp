import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MessagePortTransport, type MessageEndpoint } from "./message-port-transport";

/** Connects an already configured ReVo server to a port transferred to a Worker. */
export async function connectWorkerServer(server: McpServer, port: MessageEndpoint): Promise<void> {
  await server.connect(new MessagePortTransport(port));
}

