import {
  loadProviderToolSpecs,
  type ProviderToolSpec
} from "../tool-specs";

export const webProviderToolSpecs: ProviderToolSpec[] = loadProviderToolSpecs(
  new URL("./tools.yaml", import.meta.url)
);

