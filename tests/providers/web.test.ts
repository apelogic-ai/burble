import { describe, expect, test } from "bun:test";
import { searchWeb } from "../../src/providers/web/client";

describe("web provider tools", () => {
  test("searches Google News RSS and returns public result records", async () => {
    const requestedUrls: string[] = [];
    const result = await searchWeb(
      { query: "latest AI news", limit: 2 },
      {
        fetch: async (url) => {
          requestedUrls.push(String(url));
          return new Response(
            `
              <rss>
                <channel>
                  <item>
                    <title><![CDATA[AI model release & updates]]></title>
                    <link>https://example.com/ai-release</link>
                    <description><![CDATA[<p>New model details</p>]]></description>
                    <source>Example News</source>
                    <pubDate>Thu, 25 Jun 2026 12:00:00 GMT</pubDate>
                  </item>
                  <item>
                    <title>Second story</title>
                    <link>https://example.com/second</link>
                  </item>
                  <item>
                    <title>Third story</title>
                    <link>https://example.com/third</link>
                  </item>
                </channel>
              </rss>
            `,
            { status: 200 },
          );
        },
      },
    );

    expect(requestedUrls[0]).toContain("https://news.google.com/rss/search");
    expect(requestedUrls[0]).toContain("q=latest+AI+news");
    expect(result).toEqual({
      classification: "public",
      content: {
        query: "latest AI news",
        results: [
          {
            title: "AI model release & updates",
            url: "https://example.com/ai-release",
            snippet: "New model details",
            source: "Example News",
            publishedAt: "Thu, 25 Jun 2026 12:00:00 GMT",
          },
          {
            title: "Second story",
            url: "https://example.com/second",
          },
        ],
      },
    });
  });
});
