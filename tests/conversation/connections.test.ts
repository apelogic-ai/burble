import { describe, expect, test } from "bun:test";
import { createTokenStore } from "../../src/db";

describe("provider-shaped connection API", () => {
  test("returns GitHub connection without exposing it as a user record", () => {
    const store = createTokenStore(":memory:");
    store.upsertConnectedUser({
      email: "person@example.com",
      slackUserId: "U123",
      githubLogin: "octocat",
      githubToken: "secret-token"
    });

    expect(store.getConnection("github", "person@example.com")).toMatchObject({
      provider: "github",
      email: "person@example.com",
      slackUserId: "U123",
      providerLogin: "octocat",
      accessToken: "secret-token"
    });

    store.close();
  });

  test("returns null for unsupported providers", () => {
    const store = createTokenStore(":memory:");

    expect(store.getConnection("jira", "person@example.com")).toBeNull();

    store.close();
  });
});
