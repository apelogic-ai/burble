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
      text: template.replace(
        /\{(?<field>[A-Za-z0-9_.-]+)\}/g,
        (_match: string, field: string) =>
          String(readOutputItemField(item, field)),
      ),
    };
  } catch (error) {
    return {
      ok: false,
      reason:
        error instanceof Error ? error.message : "Output item render failed.",
    };
  }
}

function readOutputItemField(
  item: Record<string, unknown>,
  fieldPath: string,
): unknown {
  const parts = fieldPath.split(".");
  let current: unknown = item;
  for (const part of parts) {
    if (!current || typeof current !== "object" || !(part in current)) {
      throw new Error(`Output item is missing required field ${fieldPath}.`);
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function validateRenderedOutput(
  text: string,
  forbiddenContent: string[],
): TaskOutputRenderResult {
  const trimmed = text.trim();
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
