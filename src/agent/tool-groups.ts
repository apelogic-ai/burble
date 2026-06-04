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
  contextTexts?: string[];
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
    "hubspot user",
    "hubspot users",
    "hubspot owner",
    "hubspot owners",
    "crm contact",
    "crm contacts",
    "crm company",
    "crm companies",
    "crm deal",
    "crm deals",
    "crm user",
    "crm users",
    "crm owner",
    "crm owners"
  ],
  jira: ["jira", "atlassian", "ticket", "sprint", "project"],
  scheduler: ["cron", "schedule", "scheduled", "recurring", "reminder", "every"],
  slack: ["slack", "channel", "dm", "message history"]
};

const contextAnchorKeywords: Partial<
  Record<Exclude<RuntimeToolGroup, "attachments" | "conversation">, string[]>
> = {
  github: ["github"],
  google: ["google", "drive", "gmail", "calendar"],
  hubspot: ["hubspot", "crm"],
  jira: ["jira", "atlassian"],
  slack: ["slack"]
};

const followUpKeywords: Partial<
  Record<Exclude<RuntimeToolGroup, "attachments" | "conversation">, string[]>
> = {
  google: [
    "drive",
    "file",
    "files",
    "folder",
    "folders",
    "doc",
    "docs",
    "document",
    "documents",
    "sheet",
    "sheets",
    "spreadsheet",
    "spreadsheets",
    "calendar",
    "event",
    "events",
    "email",
    "emails",
    "mail",
    "draft",
    "drafts"
  ],
  hubspot: [
    "client",
    "clients",
    "contact",
    "contacts",
    "company",
    "companies",
    "deal",
    "deals",
    "user",
    "users",
    "owner",
    "owners"
  ]
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

  const contextText = (input.contextTexts ?? [])
    .map((value) => value.toLocaleLowerCase())
    .join("\n");
  if (contextText) {
    for (const [group, keywords] of Object.entries(followUpKeywords) as Array<
      [Exclude<RuntimeToolGroup, "attachments" | "conversation">, string[]]
    >) {
      if (selected.has(group)) {
        continue;
      }
      const anchors = contextAnchorKeywords[group] ?? [];
      const matchedAnchor = anchors.find((keyword) =>
        containsKeyword(contextText, keyword)
      );
      const matchedFollowUp = keywords.find((keyword) =>
        containsKeyword(text, keyword)
      );
      if (matchedAnchor && matchedFollowUp) {
        addGroup(group, `context:${group}:${matchedAnchor}:${matchedFollowUp}`);
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
