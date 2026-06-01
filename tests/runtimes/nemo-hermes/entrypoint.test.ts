import { describe, expect, test } from "bun:test";

function runHermesEntrypointProbe(source: string): unknown {
  const proc = Bun.spawnSync(["python3", "-c", source], {
    stdout: "pipe",
    stderr: "pipe"
  });
  const stdout = new TextDecoder().decode(proc.stdout);
  const stderr = new TextDecoder().decode(proc.stderr);
  if (proc.exitCode !== 0) {
    throw new Error(`python probe failed:\n${stdout}\n${stderr}`);
  }
  return JSON.parse(stdout);
}

const importEntrypoint = String.raw`
import importlib.util
import json
import sys
import types

aiohttp = types.ModuleType("aiohttp")
aiohttp.ClientSession = object
aiohttp.ClientTimeout = object
aiohttp.web = types.SimpleNamespace()
sys.modules["aiohttp"] = aiohttp

spec = importlib.util.spec_from_file_location(
    "burble_hermes_entrypoint",
    "runtimes/nemo-hermes/runtime/entrypoint.py",
)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
`;

describe("nemo-hermes entrypoint", () => {
  test("builds bounded Burble context for Hermes turns", () => {
    const result = runHermesEntrypointProbe(`${importEntrypoint}
payload = {
    "text": "what changed?",
    "toolGroups": {
        "groups": ["conversation", "github"],
        "reasons": ["default:conversation", "keyword:github:github"],
    },
    "context": {
        "recentMessages": [
            {
                "author": "user",
                "speaker": "Leo",
                "text": "old message should not be included",
            },
            *[
                {
                    "author": "assistant",
                    "speaker": "Burble",
                    "text": f"recent message {index} " + ("x" * 500),
                }
                for index in range(2, 21)
            ],
        ],
    },
}
print(json.dumps({"text": mod.build_hermes_turn_text(payload)}))
`);

    const text = (result as { text: string }).text;
    expect(text).toContain("User request:");
    expect(text).toContain("what changed?");
    expect(text).toContain("Selected Burble tool groups: conversation, github");
    expect(text).toContain("Recent Burble context");
    expect(text).not.toContain("old message should not be included");
    expect(text).toContain("recent message 20");
    expect(text).not.toContain("x".repeat(350));
  });

  test("uses per-run Hermes thread ids by default", () => {
    const result = runHermesEntrypointProbe(`${importEntrypoint}
print(json.dumps({
    "run": mod.build_hermes_thread_id(
        "run-123",
        {"rootId": "dm:D123"},
        scope="run",
    ),
    "conversation": mod.build_hermes_thread_id(
        "run-123",
        {"rootId": "dm:D123"},
        scope="conversation",
    ),
}))
`);

    expect(result).toEqual({
      run: "run-123",
      conversation: "dm:D123"
    });
  });
});
