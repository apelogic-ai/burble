export const runtimeEngines = [
  "deterministic",
  "openclaw",
  "openclaw-gateway",
  "burble-direct",
  "hermes"
] as const;

export type AgentRuntimeEngine = (typeof runtimeEngines)[number];

export function isAgentRuntimeEngine(
  value: unknown
): value is AgentRuntimeEngine {
  return typeof value === "string" && runtimeEngines.includes(value as never);
}
