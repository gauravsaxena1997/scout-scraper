import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerScoutTools } from "../tools";
import { getActorPricing } from "../apify/pricing";
import { listApifyRuns, recoverApifyRun, runApifyActor } from "../apify/runs";
import { fetchAllFeeds, fetchSingleFeed, fetchYouTubeChannelFeed } from "../scrapers/rss";
import { getHnByDate } from "../scrapers/hn";
import { getGithubBlogPosts, getGithubReleases, getTrendingRepos, searchGithubRepos } from "../scrapers/github";
import { getTrendingPolymarket } from "../scrapers/polymarket";
import { searchWeb } from "../scrapers/web";
import { getComments, getSubredditPosts, getSubredditRules, scrapeOwnProfile, searchSubreddit, type RedditSortKind } from "../scrapers/reddit";
import { resolveThread } from "../store/db";
import { getYoutubeChannelVideos } from "../scrapers/youtube";
import { analyzeVideo } from "../vision/pipeline";
import { getInstagramChannelPostsDetailed } from "../scrapers/apify";
import { JOB_NORMALIZERS, collectFromApifyJobs, ApifyIncompleteRunError, type ApifyPlatform } from "../scrapers/apify-jobs";
import { fetchRssFeed } from "../scrapers/rss-outbound";

export type ScoutServerOptions = {
  host?: string;
  port?: number;
  authToken?: string;
};

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8890;

function createScoutMcpServer(): McpServer {
  const server = new McpServer({
    name: "scout-scraper",
    version: "1.0.0",
  });
  registerScoutTools(server);
  return server;
}

function writeJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
  });
  res.end(JSON.stringify(body));
}

function unauthorized(res: ServerResponse): void {
  writeJson(res, 401, { error: "Unauthorized" });
}

function authOk(req: IncomingMessage, token: string | undefined): boolean {
  if (!token) return true;
  const header = req.headers.authorization;
  return header === `Bearer ${token}`;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf-8").trim();
  return text ? JSON.parse(text) : {};
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function asTrendingSince(value: unknown): "daily" | "weekly" | "monthly" {
  if (value === "daily" || value === "weekly" || value === "monthly") return value;
  return "daily";
}

function asGithubBlogSection(value: unknown): "blog" | "changelog" {
  return value === "changelog" ? "changelog" : "blog";
}

function asRedditSort(value: unknown): RedditSortKind {
  if (value === "hot" || value === "new" || value === "top:day" || value === "rising") return value;
  return "hot";
}

function asApifyPlatform(value: unknown): ApifyPlatform | null {
  if (value === "upwork" || value === "linkedin" || value === "peopleperhour") return value;
  return null;
}

async function handleApi(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
  if (req.method !== "POST") {
    writeJson(res, 405, { error: "Method not allowed" });
    return;
  }

  const body = asRecord(await readJson(req));

  if (pathname === "/v1/apify/pricing") {
    const actorId = asString(body.actorId);
    if (!actorId) {
      writeJson(res, 400, { error: "actorId is required" });
      return;
    }
    writeJson(res, 200, await getActorPricing(actorId));
    return;
  }

  if (pathname === "/v1/apify/run") {
    const actorId = asString(body.actorId);
    const input = asRecord(body.input);
    if (!actorId) {
      writeJson(res, 400, { error: "actorId is required" });
      return;
    }
    writeJson(res, 200, await runApifyActor({
      actorId,
      input,
      limit: asNumber(body.limit),
      waitSecs: asNumber(body.waitSecs),
    }));
    return;
  }

  if (pathname === "/v1/apify/recover") {
    const runId = asString(body.runId);
    if (!runId) {
      writeJson(res, 400, { error: "runId is required" });
      return;
    }
    writeJson(res, 200, await recoverApifyRun({
      runId,
      limit: asNumber(body.limit),
    }));
    return;
  }

  if (pathname === "/v1/apify/recover-jobs") {
    const runId = asString(body.runId);
    const platform = asApifyPlatform(body.platform);
    if (!runId || !platform) {
      writeJson(res, 400, { error: "runId and platform are required" });
      return;
    }
    const recovered = await recoverApifyRun({
      runId,
      limit: asNumber(body.limit),
    });
    const normalizer = JOB_NORMALIZERS[platform];
    const items = recovered.items
      .map((item) => normalizer(item, asString(body.query)))
      .filter((item) => item !== null);
    writeJson(res, 200, {
      apifyRunId: recovered.runId,
      status: recovered.status,
      datasetId: recovered.datasetId,
      itemCountRaw: recovered.itemCountRaw,
      items,
      startedAt: recovered.startedAt,
      finishedAt: recovered.finishedAt,
    });
    return;
  }

  if (pathname === "/v1/apify/runs") {
    const actorId = asString(body.actorId);
    if (!actorId) {
      writeJson(res, 400, { error: "actorId is required" });
      return;
    }
    writeJson(res, 200, {
      actorId,
      runs: await listApifyRuns({
        actorId,
        limit: asNumber(body.limit),
        status: typeof body.status === "string" ? body.status : undefined,
      }),
    });
    return;
  }

  if (pathname === "/v1/rss/all") {
    const categories = asStringArray(body.categories)
      .filter((category): category is "tech_news" | "ai_blog" | "arxiv" | "developer" | "freelance" =>
        category === "tech_news" ||
        category === "ai_blog" ||
        category === "arxiv" ||
        category === "developer" ||
        category === "freelance"
      );
    writeJson(res, 200, { items: await fetchAllFeeds(categories.length > 0 ? categories : undefined) });
    return;
  }

  if (pathname === "/v1/rss/single") {
    const url = asString(body.url);
    if (!url) {
      writeJson(res, 400, { error: "url is required" });
      return;
    }
    writeJson(res, 200, { items: await fetchSingleFeed(url, asString(body.name, "feed")) });
    return;
  }

  if (pathname === "/v1/hn/by-date") {
    const query = asString(body.query);
    if (!query) {
      writeJson(res, 400, { error: "query is required" });
      return;
    }
    writeJson(res, 200, {
      items: await getHnByDate(query, asNumber(body.daysBack) ?? 7, asNumber(body.limit) ?? 20),
    });
    return;
  }

  if (pathname === "/v1/github/trending") {
    writeJson(res, 200, {
      items: await getTrendingRepos({
        language: asString(body.language) || undefined,
        limit: asNumber(body.limit) ?? 10,
        since: asTrendingSince(body.since),
      }),
    });
    return;
  }

  if (pathname === "/v1/github/search-repos") {
    const query = asString(body.query);
    if (!query) {
      writeJson(res, 400, { error: "query is required" });
      return;
    }
    writeJson(res, 200, {
      items: await searchGithubRepos({
        query,
        limit: asNumber(body.limit) ?? 10,
        pushedAfter: asString(body.pushedAfter) || undefined,
        sort: body.sort === "stars" ? "stars" : "updated",
      }),
    });
    return;
  }

  if (pathname === "/v1/github/releases") {
    const repositories = asStringArray(body.repositories);
    if (repositories.length === 0) {
      writeJson(res, 400, { error: "repositories is required" });
      return;
    }
    writeJson(res, 200, {
      items: await getGithubReleases({
        repositories,
        limit: asNumber(body.limit) ?? 10,
      }),
    });
    return;
  }

  if (pathname === "/v1/github/blog") {
    writeJson(res, 200, {
      items: await getGithubBlogPosts({
        section: asGithubBlogSection(body.section),
        limit: asNumber(body.limit) ?? 10,
      }),
    });
    return;
  }

  if (pathname === "/v1/web/search") {
    const query = asString(body.query);
    if (!query) {
      writeJson(res, 400, { error: "query is required" });
      return;
    }
    writeJson(res, 200, { items: await searchWeb(query, asNumber(body.limit) ?? 10) });
    return;
  }

  if (pathname === "/v1/youtube/channel-feed") {
    const channelId = asString(body.channelId);
    if (!channelId) {
      writeJson(res, 400, { error: "channelId is required" });
      return;
    }
    writeJson(res, 200, {
      items: await fetchYouTubeChannelFeed(channelId, asString(body.channelName, channelId)),
    });
    return;
  }

  if (pathname === "/v1/youtube/channel-videos") {
    const channelUrl = asString(body.channelUrl);
    if (!channelUrl) {
      writeJson(res, 400, { error: "channelUrl is required" });
      return;
    }
    writeJson(res, 200, {
      items: await getYoutubeChannelVideos(channelUrl, asNumber(body.limit) ?? 10, asString(body.dateAfter) || undefined),
    });
    return;
  }

  if (pathname === "/v1/video/analyze") {
    const url = asString(body.url);
    if (!url) {
      writeJson(res, 400, { error: "url is required" });
      return;
    }
    writeJson(res, 200, await analyzeVideo(url));
    return;
  }

  if (pathname === "/v1/instagram/channel-posts") {
    const handle = asString(body.handle);
    if (!handle) {
      writeJson(res, 400, { error: "handle is required" });
      return;
    }
    const sinceRaw = asString(body.since);
    writeJson(res, 200, await getInstagramChannelPostsDetailed(
      handle,
      asNumber(body.limit) ?? 5,
      sinceRaw ? new Date(sinceRaw) : undefined,
      asString(body.actorId) || undefined,
    ));
    return;
  }

  if (pathname === "/v1/apify/jobs") {
    const actor = asString(body.actor);
    const platform = asApifyPlatform(body.platform);
    const query = asString(body.query);
    if (!actor || !platform || !query) {
      writeJson(res, 400, { error: "actor, platform, and query are required" });
      return;
    }
    try {
      writeJson(res, 200, await collectFromApifyJobs({
        actor,
        apifyActorId: asString(body.apifyActorId) || undefined,
        platform,
        query,
        limit: asNumber(body.limit) ?? 10,
        runGroupId: asString(body.runGroupId) || undefined,
        excludedSkills: asStringArray(body.excludedSkills),
        maxProposals: asNumber(body.maxProposals),
        minBudgetFixed: asNumber(body.minBudgetFixed),
        freshnessHours: asNumber(body.freshnessHours),
      }));
    } catch (error: unknown) {
      if (error instanceof ApifyIncompleteRunError) {
        writeJson(res, 502, {
          error: error.message,
          apifyRunId: error.runId,
          status: error.status,
          datasetId: error.datasetId,
          actor: error.actor,
          platform: error.platform,
        });
        return;
      }
      throw error;
    }
    return;
  }

  if (pathname === "/v1/rss/outbound") {
    const url = asString(body.url);
    const sourceName = asString(body.sourceName) || asString(body.platform);
    if (!url || !sourceName) {
      writeJson(res, 400, { error: "url and sourceName are required" });
      return;
    }
    writeJson(res, 200, await fetchRssFeed({
      url,
      sourceName,
      limit: asNumber(body.limit) ?? 20,
    }));
    return;
  }

  if (pathname === "/v1/polymarket/trending") {
    writeJson(res, 200, { items: await getTrendingPolymarket(asNumber(body.limit) ?? 20) });
    return;
  }

  if (pathname === "/v1/reddit/subreddit-posts") {
    const subreddit = asString(body.subreddit);
    if (!subreddit) {
      writeJson(res, 400, { error: "subreddit is required" });
      return;
    }
    writeJson(res, 200, {
      items: await getSubredditPosts(subreddit, asRedditSort(body.sort), asNumber(body.limit) ?? 25),
    });
    return;
  }

  if (pathname === "/v1/reddit/search-subreddit") {
    const subreddit = asString(body.subreddit);
    const query = asString(body.query);
    if (!subreddit || !query) {
      writeJson(res, 400, { error: "subreddit and query are required" });
      return;
    }
    writeJson(res, 200, { items: await searchSubreddit(subreddit, query, asNumber(body.limit) ?? 25) });
    return;
  }

  if (pathname === "/v1/reddit/rules") {
    const subreddit = asString(body.subreddit);
    if (!subreddit) {
      writeJson(res, 400, { error: "subreddit is required" });
      return;
    }
    writeJson(res, 200, await getSubredditRules(subreddit));
    return;
  }

  if (pathname === "/v1/reddit/profile") {
    const handle = asString(body.handle);
    if (!handle) {
      writeJson(res, 400, { error: "handle is required" });
      return;
    }
    writeJson(res, 200, await scrapeOwnProfile(handle, {
      respectResolvedThreads: body.respectResolvedThreads === true,
    }));
    return;
  }

  if (pathname === "/v1/reddit/comments") {
    const url = asString(body.url);
    if (!url) {
      writeJson(res, 400, { error: "url is required" });
      return;
    }
    writeJson(res, 200, {
      comments: await getComments(url, {
        limit: asNumber(body.limit),
        depth: asNumber(body.depth),
      }),
    });
    return;
  }

  if (pathname === "/v1/reddit/resolve-thread") {
    const commentId = asString(body.commentId);
    if (!commentId) {
      writeJson(res, 400, { error: "commentId is required" });
      return;
    }
    resolveThread("reddit", commentId, {
      lastReplyAt: asString(body.lastReplyAt) || undefined,
      closeReason: asString(body.closeReason) as "REPLIED" | "UPVOTED" | "NOT_NEEDED" | undefined,
    });
    writeJson(res, 200, { ok: true });
    return;
  }

  writeJson(res, 404, { error: "Not found" });
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const server = createScoutMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  await server.connect(transport);
  await transport.handleRequest(req, res);
}

export function startScoutServer(options: ScoutServerOptions = {}): http.Server {
  const host = options.host ?? process.env.SCOUT_HOST ?? DEFAULT_HOST;
  const port = options.port ?? Number(process.env.SCOUT_PORT ?? DEFAULT_PORT);
  const authToken = options.authToken ?? process.env.SCOUT_AUTH_TOKEN;

  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `${host}:${port}`}`);
      if (url.pathname === "/healthz") {
        writeJson(res, 200, { ok: true, service: "scout-scraper" });
        return;
      }

      if (!authOk(req, authToken)) {
        unauthorized(res);
        return;
      }

      if (url.pathname === "/mcp") {
        await handleMcp(req, res);
        return;
      }

      if (url.pathname.startsWith("/v1/")) {
        await handleApi(req, res, url.pathname);
        return;
      }

      writeJson(res, 404, { error: "Not found" });
    })().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "Internal server error";
      if (!res.headersSent) writeJson(res, 500, { error: message });
    });
  });

  server.listen(port, host, () => {
    process.stdout.write(`[scout] listening on http://${host}:${port}\n`);
  });

  return server;
}
