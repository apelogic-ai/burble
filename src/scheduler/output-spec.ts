import { isRuntimeProgressOnlyResponseText } from "../agent/runtime-control-notices";
import { resolveWorkflowTemplateString } from "../workflow/template";
import { containsRuntimeToolCallProtocolFragments } from "@burble/runtime-sdk/runtime-text-protocol";

export type TaskOutputSpec =
  | {
      kind: "literal";
      text: string;
    }
  | {
      kind: "report";
      title: string;
      items: Array<Record<string, unknown>>;
      itemTemplate: string;
      emptyState: string;
      maxItems?: number;
      forbiddenContent?: string[];
    };

export type TaskOutputRenderResult =
  | {
      ok: true;
      text: string;
    }
  | {
      ok: false;
      reason: string;
    };

export function renderTaskOutputSpec(
  spec: TaskOutputSpec,
): TaskOutputRenderResult {
  switch (spec.kind) {
    case "literal":
      return validateRenderedOutput(spec.text, []);
    case "report":
      return renderReportOutputSpec(spec);
  }
}

function renderReportOutputSpec(
  spec: Extract<TaskOutputSpec, { kind: "report" }>,
): TaskOutputRenderResult {
  if (spec.items.length === 0) {
    return validateRenderedOutput(spec.emptyState, spec.forbiddenContent ?? []);
  }

  const maxItems = Math.max(1, spec.maxItems ?? spec.items.length);
  const visibleItems = spec.items.slice(0, maxItems);
  const overflowCount = Math.max(0, spec.items.length - visibleItems.length);
  const renderedItems: string[] = [];
  for (const item of visibleItems) {
    const rendered = renderItemTemplate(spec.itemTemplate, item);
    if (!rendered.ok) {
      return rendered;
    }
    renderedItems.push(rendered.text);
  }

  const lines = [spec.title.trim(), "", ...renderedItems];
  if (overflowCount > 0) {
    lines.push("", `And ${overflowCount} more.`);
  }

  return validateRenderedOutput(lines.join("\n"), spec.forbiddenContent ?? []);
}

function renderItemTemplate(
  template: string,
  item: Record<string, unknown>,
): TaskOutputRenderResult {
  try {
    return {
      ok: true,
      text: resolveWorkflowTemplateString(template, item, {
        missingBindingMessage: (field) =>
          `Output item is missing required field ${field}.`,
      }),
    };
  } catch (error) {
    return {
      ok: false,
      reason:
        error instanceof Error ? error.message : "Output item render failed.",
    };
  }
}

function validateRenderedOutput(
  text: string,
  forbiddenContent: string[],
): TaskOutputRenderResult {
  const trimmed = text.trim();
  if (isRuntimeProgressOnlyResponseText(trimmed)) {
    return {
      ok: false,
      reason:
        "Output contains runtime-control/progress text instead of user-visible content.",
    };
  }
  if (containsRuntimeToolCallProtocolFragments(trimmed)) {
    return {
      ok: false,
      reason: "Output contains tool-call protocol text.",
    };
  }
  for (const forbidden of forbiddenContent) {
    if (forbidden && trimmed.includes(forbidden)) {
      return {
        ok: false,
        reason: `Output contains forbidden content: ${forbidden}.`,
      };
    }
  }
  return {
    ok: true,
    text: trimmed,
  };
}
