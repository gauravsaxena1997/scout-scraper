import { SCOUT_UA, FETCH_TIMEOUT_MS, DEFAULT_SUBREDDITS } from "../config";
import { urlToId, isThreadResolved, getThreadCloseState, reopenThread } from "../store/db";
import type { RawItem, ProfileSnapshot, OpenThread, CommentSample } from "../schema";
import { scoreItem } from "../intelligence/score";

interface RedditReplies {
  data?: { children?: RedditNode[] };
}

interface RedditProfileScrapeOptions {
  respectResolvedThreads?: boolean;
}

interface RedditNode {
  kind: string;
  data: {
    id?: string;
    author?: string;
    body?: string;
    created_utc?: number;
    permalink?: string;
    subreddit?: string;
    title?: string;
    url?: string;
    selftext?: string;
    score?: number;
    num_comments?: number;
    link_id?: string;
    link_title?: string;
    link_permalink?: string;
    replies?: RedditReplies | string;
    children?: RedditNode[];
    [key: string]: unknown;
  };
}

const BASE = "https://old.reddit.com";
export type RedditSortKind = "hot" | "new" | "top:day" | "rising";
export interface RedditRules {
  accountAgeMinDays: number | null;
  minKarma: number | null;
  noJobPostings: boolean;
  selfPromoAllowed: boolean;
  raw: string[];
}

async function redditFetch(url: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": SCOUT_UA, Accept: "application/json" },
      signal: controller.signal,
    });
    if (res.status === 429) throw new Error("rate_limited");
    if (res.status === 404) throw new Error("not_found");
    if (!res.ok) throw new Error(`http_${res.status}`);
    return res.json();
  } finally {
    clearTimeout(timeout);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Reddit API child object shape is external; no published TypeScript types
function mapPost(child: any): RawItem | null {
  const d = child?.data;
  if (!d) return null;
  const permalink =
    typeof d.permalink === "string"
      ? d.permalink.startsWith("http")
        ? d.permalink
        : `https://www.reddit.com${d.permalink}`
      : "";
  const outboundUrl = typeof d.url === "string"
    ? d.url.startsWith("http")
      ? d.url
      : `https://reddit.com${d.url}`
    : "";
  const url = permalink || outboundUrl;
  if (!url) return null;
  const id = urlToId(url);
  const raw: RawItem = {
    id,
    source: "reddit",
    title: d.title ?? "(no title)",
    body: (d.selftext ?? "").slice(0, 500),
    url,
    author: d.author ?? "",
    engagement: {
      score: d.score ?? 0,
      comments: d.num_comments ?? 0,
      ratio: d.upvote_ratio ?? 0.5,
    },
    publishedAt: d.created_utc ? new Date(d.created_utc * 1000).toISOString() : "",
    scoutScore: 0,
  };
  raw.scoutScore = scoreItem(raw);
  return raw;
}

export async function searchReddit(query: string, limit = 25): Promise<RawItem[]> {
  const subreddits = DEFAULT_SUBREDDITS.slice(0, 5).join("+");
  const url = `${BASE}/r/${subreddits}/search.json?q=${encodeURIComponent(query)}&sort=relevance&t=week&limit=${limit}`;
  const json = await redditFetch(url);
  const children = json?.data?.children ?? [];
  return children.map(mapPost).filter(Boolean) as RawItem[];
}

export async function searchSubreddit(
  subreddit: string,
  query: string,
  limit = 20
): Promise<RawItem[]> {
  const url = `${BASE}/r/${subreddit}/search.json?q=${encodeURIComponent(query)}&restrict_sr=1&sort=top&t=week&limit=${limit}`;
  const json = await redditFetch(url);
  const children = json?.data?.children ?? [];
  return children.map(mapPost).filter(Boolean) as RawItem[];
}

export async function getHotPosts(subreddit: string, limit = 10): Promise<RawItem[]> {
  const url = `${BASE}/r/${subreddit}/hot.json?limit=${limit}`;
  const json = await redditFetch(url);
  const children = json?.data?.children ?? [];
  return children.map(mapPost).filter(Boolean) as RawItem[];
}

export async function getSubredditPosts(
  subreddit: string,
  sort: RedditSortKind = "hot",
  limit = 10
): Promise<RawItem[]> {
  const path = sort === "top:day" ? "top.json?t=day" : `${sort}.json`;
  const url = `${BASE}/r/${subreddit}/${path}${path.includes("?") ? "&" : "?"}limit=${limit}`;
  const json = await redditFetch(url);
  const children = json?.data?.children ?? [];
  return children.map(mapPost).filter(Boolean) as RawItem[];
}

function parseSubredditRules(rulesData: unknown): RedditRules {
  const result: RedditRules = {
    accountAgeMinDays: null,
    minKarma: null,
    noJobPostings: false,
    selfPromoAllowed: true,
    raw: [],
  };

  const rules = (rulesData as { rules?: { short_name?: string; description?: string }[] } | null)?.rules ?? [];
  for (const rule of rules) {
    const text = `${rule.short_name ?? ""} ${rule.description ?? ""}`.toLowerCase();
    result.raw.push((rule.short_name ?? "").slice(0, 200));

    const ageMatch = text.match(/account.*?(\d+)\s*(day|month|year)/i) ?? text.match(/(\d+)\s*(day|month|year).*?account/i);
    if (ageMatch) {
      const val = Number.parseInt(ageMatch[1], 10);
      const unit = ageMatch[2].toLowerCase();
      const days = unit.startsWith("month") ? val * 30 : unit.startsWith("year") ? val * 365 : val;
      if (!result.accountAgeMinDays || days > result.accountAgeMinDays) {
        result.accountAgeMinDays = days;
      }
    }

    const karmaMatch = text.match(/(\d+)\s*(karma|post karma|comment karma)/i);
    if (karmaMatch) {
      const val = Number.parseInt(karmaMatch[1], 10);
      if (!result.minKarma || val > result.minKarma) {
        result.minKarma = val;
      }
    }

    if (/no job|no hiring|no recruit|no spam|no self.?promo/i.test(text)) {
      result.noJobPostings = true;
    }

    if (/self.?promo.*(allow|ok|permitted)/i.test(text)) {
      result.selfPromoAllowed = true;
    } else if (/no self.?promo/i.test(text)) {
      result.selfPromoAllowed = false;
    }
  }

  return result;
}

export async function getSubredditRules(subreddit: string): Promise<RedditRules> {
  const json = await redditFetch(`https://www.reddit.com/r/${subreddit}/about/rules.json`);
  return parseSubredditRules(json);
}

function findCommentInTree(children: RedditNode[], targetId: string): RedditNode | null {
  for (const child of children) {
    if (child?.kind !== "t1" || !child.data) continue;
    if (child.data.id === targetId) return child;
    const replies = child.data.replies;
    if (replies && typeof replies === "object" && "data" in replies) {
      const found = findCommentInTree(replies.data?.children ?? [], targetId);
      if (found) return found;
    }
  }
  return null;
}

async function fetchOpenThreads(
  handle: string,
  recentComments: RedditNode[],
  opts: RedditProfileScrapeOptions = {},
): Promise<OpenThread[]> {
  // 90-day window - covers all realistic engagement timeframes
  const cutoff = Date.now() - 90 * 86_400_000;
  const candidates = recentComments.filter((c) => {
    const ts = c?.data?.created_utc;
    return ts && ts * 1000 > cutoff;
  });

  const threads: OpenThread[] = [];
  for (const c of candidates) {
    const d = c?.data;
    if (!d) continue;
    const postId = (d.link_id ?? "").replace("t3_", "");
    const commentId = d.id ?? "";
    const subreddit = d.subreddit ?? "";
    if (!postId || !commentId || !subreddit) continue;

    // Check resolution state. If resolved but a new reply arrived after close, reopen.
    const fullId = `t1_${commentId}`;
    if (opts.respectResolvedThreads === true && isThreadResolved("reddit", fullId)) {
      const closeState = getThreadCloseState("reddit", fullId);
      const repliesObj = typeof d.replies === "object" ? d.replies : undefined;
      const latestReplyAt = repliesObj?.data?.children?.[0]?.data?.created_utc;
      const latestReplyTs = latestReplyAt ? new Date(latestReplyAt * 1000).toISOString() : null;
      const hasNewReply =
        latestReplyTs &&
        closeState?.lastReplyAt &&
        latestReplyTs > closeState.lastReplyAt;
      if (!hasNewReply) continue;
      // New reply after close - reopen the thread
      reopenThread("reddit", fullId);
    }

    try {
      await new Promise((r) => setTimeout(r, 300));
      const url = `${BASE}/r/${subreddit}/comments/${postId}/_/${commentId}.json?limit=50&depth=5`;
      const data = await redditFetch(url);
      // Walk the tree to find our specific comment - do NOT assume it's children[0].
      // When your comment is a reply to someone else, children[0] is the parent and
      // your comment is nested inside. Grabbing children[0].replies gives siblings, not replies to you.
      const topLevel: RedditNode[] = (data?.[1]?.data?.children ?? []) as RedditNode[];
      const ourComment = findCommentInTree(topLevel, commentId);
      const repliesRaw = ourComment?.data?.replies;
      const replies: RedditNode[] = (
        repliesRaw && typeof repliesRaw === "object" ? repliesRaw.data?.children ?? [] : []
      ) as RedditNode[];
      const otherReplies = replies.filter(
        (r) => r?.data?.author && r.data.author !== handle && r.kind !== "more"
      );
      if (otherReplies.length === 0) continue;

      otherReplies.sort((a, b) => (b.data.created_utc ?? 0) - (a.data.created_utc ?? 0));
      const latest = otherReplies[0].data;
      const myPermalink = d.permalink?.startsWith("http")
        ? d.permalink
        : `https://reddit.com${d.permalink ?? ""}`;
      const replyPermalink = latest.permalink?.startsWith("http")
        ? latest.permalink
        : `https://reddit.com${latest.permalink ?? ""}`;

      threads.push({
        myCommentId: `t1_${commentId}`,
        myCommentBody: (d.body ?? "").slice(0, 200),
        myCommentUrl: myPermalink,
        postTitle: d.link_title ?? subreddit,
        postUrl: d.link_permalink?.startsWith("http")
          ? d.link_permalink
          : `https://reddit.com${d.link_permalink ?? ""}`,
        subreddit,
        latestReply: {
          author: latest.author ?? "",
          body: (latest.body ?? "").slice(0, 300),
          publishedAt: latest.created_utc
            ? new Date(latest.created_utc * 1000).toISOString()
            : "",
          url: replyPermalink,
        },
        totalReplies: otherReplies.length,
        isUrgent: latest.created_utc
          ? Date.now() - latest.created_utc * 1000 < 86_400_000
          : false,
      });
    } catch {
      // skip - don't let one failure stop the rest
    }
  }
  return threads;
}

// ---------------------------------------------------------------------------
// Comment fetching (used by Recon hydrator via MCP + direct import)
// ---------------------------------------------------------------------------

function normalizeRedditUrl(url: string): string {
  return url.replace("https://www.reddit.com", BASE).replace(/\/$/, "");
}

 
function walkCommentTree(children: unknown[], out: CommentSample[]): void {
  for (const child of children) {
    const c = child as { kind?: string; data?: Record<string, unknown> };
    if (c?.kind !== "t1" || !c.data) continue;
    const d = c.data;
    const id = typeof d.id === "string" ? d.id : null;
    const body = typeof d.body === "string" ? d.body : null;
    if (!id || !body) continue;
    if (body === "[deleted]" || body === "[removed]") continue;
    const replies = d.replies as { data?: { children?: unknown[] } } | "" | undefined;
    const replyChildren =
      replies && typeof replies === "object" ? replies.data?.children ?? [] : [];
    out.push({
      id,
      author: typeof d.author === "string" ? d.author : undefined,
      body: body.slice(0, 800),
      score: typeof d.score === "number" ? d.score : 0,
      replyCount: replyChildren.length,
      url:
        typeof d.permalink === "string"
          ? d.permalink.startsWith("http")
            ? d.permalink
            : `https://www.reddit.com${d.permalink}`
          : undefined,
    });
    if (replyChildren.length) walkCommentTree(replyChildren, out);
  }
}

function flattenCommentTree(json: unknown): CommentSample[] {
  const arr = Array.isArray(json) ? json : null;
  if (!arr || arr.length < 2) return [];
  const commentsListing = arr[1] as { data?: { children?: unknown[] } };
  const out: CommentSample[] = [];
  walkCommentTree(commentsListing?.data?.children ?? [], out);
  return out;
}

export async function getComments(
  postUrl: string,
  opts: { limit?: number; depth?: number } = {},
): Promise<CommentSample[]> {
  const { limit = 20, depth = 2 } = opts;
  const base = normalizeRedditUrl(postUrl);
  const url = `${base}.json?limit=${limit}&depth=${depth}&sort=top`;
  const json = await redditFetch(url);
  return flattenCommentTree(json);
}

export async function scrapeOwnProfile(
  handle: string,
  opts: RedditProfileScrapeOptions = {},
): Promise<ProfileSnapshot> {
  const [about, submitted, comments] = await Promise.all([
    redditFetch(`${BASE}/user/${encodeURIComponent(handle)}/about.json`),
    redditFetch(`${BASE}/user/${encodeURIComponent(handle)}/submitted.json?limit=15&sort=new`),
    redditFetch(`${BASE}/user/${encodeURIComponent(handle)}/comments.json?limit=100&sort=new`).catch(() => null),
  ]);

  const d = about?.data ?? {};

  const cleanUrl = (u: string) => u?.split("?")?.[0] ?? u;
  const avatarUrl = cleanUrl(d.icon_img ?? d.snoovatar_img ?? "");
  const bannerUrl = cleanUrl(d.banner_img ?? d.banner_background_image ?? "");

  const postItems = (submitted?.data?.children ?? [])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Reddit submitted post child object is external API response
    .map((c: any) => {
      const p = c?.data;
      if (!p) return null;
      const url = p.url?.startsWith("http") ? p.url : `https://reddit.com${p.url ?? ""}`;
      return {
        id: `post_${p.id ?? urlToId(url)}`,
        url,
        content: p.title ?? "",
        publishedAt: p.created_utc ? new Date(p.created_utc * 1000).toISOString() : "",
        likes: p.score ?? 0,
        comments: p.num_comments ?? 0,
        isViral: (p.score ?? 0) > 1000,
        subreddit: p.subreddit ?? "",
        isComment: false,
      };
    })
    .filter(Boolean);

  const commentItems = (comments?.data?.children ?? [])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Reddit comment child object is external API response
    .map((c: any) => {
      const p = c?.data;
      if (!p) return null;
      const postUrl = p.link_permalink?.startsWith("http")
        ? p.link_permalink
        : `https://reddit.com${p.link_permalink ?? ""}`;
      const commentUrl = p.permalink?.startsWith("http")
        ? p.permalink
        : `https://reddit.com${p.permalink ?? ""}`;
      return {
        id: `comment_${p.id}`,
        url: postUrl,
        content: (p.body ?? "").slice(0, 300),
        publishedAt: p.created_utc ? new Date(p.created_utc * 1000).toISOString() : "",
        likes: p.score ?? 0,
        comments: 0,
        isViral: (p.score ?? 0) > 100,
        subreddit: p.subreddit ?? "",
        isComment: true,
        commentPermalink: commentUrl,
      };
    })
    .filter(Boolean);

  const rawComments = comments?.data?.children ?? [];
  const pendingThreads = await fetchOpenThreads(handle, rawComments, opts);

  return {
    platform: "reddit",
    handle,
    fetchedAt: new Date().toISOString(),
    followers: typeof d.num_followers === "number" ? d.num_followers : 0,
    avatarUrl: avatarUrl || undefined,
    bannerUrl: bannerUrl || undefined,
    displayName: d.subreddit?.title || handle,
    posts: [...postItems, ...commentItems] as ProfileSnapshot["posts"],
    stats: {
      post_karma: d.link_karma ?? 0,
      comment_karma: d.comment_karma ?? 0,
      total_karma: (d.link_karma ?? 0) + (d.comment_karma ?? 0),
      account_age_days: d.created_utc
        ? Math.floor((Date.now() - d.created_utc * 1000) / 86400000)
        : 0,
    },
    pendingThreads,
  };
}
