import {
  loadProviderToolSpecs,
  type ProviderToolSpec
} from "../tool-specs";

export const slackProviderToolSpecs: ProviderToolSpec[] = loadProviderToolSpecs(
  new URL("./tools.yaml", import.meta.url)
);
