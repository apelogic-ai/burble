import { readFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";
import { buildRuntimeContractJsonSchema } from "@burble/runtime-sdk/json-schema";

describe("runtime SDK JSON Schema", () => {
  test("keeps the checked-in contract schema generated from zod", async () => {
    const expected = `${JSON.stringify(buildRuntimeContractJsonSchema(), null, 2)}\n`;
    const actual = await readFile(
      "packages/runtime-sdk/schema/runtime-contract.schema.json",
      "utf8"
    );

    expect(actual).toBe(expected);
  });
});
