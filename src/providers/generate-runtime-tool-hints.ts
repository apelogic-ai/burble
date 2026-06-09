import { writeFileSync } from "node:fs";
import { providerToolCatalog } from "./catalog";
import { buildRuntimeProviderToolHints } from "./runtime-tool-hints";

const outputPath = new URL(
  "../../runtimes/nemo-hermes/runtime/provider-tool-hints.json",
  import.meta.url
);

writeFileSync(
  outputPath,
  `${JSON.stringify(buildRuntimeProviderToolHints(providerToolCatalog), null, 2)}\n`
);
