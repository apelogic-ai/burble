import { selectRuntimeToolGroups } from "../agent/tool-groups";

export type ScheduledJobToolSource = {
  title: string | null;
  prompt: string | null;
};

export function inferAllowedToolsForScheduledJob(
  job: ScheduledJobToolSource,
  toolGroups?: string[],
): string[] {
  const groups =
    toolGroups ??
    selectRuntimeToolGroups({
      text: job.prompt ?? "",
      attachmentCount: 0,
      contextTexts: [],
    }).groups;
  const tools = new Set<string>();
  const groupSet = new Set(groups);
  const text = `${job.title ?? ""}\n${job.prompt ?? ""}`.toLocaleLowerCase();

  if (groupSet.has("github")) {
    tools.add("github_search_issues");
  }
  if (groupSet.has("google")) {
    tools.add("google_search_drive_files");
  }
  if (groupSet.has("hubspot")) {
    tools.add("hubspot_search_crm_objects");
  }
  if (groupSet.has("jira")) {
    tools.add("jira_search_issues");
  }
  if (groupSet.has("slack")) {
    tools.add("slack_search_messages");
  }
  if (
    /\b(news|web|website|article|articles|public source|public sources|latest|fresh|current)\b/i.test(
      text,
    )
  ) {
    tools.add("web_search");
  }

  if (tools.size === 0) {
    tools.add("conversation.sendMessage");
  }

  return [...tools].sort();
}
