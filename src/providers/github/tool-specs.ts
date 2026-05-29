import {
  loadProviderToolSpecs,
  type ProviderToolSpec
} from "../tool-specs";

export const githubProviderToolSpecs: ProviderToolSpec[] = loadProviderToolSpecs(
  new URL("./tools.yaml", import.meta.url)
);
