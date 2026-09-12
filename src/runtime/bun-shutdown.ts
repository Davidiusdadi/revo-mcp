import { closeDb } from "../db";

export function registerShutdownHandlers(): void {
  const shutdown = () => {
    closeDb();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

