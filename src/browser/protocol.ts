export type RevoWorkerInit = {
  type: "revo:init";
  mcpPort: MessagePort;
  databaseUrl: string;
  access?: "shards" | "range" | "download";
};

export type RevoWorkerEvent =
  | { type: "revo:loading"; phase: "sqlite" | "database" | "mcp"; loaded?: number; total?: number }
  | { type: "revo:ready"; engine: "shards" | "sqlite-wasm" }
  | { type: "revo:error"; message: string };
