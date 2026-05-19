import { describe, expect, test } from "bun:test";

const compose = await Bun.file("deploy/dev/compose/docker-compose.yml").text();
const caddyfile = await Bun.file("deploy/dev/compose/Caddyfile").text();

describe("dev deploy config", () => {
  test("runs the Burble Bun app behind Caddy", () => {
    expect(compose).toContain("burble-app:");
    expect(compose).toContain("dockerfile: Dockerfile");
    expect(compose).toContain('"3000"');
    expect(compose).toContain("http://localhost:3000/healthz");
    expect(caddyfile).toContain("reverse_proxy burble-app:3000");
  });

  test("passes Slack and GitHub OAuth settings to the app", () => {
    for (const name of [
      "SLACK_BOT_TOKEN",
      "SLACK_APP_TOKEN",
      "GITHUB_CLIENT_ID",
      "GITHUB_CLIENT_SECRET",
      "BASE_URL",
      "DATABASE_PATH"
    ]) {
      expect(compose).toContain(name);
    }
  });

  test("does not reference Observer runtime service names", () => {
    expect(compose).not.toContain("observer-api");
    expect(compose).not.toContain("OBSERVER_");
    expect(caddyfile).not.toContain("ingestor");
  });
});
