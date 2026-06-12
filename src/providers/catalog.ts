import { providerDescriptors } from "./descriptors";
import type { ProviderToolSpec } from "./tool-specs";

export const providerToolCatalog: ProviderToolSpec[] =
  providerDescriptors.flatMap((descriptor) => descriptor.tools);
