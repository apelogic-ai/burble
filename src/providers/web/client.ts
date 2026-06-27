import type { ToolResult } from "../../tools/types";

export type WebSearchInput = {
  query: string;
  limit?: number;
};

export type WebSearchResult = {
  title: string;
  url: string;
  snippet?: string;
  source?: string;
  publishedAt?: string;
};

export type WebFetch = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

export type WebSearchDeps = {
  fetch?: WebFetch;
};

const maxResults = 10;

export async function searchWeb(
  input: WebSearchInput,
  deps: WebSearchDeps = {}
): Promise<ToolResult<{ query: string; results: WebSearchResult[] }>> {
  const query = input.query.trim();
  const limit = clampLimit(input.limit);
  const fetchImpl = deps.fetch ?? fetch;
  const url = new URL("https://news.google.com/rss/search");
  url.searchParams.set("q", query);
  url.searchParams.set("hl", "en-US");
  url.searchParams.set("gl", "US");
  url.searchParams.set("ceid", "US:en");

  const response = await fetchImpl(url, {
    headers: {
      "user-agent": "Burble-WebSearch/0.1"
    }
  });
  if (!response.ok) {
    throw new Error(`web_search failed: HTTP ${response.status}`);
  }

  const xml = await response.text();
  return {
    classification: "public",
    content: {
      query,
      results: parseGoogleNewsRss(xml).slice(0, limit)
    }
  };
}

function clampLimit(value: number | undefined): number {
  if (!Number.isFinite(value ?? NaN)) {
    return 5;
  }
  return Math.max(1, Math.min(maxResults, Math.trunc(value as number)));
}

function parseGoogleNewsRss(xml: string): WebSearchResult[] {
  return matchXmlBlocks(xml, "item").flatMap((item) => {
    const title = readXmlText(item, "title");
    const url = readXmlText(item, "link");
    if (!title || !url) {
      return [];
    }
    return [
      {
        title,
        url,
        ...(readXmlText(item, "description")
          ? { snippet: stripHtml(readXmlText(item, "description") ?? "") }
          : {}),
        ...(readXmlText(item, "source")
          ? { source: readXmlText(item, "source") ?? undefined }
          : {}),
        ...(readXmlText(item, "pubDate")
          ? { publishedAt: readXmlText(item, "pubDate") ?? undefined }
          : {})
      }
    ];
  });
}

function matchXmlBlocks(xml: string, tag: string): string[] {
  const pattern = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "gi");
  return [...xml.matchAll(pattern)].map((match) => match[1] ?? "");
}

function readXmlText(xml: string, tag: string): string | null {
  const pattern = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i");
  const match = pattern.exec(xml);
  const raw = match?.[1]?.trim();
  return raw ? decodeXml(raw) : null;
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function decodeXml(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .trim();
}
