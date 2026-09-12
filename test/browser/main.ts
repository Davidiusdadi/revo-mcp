import { RevoBrowserClient } from "../../src/browser/client";

const status = document.querySelector<HTMLOutputElement>("#status")!;
const result = document.querySelector<HTMLPreElement>("#result")!;

try {
  const worker = new Worker("./worker-entry.js", { type: "module" });
  const client = await RevoBrowserClient.connect(worker, "./dictionary/", {
    access: "shards",
    onProgress(progress) {
      status.value = progress.loaded
        ? `${progress.phase}:${progress.loaded}/${progress.total ?? "?"}`
        : progress.phase;
    },
  });
  const search = await client.search({ query: "Hund", languages: ["de", "en"], limit: 5 });
  result.textContent = JSON.stringify(search);
  status.value = "ready";
  document.documentElement.dataset.testState = "ready";
} catch (error) {
  status.value = error instanceof Error ? error.message : String(error);
  document.documentElement.dataset.testState = "error";
}
