import { atlassianProviderToolSpecs } from "./atlassian/tool-specs";
import { githubProviderToolSpecs } from "./github/tool-specs";
import { googleProviderToolSpecs } from "./google/tool-specs";
import { hubspotProviderToolSpecs } from "./hubspot/tool-specs";
import { jiraProviderToolSpecs } from "./jira/tool-specs";
import { slackProviderToolSpecs } from "./slack/tool-specs";
import type { ProviderToolSpec } from "./tool-specs";

export const providerToolCatalog: ProviderToolSpec[] = [
  ...githubProviderToolSpecs,
  ...googleProviderToolSpecs,
  ...hubspotProviderToolSpecs,
  ...jiraProviderToolSpecs,
  ...slackProviderToolSpecs,
  ...atlassianProviderToolSpecs
];
