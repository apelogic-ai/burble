import {
  loadProviderToolSpecs,
  type ProviderToolSpec
} from "../tool-specs";

export const googleProviderToolSpecs: ProviderToolSpec[] = loadProviderToolSpecs(
  new URL("./tools.yaml", import.meta.url)
);
