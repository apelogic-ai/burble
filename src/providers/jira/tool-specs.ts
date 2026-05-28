import {
  loadProviderToolSpecs,
  type ProviderToolSpec
} from "../tool-specs";

export const jiraProviderToolSpecs: ProviderToolSpec[] = loadProviderToolSpecs(
  new URL("./tools.yaml", import.meta.url)
);
