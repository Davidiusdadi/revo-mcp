import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpServer } from "../src/server";
import { MessagePortTransport } from "../src/browser/message-port-transport";

let client: Client;
let server: McpServer;

beforeAll(async () => {
  const channel = new MessageChannel();
  server = createMcpServer();
  client = new Client({ name: "worker-transport-test", version: "1.0.0" });
  await server.connect(new MessagePortTransport(channel.port1));
  await client.connect(new MessagePortTransport(channel.port2));
});

afterAll(async () => {
  await client.close();
  await server.close();
});

describe("MessagePortTransport", () => {
  test("discovers the ReVo tools across a MessageChannel", async () => {
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain("search");
  });

  test("glosses a word with its mark and translations, validated against the output schema", async () => {
    const result = await client.callTool({
      name: "gloss",
      arguments: { text: "malsanulejo", lang: "eo", languages: ["de"] },
    });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as any;
    expect(structured.mode).toBe("eo");
    expect(structured.counts.headword).toBe(1);
    expect(structured.terms[0]).toMatchObject({ word: "malsanulejo", verdict: "headword", mrk: "san.mal0ulejo", seg: "mal|san|ul|ej|o" });
    expect(structured.terms[0].translations).toContainEqual({ lng: "de", trd: "Krankenhaus" });
    expect(structured.terms[0].parts[0]).toMatchObject({ m: "mal", k: "P", mrk: "mal.0" });
  });

  test("returns structured multilingual search results", async () => {
    const result = await client.callTool({
      name: "search",
      arguments: { query: "Hund", languages: ["de", "en"], limit: 5 },
    });
    const structured = result.structuredContent as any;
    expect(structured.results[0].entry.headword).toBe("hundo");
    expect(structured.results[0].matchReasons).toContainEqual({
      language: "de",
      text: "Hund",
      kind: "translation",
    });
  });
});

