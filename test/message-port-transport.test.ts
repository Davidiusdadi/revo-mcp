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
    expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["search", "entry", "family", "wordExamples"]));
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

  test("lists an entry's word families across articles, validated against the output schema", async () => {
    const result = await client.callTool({ name: "family", arguments: { mark: "hund.cxas0o", languages: ["de"] } });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as any;
    expect(structured.available).toBe(true);
    expect(structured.families.map((family: any) => family.root)).toEqual(["hund", "ĉas"]);
    const hund = structured.families[0];
    expect(hund.members.map((member: any) => member.headword)).toEqual(expect.arrayContaining(["ĉashundo", "hundherbo", "hundimposto"]));
    expect(structured.translations["herb.hund0o"]).toContainEqual({ lng: "de", trd: "Quecke" });
  });

  test("an unknown mark is a tool error", async () => {
    const result = await client.callTool({ name: "family", arguments: { mark: "hund.nenio0o" } });
    expect(result.isError).toBe(true);
    expect((result.content as any[])[0].text).toContain("No dictionary entry has the mark hund.nenio0o.");
  });

  test("finds the examples of an entry's word, validated against the output schema", async () => {
    const result = await client.callTool({
      name: "wordExamples",
      arguments: { mark: "spec.sia0a", languages: ["de"], limit: 5, exactTotal: false },
    });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as any;
    expect(structured.headwords).toEqual(["siaspeca"]);
    expect(structured.examples.length).toBeGreaterThan(0);
    for (const example of structured.examples) {
      const words = example.matches.map((m: any) => example.text.slice(m.at, m.at + m.length).toLowerCase());
      expect(words.every((word: string) => /^siaspecaj?n?$/.test(word))).toBe(true);
    }
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

