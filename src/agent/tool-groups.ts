export type RuntimeToolGroup =
  | "attachments"
  | "conversation"
  | "github"
  | "google"
  | "hubspot"
  | "jira"
  | "scheduler"
  | "slack";

export type RuntimeToolGroupSelection = {
  groups: RuntimeToolGroup[];
  reasons: string[];
};

export type RuntimeToolGroupSelectionInput = {
  text: string;
  attachmentCount?: number;
  allowedGroups?: RuntimeToolGroup[];
};

const groupKeywords: Record<Exclude<RuntimeToolGroup, "attachments" | "conversation">, string[]> = {
  github: [
    "github",
    "repo",
    "repository",
    "pr",
    "pull request",
    "issue",
    "branch",
    "review"
  ],
  google: [
    "google",
    "drive",
    "docs",
    "doc",
    "gmail",
    "email",
    "calendar"
  ],
  hubspot: [
    "hubspot",
    "crm",
    "hubspot contact",
    "hubspot contacts",
    "hubspot company",
    "hubspot companies",
    "hubspot deal",
    "hubspot deals",
    "crm contact",
    "crm contacts",
    "crm company",
    "crm companies",
    "crm deal",
    "crm deals"
  ],
  jira: ["jira", "atlassian", "ticket", "sprint", "project"],
  scheduler: ["cron", "schedule", "scheduled", "recurring", "reminder", "every"],
  slack: ["slack", "channel", "dm", "message history"]
};

export function selectRuntimeToolGroups(
  input: RuntimeToolGroupSelectionInput
): RuntimeToolGroupSelection {
  const allowed = input.allowedGroups ? new Set(input.allowedGroups) : null;
  const selected = new Set<RuntimeToolGroup>();
  const reasons: string[] = [];

  addGroup("conversation", "default:conversation");

  if ((input.attachmentCount ?? 0) > 0) {
    addGroup("attachments", "metadata:attachments");
  }

  const text = input.text.toLocaleLowerCase();
  for (const [group, keywords] of Object.entries(groupKeywords) as Array<
    [Exclude<RuntimeToolGroup, "attachments" | "conversation">, string[]]
  >) {
    for (const keyword of keywords) {
      if (containsKeyword(text, keyword)) {
        addGroup(group, `keyword:${group}:${keyword}`);
      }
    }
  }

  return {
    groups: [...selected].sort(),
    reasons
  };

  function addGroup(group: RuntimeToolGroup, reason: string): void {
    if (allowed && !allowed.has(group)) {
      return;
    }
    selected.add(group);
    reasons.push(reason);
  }
}

function containsKeyword(text: string, keyword: string): boolean {
  if (keyword.includes(" ")) {
    return text.includes(keyword);
  }

  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}s?\\b`, "i").test(text);
}
