export type WorkflowTemplateOptions = {
  missingBindingMessage?: (path: string) => string;
};

const TEMPLATE_VARIABLE_RE = /\{(?<name>[A-Za-z0-9_.-]+)\}/g;
const TEMPLATE_EXPRESSION_RE = /\{(?<body>[^{}]*)\}/g;

export function workflowTemplateVariables(value: unknown): string[] {
  const variables = new Set<string>();
  visitTemplateValue(value, (text) => {
    const matches = text.matchAll(TEMPLATE_VARIABLE_RE);
    for (const match of matches) {
      const name = match.groups?.name;
      if (name) {
        variables.add(name);
      }
    }
  });
  return [...variables].sort();
}

export function unsupportedWorkflowTemplateExpressions(
  value: unknown,
): string[] {
  const expressions = new Set<string>();
  visitTemplateValue(value, (text) => {
    const matches = text.matchAll(TEMPLATE_EXPRESSION_RE);
    for (const match of matches) {
      const body = match.groups?.body;
      if (!body || /^[A-Za-z0-9_.-]+$/.test(body)) {
        continue;
      }
      expressions.add(match[0]);
    }
  });
  return [...expressions].sort();
}

export function resolveWorkflowTemplateValue(
  value: unknown,
  bindings: Record<string, unknown>,
  options: WorkflowTemplateOptions = {},
): unknown {
  if (typeof value === "string") {
    const exactMatch = /^\{(?<name>[A-Za-z0-9_.-]+)\}$/.exec(value);
    const exactName = exactMatch?.groups?.name;
    if (exactName) {
      return readWorkflowBinding(bindings, exactName, options);
    }
    return resolveWorkflowTemplateString(value, bindings, options);
  }
  if (Array.isArray(value)) {
    return value.map((item) =>
      resolveWorkflowTemplateValue(item, bindings, options),
    );
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      resolveWorkflowTemplateValue(item, bindings, options),
    ]),
  );
}

export function resolveWorkflowTemplateString(
  value: string,
  bindings: Record<string, unknown>,
  options: WorkflowTemplateOptions = {},
): string {
  return value.replace(TEMPLATE_VARIABLE_RE, (_match: string, name: string) => {
    const binding = readWorkflowBinding(bindings, name, options);
    if (typeof binding === "object" && binding !== null) {
      throw new Error(`Workflow value ${name} cannot be interpolated as text.`);
    }
    return String(binding);
  });
}

export function readWorkflowBinding(
  bindings: Record<string, unknown>,
  path: string,
  options: WorkflowTemplateOptions = {},
): unknown {
  const parts = path.split(".");
  let current: unknown = bindings;
  for (const part of parts) {
    if (!current || typeof current !== "object" || !(part in current)) {
      throw new Error(
        options.missingBindingMessage?.(path) ??
          `Unbound workflow value ${path}`,
      );
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function visitTemplateValue(
  value: unknown,
  visitString: (text: string) => void,
): void {
  if (typeof value === "string") {
    visitString(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      visitTemplateValue(item, visitString);
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  for (const item of Object.values(value)) {
    visitTemplateValue(item, visitString);
  }
}
