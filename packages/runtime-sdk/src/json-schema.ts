import { z } from "zod";
import {
  runtimeCapabilityManifestSchema,
  runtimeRunEventSchema,
  runtimeRunRequestSchema,
  runtimeUsageSchema
} from "./runtime-contract";

export const runtimeContractJsonSchemaVersion = 1;

export function buildRuntimeContractJsonSchema(): unknown {
  const registry = z.registry<{ id: string }>();
  registry.add(runtimeRunRequestSchema, { id: "RuntimeRunRequest" });
  registry.add(runtimeRunEventSchema, { id: "RuntimeRunEvent" });
  registry.add(runtimeCapabilityManifestSchema, {
    id: "RuntimeCapabilityManifest"
  });
  registry.add(runtimeUsageSchema, { id: "RuntimeUsage" });

  return {
    $id: "https://burble.local/schemas/runtime-contract.schema.json",
    version: runtimeContractJsonSchemaVersion,
    ...z.toJSONSchema(registry, { target: "draft-7" })
  };
}
