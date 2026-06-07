import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { buildRuntimeContractJsonSchema } from "../src/json-schema";

const outputPath = resolve(
  import.meta.dir,
  "../schema/runtime-contract.schema.json"
);

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(
  outputPath,
  `${JSON.stringify(buildRuntimeContractJsonSchema(), null, 2)}\n`,
  "utf8"
);
