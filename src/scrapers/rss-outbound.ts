/**
 * Direct-URL RSS/Atom fetcher.
 *
 * Fetches any per-URL RSS/Atom feed and returns generic feed items. Host
 * applications decide how to map those items into product-specific schemas.
 */
import crypto from "crypto";

const FETCH_TIMEOUT_MS = 15_000;

export type FeedItem = {
  id: string;
  url: string;
  title: string;
  description: string;
  author: string;
  sourceName: string;
  publishedAt?: string;
  raw: string;
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

function parseItem(chunk: string, sourceName: string): FeedItem | null {
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
    extractTag(chunk, "dc:creator") || extractTag(chunk, "author") || sourceName;

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
    id: `rss:${sourceName}:${idHash}`,
    url,
    title: title.slice(0, 300),
    description: body.replace(/<[^>]+>/g, "").slice(0, 1500),
    author,
    sourceName,
    publishedAt,
    raw: chunk.slice(0, 2000),
  };
}

export interface FetchRssResult {
  url: string;
  sourceName: string;
  itemCountRaw: number;
  items: FeedItem[];
  fetchedAt: string;
  error?: string;
}

export async function fetchRssFeed(args: {
  url: string;
  sourceName: string;
  limit?: number;
}): Promise<FetchRssResult> {
  const { url, sourceName, limit = 50 } = args;
  const fetchedAt = new Date().toISOString();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Scout-RSS/1.0",
        Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      return { url, sourceName, itemCountRaw: 0, items: [], fetchedAt, error: `http_${res.status}` };
    }
    const xml = await res.text();
    const chunks = splitItems(xml);
    const items = chunks
      .map((c) => parseItem(c, sourceName))
      .filter((x): x is FeedItem => x !== null)
      .slice(0, limit);
    return { url, sourceName, itemCountRaw: chunks.length, items, fetchedAt };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    return { url, sourceName, itemCountRaw: 0, items: [], fetchedAt, error: msg };
  } finally {
    clearTimeout(timeout);
  }
}
