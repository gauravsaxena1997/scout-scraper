import crypto from "crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Platform } from "./schema";
import type { RawItem } from "./schema";
import type { OnEventHook } from "./index";
import { applyScores } from "./intelligence/score";
import { rrfFuse, buildStreams, nearDedup } from "./intelligence/fusion";
import { runScrapers } from "./intelligence/parallel";
import { SOURCE_QUALITY, OWN_HANDLES, WEB_SEARCH } from "./config";
import { saveRun, saveItems, searchItems, saveProfileSnapshot, getLatestProfileSnapshot, resolveThread, getRecentItems, urlToId } from "./store/db";

// ─── Lazy scraper imports ─────────────────────────────────────────────────────
// Standard scrapers (no native binary deps): statically bundled by Turbopack.
import * as _reddit     from "./scrapers/reddit";
import * as _hn         from "./scrapers/hn";
import * as _github     from "./scrapers/github";
import * as _rss        from "./scrapers/rss";
import * as _youtube    from "./scrapers/youtube";
import * as _apify      from "./scrapers/apify";
import * as _web        from "./scrapers/web";

async function getReddit()       { return _reddit; }
async function getHn()           { return _hn; }
async function getGithub()       { return _github; }
async function getRss()          { return _rss; }
async function getYoutube()      { return _youtube; }
async function getApifyScraper() { return _apify; }
async function getWeb()          { return _web; }

// X, Instagram, Polymarket use spawnSync with paths to external binaries
// (bird-search.mjs, Python scripts). Turbopack's static analysis sees the
// path string and tries to resolve it as a module — causing build failures.
// Dynamic import with webpackIgnore prevents that analysis.
// If the import fails at runtime (e.g. Turbopack chunk path mismatch in prod),
// we fall back to stub modules so the scraper returns empty instead of crashing.

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- fallback stubs need loose typing
type AnyModule = Record<string, (...args: any[]) => any>;

async function safeImport(path: string, stubs: AnyModule): Promise<AnyModule> {
  try {
    return await import(/* webpackIgnore: true */ path) as AnyModule;
  } catch {
    return stubs;
  }
}

async function getX() {
  return safeImport("./scrapers/x", {
    searchX:     async () => [],
    scrapeXUser: async () => null,
  });
}
async function getInstagramSearch() {
  return safeImport("./scrapers/instagram", {
    searchInstagram:   async () => [],
    scrapeInstagram:   async () => null,
    getInstagramPosts: async () => [],
  });
}
async function getPolymarket() {
  return safeImport("./scrapers/polymarket", {
    searchPolymarket:    async () => [],
    getTrendingPolymarket: async () => [],
  });
}

// ─── Tool: search_topic ───────────────────────────────────────────────────────

async function runSearchTopic(
  query: string,
  sources: Platform[],
  timeframeDays: number,
  limit: number
) {
  const runId = crypto.randomUUID();
  saveRun(runId, query);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- scraper return shapes vary by platform; unified only at RawItem boundary
  const scraperList: Array<{ name: string; fn: () => Promise<any[]> }> = [];

  if (sources.includes("reddit")) {
    const m = await getReddit();
    scraperList.push({ name: "reddit", fn: () => m.searchReddit(query, 25) });
  }
  if (sources.includes("hn")) {
    const m = await getHn();
    scraperList.push({ name: "hn", fn: () => m.getHnByDate(query, timeframeDays, 20) });
  }
  if (sources.includes("github")) {
    const m = await getGithub();
    scraperList.push({ name: "github", fn: () => m.searchGithub(query, 15) });
  }
  if (sources.includes("rss")) {
    const m = await getRss();
    scraperList.push({ name: "rss", fn: () => m.fetchAllFeeds(["ai_blog", "tech_news", "developer"]) });
  }
  if (sources.includes("youtube")) {
    const m = await getYoutube();
    scraperList.push({ name: "youtube", fn: () => m.searchYoutube(query, 15) });
  }
  if (sources.includes("x")) {
    const m = await getX();
    scraperList.push({ name: "x", fn: () => m.searchX(query, 20) });
  }
  if (sources.includes("instagram")) {
    const m = await getInstagramSearch();
    scraperList.push({ name: "instagram", fn: () => m.searchInstagram(query, 20) });
  }
  if (sources.includes("polymarket")) {
    const m = await getPolymarket();
    scraperList.push({ name: "polymarket", fn: () => m.searchPolymarket(query, 15) });
  }
  if (sources.includes("web") && WEB_SEARCH.enabled) {
    const m = await getWeb();
    scraperList.push({ name: "web", fn: () => m.searchWeb(query, 15) });
  }

  const results = await runScrapers(scraperList);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- grouped map holds mixed scored items before RawItem normalization
  const grouped = new Map<string, any[]>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- allScored accumulates items across platforms before RawItem normalization
  const allScored: any[] = [];
  for (const { name, items } of results) {
    const scored = applyScores(items, query);
    grouped.set(name, scored);
    allScored.push(...scored);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- nearDedup returns mixed scored items; id is accessed dynamically
  const dedupedIds = new Set(nearDedup(allScored).map((i: any) => i.id));
  for (const [src, items] of grouped) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- filter over mixed scored items before RawItem normalization
    grouped.set(src, items.filter((i: any) => dedupedIds.has(i.id)));
  }

  const streams = buildStreams(grouped, SOURCE_QUALITY);
  const fused = rrfFuse(streams, limit);
  saveItems(fused, runId);

  const sourceBreakdown: Partial<Record<Platform, number>> = {};
  for (const [src, items] of grouped) {
    sourceBreakdown[src as Platform] = items.length;
  }

  return {
    query,
    items: fused,
    clusters: [],
    runId,
    generatedAt: new Date().toISOString(),
    sourceBreakdown,
  };
}

// ─── Tool: get_trending ───────────────────────────────────────────────────────

export async function runGetTrending(niche: string, timeframeDays: number, limit: number) {
  return runSearchTopic(niche, ["reddit", "hn", "github", "rss", "youtube", "x", "polymarket", "web"], timeframeDays, limit);
}

// ─── Tool: scrape_platform ────────────────────────────────────────────────────

async function runScrapePlatform(
  platform: Platform,
  inputType: "profile" | "hashtag" | "channel" | "search",
  value: string,
  limit: number
): Promise<RawItem[]> {
  switch (platform) {
    case "youtube": {
      const m = await getYoutube();
      if (inputType === "channel") return m.getYoutubeChannelVideos(value, limit);
      return m.searchYoutube(value, limit);
    }
    case "x": {
      const m = await getX();
      return m.searchX(value, limit);
    }
    case "instagram": {
      if (inputType === "profile") {
        const handle = value.replace(/^@/, "");
        const apify = await getApifyScraper();
        const posts = await apify.getInstagramChannelPosts(handle, limit);
        return posts.map((p) => ({
          id: urlToId(p.url),
          source: "instagram" as const,
          title: (p.caption ?? "").slice(0, 200),
          body: p.caption ?? "",
          url: p.url,
          author: `@${p.author}`,
          publishedAt: p.publishedAt ?? new Date().toISOString(),
          scoutScore: 0,
          engagement: { score: p.likes ?? 0, comments: p.comments ?? 0, ratio: undefined, topComment: undefined, probability: undefined },
          // Carry image URLs + media type forward so the sweep skill can call analyze_image per slide.
          mediaType: p.mediaType,
          imageUrls: p.imageUrls,
          videoUrl: p.videoUrl,
          // Local artifact paths (downloaded by Apify scraper before CDN URLs expire).
          artifacts: {
            postId: p.postId,
            channelHandle: p.author,
            platform: "instagram",
            mediaType: p.mediaType,
            imagePaths: p.imagePaths,
            videoPath: p.videoPath ?? null,
            rawScrapePath: p.rawScrapePath,
            cdnUrlsOriginal: p.cdnUrlsOriginal,
          },
        }));
      }
      const m = await getInstagramSearch();
      return m.searchInstagram(value, limit);
    }
    case "polymarket": {
      const m = await getPolymarket();
      return m.searchPolymarket(value, limit);
    }
    case "web": {
      const m = await getWeb();
      return m.searchWeb(value, limit);
    }
    case "reddit": {
      const m = await getReddit();
      return m.searchReddit(value, limit);
    }
    case "hn": {
      const m = await getHn();
      return m.getHnByDate(value, 30, limit);
    }
    case "github": {
      const m = await getGithub();
      return m.searchGithub(value, limit);
    }
    default:
      throw new Error(`scrape_platform: unsupported platform "${platform}"`);
  }
}

// ─── Tool: scrape_own_profiles ────────────────────────────────────────────────

async function runScrapeOwnProfiles(platforms: Platform[]) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- results hold mixed platform snapshot shapes; typed at ProfileSnapshot boundary per platform
  const results: any[] = [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- scraper fn returns platform-specific snapshot; shape unknown at call site
  const scrapeOne = async (platform: Platform, handle: string, fn: () => Promise<any>) => {
    try {
      const snapshot = await fn();
      saveProfileSnapshot(snapshot);
      results.push({ platform, status: "ok", snapshot });
    } catch (err) {
      results.push({ platform, status: "error", error: (err as Error).message });
    }
  };

  if (platforms.includes("reddit")) {
    const handle = OWN_HANDLES.reddit;
    if (handle) {
      const m = await getReddit();
      await scrapeOne("reddit", handle, () => m.scrapeOwnProfile(handle));
    } else {
      results.push({ platform: "reddit", status: "skipped", reason: "SCOUT_REDDIT_HANDLE not set" });
    }
  }

  if (platforms.includes("youtube")) {
    const handle = OWN_HANDLES.youtube;
    if (handle) {
      const m = await getYoutube();
      await scrapeOne("youtube", handle, () => m.scrapeYoutubeProfile(handle));
    } else {
      results.push({ platform: "youtube", status: "skipped", reason: "SCOUT_YOUTUBE_HANDLE not set" });
    }
  }

  if (platforms.includes("x")) {
    const handle = OWN_HANDLES.x;
    if (handle) {
      const m = await getX();
      await scrapeOne("x", handle, () => m.scrapeXProfile(handle));
    } else {
      results.push({ platform: "x", status: "skipped", reason: "SCOUT_X_HANDLE not set or SCOUT_X_AUTH_TOKEN missing" });
    }
  }

  if (platforms.includes("instagram")) {
    const handle = OWN_HANDLES.instagram;
    if (handle) {
      const apify = await getApifyScraper();
      await scrapeOne("instagram", handle, async () => {
        const posts = await apify.getInstagramChannelPosts(handle, 30);
        return {
          platform: "instagram" as const,
          handle,
          fetchedAt: new Date().toISOString(),
          followers: 0,
          posts: posts.map((p) => ({
            id: p.postId,
            url: p.url,
            content: p.caption,
            publishedAt: p.publishedAt,
            likes: p.likes,
            comments: p.comments,
            shares: 0,
            views: 0,
            isViral: p.likes > 10_000,
          })),
          stats: {},
        };
      });
    } else {
      results.push({ platform: "instagram", status: "skipped", reason: "SCOUT_IG_HANDLE not set" });
    }
  }

  return results;
}

// ─── Tool: scout_search_fts ───────────────────────────────────────────────────

async function runFtsSearch(q: string, limit: number) {
  return searchItems(q, limit);
}

// ─── Tool: raw_scrape ─────────────────────────────────────────────────────────

async function runRawScrape(query: string, sources: Platform[], timeframeDays: number, limit: number) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- scraper return shapes vary by platform; unified only at RawItem boundary
  const scraperList: Array<{ name: string; fn: () => Promise<any[]> }> = [];

  if (sources.includes("reddit")) {
    const m = await getReddit();
    scraperList.push({ name: "reddit", fn: () => m.searchReddit(query, limit) });
  }
  if (sources.includes("hn")) {
    const m = await getHn();
    scraperList.push({ name: "hn", fn: () => m.getHnByDate(query, timeframeDays, limit) });
  }
  if (sources.includes("github")) {
    const m = await getGithub();
    scraperList.push({ name: "github", fn: () => m.searchGithub(query, limit) });
  }
  if (sources.includes("rss")) {
    const m = await getRss();
    scraperList.push({ name: "rss", fn: () => m.fetchAllFeeds() });
  }
  if (sources.includes("youtube")) {
    const m = await getYoutube();
    scraperList.push({ name: "youtube", fn: () => m.searchYoutube(query, limit) });
  }
  if (sources.includes("x")) {
    const m = await getX();
    scraperList.push({ name: "x", fn: () => m.searchX(query, limit) });
  }
  if (sources.includes("instagram")) {
    const m = await getInstagramSearch();
    scraperList.push({ name: "instagram", fn: () => m.searchInstagram(query, limit) });
  }
  if (sources.includes("polymarket")) {
    const m = await getPolymarket();
    scraperList.push({ name: "polymarket", fn: () => m.searchPolymarket(query, limit) });
  }
  if (sources.includes("web") && WEB_SEARCH.enabled) {
    const m = await getWeb();
    scraperList.push({ name: "web", fn: () => m.searchWeb(query, limit) });
  }

  const results = await runScrapers(scraperList);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- perSource holds raw per-platform results before RawItem normalization
  const perSource: Record<string, any[]> = {};
  let totalItems = 0;
  for (const { name, items } of results) {
    perSource[name] = items.slice(0, limit);
    totalItems += perSource[name].length;
  }
  return { query, sources: perSource, totalItems, fetchedAt: new Date().toISOString() };
}

// ─── Tool: score_and_rank ─────────────────────────────────────────────────────

function runScoreAndRank(items: RawItem[], limit: number) {
  const scored = applyScores(items);
  const grouped = new Map<string, typeof scored>();
  for (const item of scored) {
    const bucket = grouped.get(item.source) ?? [];
    bucket.push(item);
    grouped.set(item.source, bucket);
  }
  const streams = buildStreams(grouped, SOURCE_QUALITY);
  return rrfFuse(streams, limit);
}

// ─── Tool: analyze_video ──────────────────────────────────────────────────────

async function runAnalyzeVideo(urls: string[]) {
  const { analyzeVideos } = await import("./vision/pipeline");
  return analyzeVideos(urls);
}

// ─── Tool: analyze_image ──────────────────────────────────────────────────────

async function runAnalyzeImage(urls: string[]) {
  const { analyzeImages } = await import("./vision/image_analyzer");
  return analyzeImages(urls);
}

// ─── Platform enum (shared across MCP tool schemas) ──────────────────────────

const PLATFORM_ENUM = z.enum(["reddit", "hn", "github", "rss", "youtube", "x", "instagram", "polymarket", "web"]);

// ─── Apify scraper alias (single bundled import, see getApifyScraper above) ──
const getApify = getApifyScraper;

// ─── Register all Scout tools on the MCP server ───────────────────────────────

export function registerScoutTools(mcpServer: McpServer, config?: { onEvent?: OnEventHook }) {
  const emit = (type: string, payload: Record<string, unknown>) =>
    config?.onEvent?.({ type, payload, timestamp: new Date().toISOString() });
  mcpServer.tool(
    "search_topic",
    "Scout: Search a topic across Reddit, HN, GitHub, RSS, YouTube, X, Instagram, and Polymarket. Returns RRF-fused ranked results.",
    {
      query: z.string().describe("Topic or keyword to search"),
      sources: z
        .array(PLATFORM_ENUM)
        .optional()
        .default(["reddit", "hn", "github", "rss"])
        .describe("Sources to include (default: reddit+hn+github+rss). Add youtube, x, instagram, polymarket as needed."),
      timeframe_days: z.number().optional().default(7).describe("Look-back window in days"),
      limit: z.number().optional().default(20).describe("Max results to return"),
    },
    async ({ query, sources, timeframe_days, limit }) => {
      const report = await runSearchTopic(query, sources as Platform[], timeframe_days, limit);
      await emit("scout.search_complete", { query, itemCount: report.items.length, sources });
      return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
    }
  );

  mcpServer.tool(
    "get_trending",
    "Scout: Get trending content for a niche across Reddit, HN, GitHub, RSS, YouTube, X, and Polymarket in the past N days.",
    {
      niche: z.string().describe("Niche or topic e.g. 'AI agents', 'SaaS', 'Next.js'"),
      timeframe_days: z.number().optional().default(7).describe("Days to look back"),
      limit: z.number().optional().default(15).describe("Max results"),
    },
    async ({ niche, timeframe_days, limit }) => {
      const report = await runGetTrending(niche, timeframe_days, limit);
      return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
    }
  );

  mcpServer.tool(
    "scrape_platform",
    "Scout: Targeted scrape of a single platform - profile, hashtag, channel, or keyword search. Returns raw SourceItems without RRF fusion.",
    {
      platform: PLATFORM_ENUM.describe("Platform to scrape"),
      type: z.enum(["profile", "hashtag", "channel", "search"]).describe("What to scrape"),
      value: z.string().describe("Username, hashtag, channel URL, or search query"),
      limit: z.number().optional().default(20).describe("Max results"),
    },
    async ({ platform, type, value, limit }) => {
      const items = await runScrapePlatform(platform as Platform, type, value, limit);
      return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
    }
  );

  mcpServer.tool(
    "scrape_own_profiles",
    "Scout: Scrape own social profiles (Reddit, YouTube, X, Instagram) for follower count, recent posts, and engagement stats. Handles are read from SCOUT_*_HANDLE env vars or set via configureHandles().",
    {
      platforms: z
        .array(z.enum(["reddit", "youtube", "x", "instagram"]))
        .optional()
        .default(["reddit"])
        .describe("Which profiles to scrape"),
    },
    async ({ platforms }) => {
      const results = await runScrapeOwnProfiles(platforms as Platform[]);
      return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
    }
  );

  mcpServer.tool(
    "get_profile_snapshot",
    "Scout: Get the latest stored profile snapshot for a platform.",
    {
      platform: z
        .enum(["reddit", "youtube", "x", "instagram"])
        .describe("Platform to fetch snapshot for"),
    },
    async ({ platform }) => {
      const snapshot = getLatestProfileSnapshot(platform);
      return {
        content: [
          {
            type: "text",
            text: snapshot ? JSON.stringify(snapshot, null, 2) : `No snapshot found for ${platform}`,
          },
        ],
      };
    }
  );

  mcpServer.tool(
    "get_scout_status",
    "Scout: Returns configured handles, last-scraped timestamps per platform, item count in local DB, and stored snapshot summaries. Use this to understand what Scout knows and when it last ran - no scripting needed.",
    {},
    async () => {
      const handles = {
        reddit: OWN_HANDLES.reddit ?? null,
        youtube: OWN_HANDLES.youtube ?? null,
        x: OWN_HANDLES.x ?? null,
        instagram: OWN_HANDLES.instagram ?? null,
      };
      const platforms = ["reddit", "youtube", "x", "instagram"] as const;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- snapshots map holds mixed platform snapshot shapes keyed by platform string
      const snapshots: Record<string, any> = {};
      for (const p of platforms) {
        const snap = getLatestProfileSnapshot(p);
        snapshots[p] = snap
          ? { handle: snap.handle, fetchedAt: snap.fetchedAt, followers: snap.followers, postsCount: snap.posts?.length ?? 0, hasBanner: !!snap.bannerUrl, hasAvatar: !!snap.avatarUrl, pendingThreads: snap.pendingThreads?.length ?? 0 }
          : null;
      }
      const recentItems = getRecentItems(5);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ handles, snapshots, recentScoutItems: recentItems.length > 0 ? `${recentItems.length} recent items, latest: "${recentItems[0]?.title?.slice(0,60)}"` : "none" }, null, 2),
        }],
      };
    }
  );

  mcpServer.tool(
    "check_pending_threads",
    "Scout: Run a live Reddit profile scrape and return any open threads where someone replied to your comments. Surfaces urgent replies needing a response.",
    {
      platform: z.enum(["reddit"]).describe("Platform to check (currently only reddit)"),
    },
    async ({ platform }) => {
      if (platform !== "reddit") {
        return { content: [{ type: "text", text: "Only Reddit is supported currently." }] };
      }
      const handle = OWN_HANDLES.reddit;
      if (!handle) {
        return { content: [{ type: "text", text: "No Reddit handle configured. Call configureHandles({ reddit: 'yourhandle' }) first." }] };
      }
      const { scrapeOwnProfile } = await import("./scrapers/reddit");
      const snapshot = await scrapeOwnProfile(handle);
      saveProfileSnapshot(snapshot);

      const threads = snapshot.pendingThreads ?? [];
      if (threads.length === 0) {
        return { content: [{ type: "text", text: "No open threads - inbox is clear." }] };
      }

      const lines = threads.map((t) =>
        `[${t.isUrgent ? "URGENT" : "PENDING"}] r/${t.subreddit} - "${t.postTitle.slice(0, 60)}"\n` +
        `  My comment: "${t.myCommentBody.slice(0, 100)}..."\n` +
        `  Reply from u/${t.latestReply.author} (${t.latestReply.publishedAt.slice(0, 10)}): "${t.latestReply.body.slice(0, 150)}..."\n` +
        `  Reply link: ${t.latestReply.url}\n` +
        `  My comment link: ${t.myCommentUrl}`
      );
      return {
        content: [
          {
            type: "text",
            text: `${threads.length} open thread(s) found:\n\n${lines.join("\n\n")}`,
          },
        ],
      };
    }
  );

  mcpServer.tool(
    "resolve_thread",
    "Scout: Mark a Reddit comment thread as resolved so it no longer appears as pending. Call this after replying or deciding not to reply.",
    {
      platform: z.enum(["reddit"]).describe("Platform"),
      comment_id: z.string().describe("The comment ID to resolve, e.g. t1_abc123"),
    },
    async ({ platform, comment_id }) => {
      resolveThread(platform, comment_id);
      return { content: [{ type: "text", text: `Thread ${comment_id} on ${platform} marked as resolved.` }] };
    }
  );

  mcpServer.tool(
    "scout_search",
    "Scout: Full-text search over previously fetched Scout items stored in local SQLite.",
    {
      query: z.string().describe("Full-text search query"),
      limit: z.number().optional().default(20).describe("Max results"),
    },
    async ({ query, limit }) => {
      const items = await runFtsSearch(query, limit);
      return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
    }
  );

  mcpServer.tool(
    "raw_scrape",
    "Scout: Scrape sources without the intelligence layer. Returns raw per-source results with no scoring or RRF fusion.",
    {
      query: z.string().describe("Topic or keyword to search"),
      sources: z
        .array(PLATFORM_ENUM)
        .optional()
        .default(["reddit", "hn", "github", "rss"])
        .describe("Sources to scrape"),
      timeframe_days: z.number().optional().default(7).describe("Look-back window in days"),
      limit: z.number().optional().default(10).describe("Max results per source"),
    },
    async ({ query, sources, timeframe_days, limit }) => {
      const result = await runRawScrape(query, sources as Platform[], timeframe_days, limit);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  mcpServer.tool(
    "score_and_rank",
    "Scout: Run the intelligence layer (scoring + RRF fusion) on items you already have.",
    {
      items: z
        .array(
          z.object({
            id: z.string(),
            source: z.string(),
            title: z.string(),
            body: z.string().optional().default(""),
            url: z.string().optional().default(""),
            author: z.string().optional().default(""),
            engagement: z
              .object({ score: z.number().optional().default(0), comments: z.number().optional().default(0) })
              .optional()
              .default({ score: 0, comments: 0 }),
            publishedAt: z.string().optional().default(""),
            scoutScore: z.number().optional().default(0),
          })
        )
        .describe("Raw items to score and rank"),
      limit: z.number().optional().default(20).describe("Max results after fusion"),
    },
    async ({ items, limit }) => {
      const ranked = runScoreAndRank(items as RawItem[], limit);
      return { content: [{ type: "text", text: JSON.stringify(ranked, null, 2) }] };
    }
  );

  mcpServer.tool(
    "analyze_video",
    "Scout: Download and transcribe one or more public videos (YouTube, Instagram, any yt-dlp-supported URL). Also accepts direct CDN/MP4 URLs (e.g. from Apify scrapes) - skips yt-dlp for those. Returns transcript + metadata.",
    {
      urls: z.array(z.string().url()).describe("One or more video URLs to analyze. Accepts YouTube/Instagram post URLs or direct CDN MP4 URLs."),
    },
    async ({ urls }) => {
      const results = await runAnalyzeVideo(urls);
      return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
    }
  );

  mcpServer.tool(
    "analyze_image",
    "Scout: Analyze one or more images using a local Ollama vision model (default: gemma4:latest). Extracts all visible text and describes visual content - handles infographics, charts, styled slides, and photos. Ideal for processing carousel posts from Instagram scrapes. Override model via SCOUT_VISION_MODEL env var.",
    {
      urls: z.array(z.string().url()).describe("One or more image URLs to analyze (JPG, PNG, WebP, GIF). Accepts direct CDN URLs from Apify Instagram scrapes."),
    },
    async ({ urls }) => {
      const results = await runAnalyzeImage(urls);
      return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
    }
  );

  mcpServer.tool(
    "get_reddit_comments",
    "Scout: Fetch and flatten the comment tree for a Reddit post. Returns up to `limit` comments sorted by top, flattened from nested replies up to `depth` levels. Used by the Recon hydrator and the /run-recon-sweep slash command.",
    {
      post_url: z.string().url().describe("Full Reddit post URL (www or old.reddit.com)"),
      limit: z.number().optional().default(20).describe("Max comments to fetch from Reddit API"),
      depth: z.number().optional().default(2).describe("Reply tree depth to traverse"),
    },
    async ({ post_url, limit, depth }) => {
      const { getComments } = await import("./scrapers/reddit");
      const comments = await getComments(post_url, { limit, depth });
      return { content: [{ type: "text", text: JSON.stringify(comments, null, 2) }] };
    }
  );

  mcpServer.tool(
    "scrape_apify",
    `Scout: Run an Apify actor to scrape LinkedIn, Upwork, Fiverr, Instagram, or X. Requires APIFY_TOKENS in .env.

Actors available:
- upwork-jobs          : Upwork job listings (query = search keyword, e.g. "react developer")
- linkedin-jobs        : LinkedIn job listings (query = keyword, e.g. "next.js engineer")
- linkedin-profiles    : LinkedIn profiles (query = profile URL or comma-separated URLs)
- linkedin-posts       : Posts from a LinkedIn profile (query = profile URL)
- linkedin-enrichment  : Enrich LinkedIn profiles with live data (query = profile URL or comma-separated)
- linkedin-full-profiles: Full LinkedIn profile with email + phone (query = profile URL)
- instagram-posts      : Instagram posts from a user (query = username, e.g. "levelsio")
- instagram-profiles   : Instagram profile bio + posts (query = username)
- fiverr-listings      : Fiverr gig search (query = keyword, e.g. "react developer")
- x-posts              : X/Twitter posts from a user (query = username, e.g. "levelsio")

Returns RawItem[] normalized to Scout schema, ready for score_and_rank or downstream processing.`,
    {
      actor: z
        .enum([
          "upwork-jobs",
          "linkedin-jobs",
          "linkedin-profiles",
          "linkedin-posts",
          "linkedin-enrichment",
          "linkedin-full-profiles",
          "peopleperhour-jobs",
          "instagram-posts",
          "instagram-profiles",
          "fiverr-listings",
          "x-posts",
        ])
        .describe("Which Apify actor to run"),
      query: z.string().describe("Search keyword or profile URL - meaning depends on actor (see tool description)"),
      limit: z.number().optional().default(20).describe("Max results to fetch"),
      extra_input: z
        .record(z.string(), z.unknown())
        .optional()
        .default({})
        .describe("Actor-specific input overrides merged on top of defaults (e.g. { location: 'remote' } for linkedin-jobs)"),
    },
    async ({ actor, query, limit, extra_input }) => {
      const { scrapeApify, getApifyStatus } = await getApify();
      const status = getApifyStatus();
      if (!status.configured) {
        return {
          content: [{
            type: "text",
            text: "APIFY_TOKENS not set. Add comma-separated Apify API tokens to .env:\nAPIFY_TOKENS=apify_api_xxx,apify_api_yyy",
          }],
        };
      }
      const items = await scrapeApify(
        actor as import("./scrapers/apify").ApifyActorKey,
        query,
        limit,
        extra_input as Record<string, unknown>
      );
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ actor, query, limit, count: items.length, items }, null, 2),
        }],
      };
    }
  );

  mcpServer.tool(
    "get_apify_status",
    "Scout: Check Apify integration status - whether APIFY_TOKENS is set, how many token accounts are configured, and which actors are available.",
    {},
    async () => {
      const { getApifyStatus } = await getApify();
      const status = getApifyStatus();
      return {
        content: [{
          type: "text",
          text: JSON.stringify(status, null, 2),
        }],
      };
    }
  );
}
