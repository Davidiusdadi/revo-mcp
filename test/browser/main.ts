import { RevoBrowserClient } from "../../src/browser/client";

const status = document.querySelector<HTMLOutputElement>("#status")!;
const result = document.querySelector<HTMLPreElement>("#result")!;
const events = document.querySelector<HTMLPreElement>("#events")!;
const access = new URLSearchParams(location.search).get("access") === "remote" ? "remote" : "auto";

try {
  const worker = new Worker("./worker-entry.js", { type: "module" });
  const client = await RevoBrowserClient.connect(worker, "./voko.db", {
    access,
    onEvent(event) {
      if (event.type === "revo:download") {
        document.documentElement.dataset.download = `${event.loaded}/${event.total}`;
        return;
      }
      if (event.type === "revo:ready" || event.type === "revo:engine") document.documentElement.dataset.engine = event.engine;
      events.textContent += `${JSON.stringify(event)}\n`;
    },
  });
  // For scripted checks beyond the first search.
  Object.assign(globalThis, { revo: client });
  const search = await client.search({ query: "Hund", languages: ["de", "en"], limit: 5 });
  result.textContent = JSON.stringify(search);
  status.value = "ready";
  document.documentElement.dataset.testState = "ready";
} catch (error) {
  status.value = error instanceof Error ? error.message : String(error);
  document.documentElement.dataset.testState = "error";
}
