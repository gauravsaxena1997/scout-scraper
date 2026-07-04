import { FETCH_TIMEOUT_MS, SCOUT_UA, WEB_SEARCH } from "../config";
import { urlToId } from "../store/db";
import type { RawItem } from "../schema";
import { scoreItem } from "../intelligence/score";

type SearchProviderResult = {
  title?: unknown;
  url?: unknown;
  content?: unknown;
  description?: unknown;
  publishedDate?: unknown;
  page_age?: unknown;
  engines?: unknown;
};

type SearchProviderResponse = {
  results?: unknown;
  web?: {
    results?: unknown;
  };
};

async function fetchJson(url: string, headers: Record<string, string> = {}): Promise<SearchProviderResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) throw new Error(`http_${res.status}`);
    const json = await res.json() as unknown;
    return typeof json === "object" && json !== null && !Array.isArray(json) ? json as SearchProviderResponse : {};
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchText(url: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": `Mozilla/5.0 AppleWebKit/537.36 Chrome/126 Safari/537.36 ${SCOUT_UA}`,
        Accept: "text/html,application/xhtml+xml",
      },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`http_${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timeout);
  }
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, "\"")
    .replace(/&#x2F;/g, "/");
}

function stripTags(value: string): string {
  return decodeHtml(value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

function buildRawItem(args: {
  url: string;
  title: string;
  body?: string;
  author?: string;
  publishedAt?: string;
}): RawItem | null {
  if (!args.url || !args.title) return null;
  const raw: RawItem = {
    id: urlToId(args.url),
    source: "web",
    title: stripTags(args.title).slice(0, 200),
    body: stripTags(args.body ?? "").slice(0, 700),
    url: args.url,
    author: args.author ?? "web",
    publishedAt: args.publishedAt ?? new Date().toISOString(),
    scoutScore: 0,
    engagement: { score: 0, comments: 0 },
  };
  raw.scoutScore = scoreItem(raw);
  return raw;
}

function mapSearxResult(result: SearchProviderResult): RawItem | null {
  const engines = Array.isArray(result.engines) ? result.engines : [];
  return buildRawItem({
    url: asString(result.url),
    title: asString(result.title),
    body: asString(result.content),
    author: asString(engines[0]) || "searxng",
    publishedAt: asString(result.publishedDate) || undefined,
  });
}

function mapBraveResult(result: SearchProviderResult): RawItem | null {
  return buildRawItem({
    url: asString(result.url),
    title: asString(result.title),
    body: asString(result.description),
    author: "brave",
    publishedAt: asString(result.page_age) || undefined,
  });
}

async function searchSearXNG(query: string, limit: number): Promise<RawItem[]> {
  const params = new URLSearchParams({ q: query, format: "json" });
  const data = await fetchJson(`${WEB_SEARCH.searxngUrl}/search?${params}`);
  const results = Array.isArray(data.results) ? data.results : [];
  return results
    .map((result) => mapSearxResult(typeof result === "object" && result !== null ? result as SearchProviderResult : {}))
    .filter((item): item is RawItem => item !== null)
    .slice(0, limit);
}

async function searchBrave(query: string, limit: number): Promise<RawItem[]> {
  const params = new URLSearchParams({ q: query, count: String(Math.min(limit, 20)) });
  const data = await fetchJson(
    `https://api.search.brave.com/res/v1/web/search?${params}`,
    { "X-Subscription-Token": WEB_SEARCH.braveApiKey, Accept: "application/json" },
  );
  const results = Array.isArray(data.web?.results) ? data.web.results : [];
  return results
    .map((result) => mapBraveResult(typeof result === "object" && result !== null ? result as SearchProviderResult : {}))
    .filter((item): item is RawItem => item !== null)
    .slice(0, limit);
}

function resultUrl(value: string): string {
  const decoded = decodeHtml(value);
  try {
    const url = new URL(decoded, "https://duckduckgo.com");
    const uddg = url.searchParams.get("uddg");
    if (uddg) return decodeURIComponent(uddg);
    const bingEncodedUrl = url.searchParams.get("u");
    if (bingEncodedUrl?.startsWith("a1")) {
      const base64Url = bingEncodedUrl.slice(2).replace(/-/g, "+").replace(/_/g, "/");
      const padded = base64Url.padEnd(Math.ceil(base64Url.length / 4) * 4, "=");
      return Buffer.from(padded, "base64").toString("utf8");
    }
    return decoded;
  } catch {
    return decoded;
  }
}

async function searchBing(query: string, limit: number): Promise<RawItem[]> {
  const params = new URLSearchParams({ q: query, mkt: "en-US", setlang: "en-US" });
  const html = await fetchText(`https://www.bing.com/search?${params.toString()}`);
  const blocks = html.match(/<li class="b_algo"[\s\S]*?<\/li>/g) ?? [];
  const items: RawItem[] = [];
  for (const block of blocks) {
    const linkMatch = block.match(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h2>/i);
    if (!linkMatch) continue;
    const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const item = buildRawItem({
      url: resultUrl(linkMatch[1]),
      title: linkMatch[2],
      body: snippetMatch?.[1] ?? "",
      author: "bing",
    });
    if (item) items.push(item);
    if (items.length >= limit) break;
  }
  return items;
}

export async function searchWeb(query: string, limit = 15): Promise<RawItem[]> {
  if (WEB_SEARCH.searxngUrl) return searchSearXNG(query, limit);
  if (WEB_SEARCH.braveApiKey) return searchBrave(query, limit);
  return searchBing(query, limit);
}
