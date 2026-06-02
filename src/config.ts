import { z } from "zod";
import type { Platform } from "./schema";

// ─── Config schema (all fields optional - Scout degrades gracefully) ──────────

export const ScoutConfigSchema = z.object({
  searxngUrl: z.string().url().optional(),
  braveApiKey: z.string().optional(),
  handles: z.object({
    reddit: z.string().optional(),
    youtube: z.string().optional(),
    x: z.string().optional(),
    instagram: z.string().optional(),
  }).optional(),
  apifyTokens: z.string().optional(),
});

export type ScoutConfig = z.infer<typeof ScoutConfigSchema>;

export const SCOUT_UA = "scout-scraper/1.0";

// ─── Own profile handles ───────────────────────────────────────────────────────

// ─── Web search backends (optional) ──────────────────────────────────────────
// Set SCOUT_SEARXNG_URL for self-hosted (SearXNG in Docker) or SCOUT_BRAVE_API_KEY for managed.
// If both are set, SearXNG takes priority (zero cost, fully local).
// If neither is set, the "web" source is skipped gracefully - no errors, no impact on other sources.
export const WEB_SEARCH = {
  searxngUrl: process.env.SCOUT_SEARXNG_URL ?? "",
  braveApiKey: process.env.SCOUT_BRAVE_API_KEY ?? "",
  get enabled() { return !!(this.searxngUrl || this.braveApiKey); },
};

// ─── Own profile handles ───────────────────────────────────────────────────────

export const OWN_HANDLES: Partial<Record<Platform, string>> = {
  reddit: process.env.SCOUT_REDDIT_HANDLE ?? "",
  youtube: process.env.SCOUT_YOUTUBE_HANDLE ?? "",
  x: process.env.SCOUT_X_HANDLE ?? "",
  instagram: process.env.SCOUT_IG_HANDLE ?? "",
};

// Call this to inject known handles (e.g. from your profile settings) without env vars.
// Any non-empty override wins over the env-var default.
export function configureHandles(overrides: Partial<Record<Platform, string>>) {
  for (const [platform, handle] of Object.entries(overrides)) {
    if (handle && !OWN_HANDLES[platform as Platform]) {
      OWN_HANDLES[platform as Platform] = handle;
    }
  }
}

// ─── Subreddits (default for search_topic + get_trending) ────────────────────

export const DEFAULT_SUBREDDITS = [
  "MachineLearning",
  "artificial",
  "LocalLLaMA",
  "webdev",
  "SaaS",
  "SideProject",
  "freelance",
  "entrepreneur",
  "OpenAI",
  "nextjs",
];

// ─── YouTube channels (RSS feed IDs) ─────────────────────────────────────────

export const YOUTUBE_CHANNELS: Array<{ name: string; handle: string; id: string }> = [
  { name: "Matt Wolfe",       handle: "@mreflow",         id: "UChpleBmo18P08aKCIgti38g" },
  { name: "Nate Herk",        handle: "@nateherk",         id: "UC2ojq-nuP8ceeHqiroeKhBA" },
  { name: "Vaibhav Sisinty",  handle: "@vaibhavsisinty",  id: "UClXAalunTPaX1YV185DWUeg" },
  { name: "Andrej Karpathy",  handle: "@karpathy",        id: "UCPk8m_r6fkUSYmvgCBwq-sw" },
  { name: "Lex Fridman",      handle: "@lexfridman",      id: "UCSHZKyawb77ixDdsGog4iWA" },
  { name: "AI Explained",     handle: "@aiexplained",     id: "UCNJ1Ymd5yFuUPtn21xtRbbw" },
  { name: "Two Minute Papers",handle: "@twominutepapers", id: "UCbfYPyITQ-7l4upoX8nvctg" },
  { name: "Fireship",         handle: "@fireship",        id: "UCsBjURrPoezykLs9EqgamOA" },
  { name: "Theo - t3.gg",    handle: "@t3dotgg",         id: "UCbRP3c757lWg9M-U7TyEkXA" },
  { name: "ThePrimeagen",     handle: "@theprimeagen",    id: "UC8ENHE5xdFSwx71u3fDH5Xw" },
];

// ─── RSS feeds (always active, no auth) ───────────────────────────────────────

export interface RssFeed {
  name: string;
  url: string;
  category: "tech_news" | "ai_blog" | "arxiv" | "developer" | "freelance";
}

export const RSS_FEEDS: RssFeed[] = [
  // Tech news
  { name: "TechCrunch",         url: "https://techcrunch.com/feed/",                              category: "tech_news" },
  { name: "MIT Tech Review",    url: "https://www.technologyreview.com/feed/",                    category: "tech_news" },
  { name: "VentureBeat",        url: "https://venturebeat.com/feed/",                             category: "tech_news" },
  { name: "TLDR",               url: "https://tldr.tech/rss",                                     category: "tech_news" },
  // AI blogs
  { name: "Simon Willison",     url: "https://simonwillison.net/atom/everything/",                category: "ai_blog"   },
  { name: "Hugging Face Blog",  url: "https://huggingface.co/blog/feed.xml",                      category: "ai_blog"   },
  { name: "Latent Space",       url: "http://www.latent.space/feed",                              category: "ai_blog"   },
  { name: "Ahead of AI",        url: "https://magazine.sebastianraschka.com/feed",                category: "ai_blog"   },
  // ArXiv
  { name: "ArXiv cs.AI",        url: "http://export.arxiv.org/rss/cs.AI",                        category: "arxiv"     },
  { name: "ArXiv cs.LG",        url: "http://export.arxiv.org/rss/cs.LG",                        category: "arxiv"     },
  // Developer
  { name: "HN Front Page",      url: "https://hnrss.org/frontpage",                              category: "developer" },
  { name: "HN Who's Hiring",    url: "https://hnrss.org/whoishiring/jobs",                       category: "developer" },
  { name: "GitHub Trending",    url: "https://mshibanami.github.io/GitHubTrendingRSS/daily/all.xml", category: "developer" },
  { name: "Product Hunt",       url: "https://www.producthunt.com/feed",                         category: "developer" },
  // Freelance / SaaS
  { name: "SaaStr",             url: "https://saastr.com/feed/",                                 category: "freelance" },
  { name: "Indie Hackers",      url: "https://feed.indiehackers.world/",                         category: "freelance" },
];

// ─── Rate limits & timeouts ───────────────────────────────────────────────────

export const RATE_LIMITS = {
  reddit: { maxReqPerMin: 60, delayMs: 0 },
  hn: { maxReqPerMin: 120, delayMs: 0 },
  github: { maxReqPerMin: 30, delayMs: 0 },
  rss: { maxReqPerMin: 60, delayMs: 500 },
};

export const FETCH_TIMEOUT_MS = 10_000;
export const MAX_CONCURRENT = 8;

// ─── Apify token pool ─────────────────────────────────────────────────────────
// Comma-separated Apify API tokens for round-robin rotation.
// Add more accounts by appending ,<token> - no code changes needed.
export const APIFY_TOKENS_RAW = process.env.APIFY_TOKENS ?? "";

// ─── Source quality weights (editorial trust, used in RRF stream weight) ──────
// Values from empirical analysis: HN and GitHub have higher signal-to-noise.
// TODO: add Ollama-based LLM reranking via SCOUT_OLLAMA_URL for zero-cost local rerank.
export const SOURCE_QUALITY: Record<string, number> = {
  hn: 0.80,
  github: 0.75,
  youtube: 0.75,
  rss: 0.65,
  web: 0.65,
  reddit: 0.60,
  x: 0.60,
  instagram: 0.55,
  polymarket: 0.70,
  // Apify-sourced platforms
  linkedin: 0.75,
  upwork: 0.80,
  fiverr: 0.65,
};
