import {
  loadProviderToolSpecs,
  type ProviderToolSpec
} from "../tool-specs";

export const hubspotProviderToolSpecs: ProviderToolSpec[] =
  loadProviderToolSpecs(new URL("./tools.yaml", import.meta.url));
