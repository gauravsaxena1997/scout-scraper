/**
 * Direct-URL RSS fetcher for the Outbound Lead Sweep.
 * Moved from src/lib/recon/collectors/rss-fetch.ts.
 *
 * Fetches any per-URL RSS/Atom feed (job boards: RemoteOK, WeWorkRemotely, etc.)
 * and returns items shaped as Pathrix-canonical RawItems. Scout's fetchSingleFeed
 * targets Scout's own configured feed list; this function takes any arbitrary URL.
 */
import crypto from "crypto";

const FETCH_TIMEOUT_MS = 15_000;

// RSS item shape - structural subtype of Pathrix's RawItem.
export type RssItem = {
  source: "OUTBOUND_LEAD";
  sourceItemId: string;
  url: string;
  title: string;
  body: string;
  author: string;
  channel: string;
  intent: "apply";
  publishedAt?: string;
  engagement: { score: number; comments: number };
  scoutScore: number;
  media: never[];
  commentSample: never[];
  rawJson: { feedUrl: string | undefined; raw: string };
};

function extractTag(xml: string, tag: string): string {
  const cdata = xml.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`, "i"));
  if (cdata) return cdata[1].trim();
  const plain = xml.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, "i"));
  return (plain?.[1] ?? "").trim();
}

function extractAttr(xml: string, tag: string, attr: string): string {
  const m = xml.match(new RegExp(`<${tag}[^>]*\\s${attr}="([^"]*)"`, "i"));
  return (m?.[1] ?? "").trim();
}

function splitItems(xml: string): string[] {
  const itemTag = xml.includes("<entry") ? "entry" : "item";
  const parts: string[] = [];
  const re = new RegExp(`<${itemTag}[\\s>]([\\s\\S]*?)</${itemTag}>`, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    parts.push(m[0]);
  }
  return parts;
}

function parseItem(chunk: string, platform: string): RssItem | null {
  const url =
    extractTag(chunk, "link") ||
    extractAttr(chunk, "link", "href") ||
    extractTag(chunk, "id");
  if (!url || !url.startsWith("http")) return null;

  const title = extractTag(chunk, "title") || extractTag(chunk, "dc:title") || "(no title)";
  const body =
    extractTag(chunk, "description") ||
    extractTag(chunk, "summary") ||
    extractTag(chunk, "content:encoded") ||
    extractTag(chunk, "content") ||
    "";
  const guid = extractTag(chunk, "guid") || url;
  const published =
    extractTag(chunk, "pubDate") ||
    extractTag(chunk, "published") ||
    extractTag(chunk, "updated") ||
    extractTag(chunk, "dc:date") ||
    "";
  const author =
    extractTag(chunk, "dc:creator") || extractTag(chunk, "author") || platform;

  let publishedAt: string | undefined;
  if (published) {
    try {
      publishedAt = new Date(published).toISOString();
    } catch {
      publishedAt = undefined;
    }
  }

  const idHash = crypto.createHash("sha256").update(guid).digest("hex").slice(0, 16);
  return {
    source: "OUTBOUND_LEAD",
    sourceItemId: `rss:${platform}:${idHash}`,
    url,
    title: title.slice(0, 300),
    body: body.replace(/<[^>]+>/g, "").slice(0, 1500),
    author,
    channel: platform,
    intent: "apply",
    publishedAt,
    engagement: { score: 0, comments: 0 },
    scoutScore: 0,
    media: [],
    commentSample: [],
    rawJson: { feedUrl: undefined, raw: chunk.slice(0, 2000) },
  };
}

export interface FetchRssResult {
  url: string;
  platform: string;
  itemCountRaw: number;
  items: RssItem[];
  fetchedAt: string;
  error?: string;
}

export async function fetchRssFeed(args: {
  url: string;
  platform: string;
  limit?: number;
}): Promise<FetchRssResult> {
  const { url, platform, limit = 50 } = args;
  const fetchedAt = new Date().toISOString();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Pathrix-RSS/1.0",
        Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      return { url, platform, itemCountRaw: 0, items: [], fetchedAt, error: `http_${res.status}` };
    }
    const xml = await res.text();
    const chunks = splitItems(xml);
    const items = chunks
      .map((c) => parseItem(c, platform))
      .filter((x): x is RssItem => x !== null)
      .slice(0, limit);
    return { url, platform, itemCountRaw: chunks.length, items, fetchedAt };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    return { url, platform, itemCountRaw: 0, items: [], fetchedAt, error: msg };
  } finally {
    clearTimeout(timeout);
  }
}
