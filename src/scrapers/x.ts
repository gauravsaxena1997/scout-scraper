import { spawnSync } from "child_process";
import path from "path";
import { urlToId } from "../store/db";
import type { RawItem, ProfileSnapshot } from "../schema";

// Use process.cwd() so host applications can resolve the vendored script from
// their runtime root even when bundlers rewrite import.meta.url.
const BIRD_MJS = path.join(
  process.cwd(),
  "packages/scout/src/vendor/bird-search/bird-search.mjs",
);

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- bird-search MJS output is a runtime JSON blob; tweet shape unknown at compile time
function birdSearch(query: string, count: number): any[] {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (process.env.SCOUT_X_AUTH_TOKEN) env["AUTH_TOKEN"] = process.env.SCOUT_X_AUTH_TOKEN;
  if (process.env.SCOUT_X_CT0) env["CT0"] = process.env.SCOUT_X_CT0;

  const result = spawnSync("node", [BIRD_MJS, query, "--count", String(count), "--json"], {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 5 * 1024 * 1024,
    env,
  });

  if (result.error) throw new Error(`bird-search error: ${result.error.message}`);
  if (!result.stdout?.trim()) return [];

  try {
    const parsed = JSON.parse(result.stdout);
    return Array.isArray(parsed) ? parsed : parsed?.items ?? [];
  } catch {
    return [];
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- X/Twitter tweet object from bird-search; shape unknown at compile time
function mapTweet(tweet: any, _idx: number): RawItem | null {
  const author = tweet.author ?? tweet.user ?? {};
  const handle = author.username ?? author.screen_name ?? "";
  const tweetId = tweet.id ?? tweet.id_str ?? "";
  if (!tweetId && !tweet.permanent_url) return null;

  const url = tweet.permanent_url
    ?? (handle ? `https://x.com/${handle}/status/${tweetId}` : "");
  if (!url) return null;

  const createdAt = tweet.createdAt ?? tweet.created_at ?? "";
  let publishedAt = new Date().toISOString();
  if (createdAt) {
    try {
      publishedAt = new Date(createdAt).toISOString();
    } catch { /* use default */ }
  }

  return {
    id: urlToId(url),
    source: "x",
    title: (tweet.text ?? tweet.full_text ?? "").slice(0, 200),
    body: tweet.text ?? tweet.full_text ?? "",
    url,
    author: handle ? `@${handle}` : "",
    publishedAt,
    scoutScore: 0,
    engagement: {
      score: tweet.likeCount ?? tweet.favorite_count ?? 0,
      comments: tweet.replyCount ?? tweet.reply_count ?? 0,
      ratio: tweet.retweetCount ?? tweet.retweet_count ?? 0,
      topComment: undefined,
      probability: undefined,
    },
  };
}

export async function searchX(query: string, limit = 20): Promise<RawItem[]> {
  const tweets = birdSearch(query, Math.min(limit, 60));
  return tweets.flatMap((t, i) => mapTweet(t, i) ?? []).slice(0, limit);
}

export async function scrapeXProfile(handle: string): Promise<ProfileSnapshot> {
  const cleanHandle = handle.replace(/^@/, "");
  const query = `from:${cleanHandle}`;
  const tweets = birdSearch(query, 20);

  const posts = tweets.flatMap((t, i) => {
    const item = mapTweet(t, i);
    if (!item) return [];
    return [{
      id: item.id,
      url: item.url,
      content: item.body,
      publishedAt: item.publishedAt,
      likes: t.likeCount ?? t.favorite_count ?? 0,
      comments: t.replyCount ?? t.reply_count ?? 0,
      shares: t.retweetCount ?? t.retweet_count ?? 0,
      views: t.viewCount ?? t.view_count ?? 0,
      isViral: (t.viewCount ?? t.view_count ?? 0) > 50_000,
    }];
  });

  const author = tweets[0]?.author ?? tweets[0]?.user ?? {};
  const followers = author.followersCount ?? author.followers_count ?? 0;

  return {
    platform: "x",
    handle: cleanHandle,
    fetchedAt: new Date().toISOString(),
    followers,
    posts,
    stats: {
      followersCount: followers,
      followingCount: author.friendsCount ?? author.friends_count ?? 0,
      tweetsCount: author.statusesCount ?? author.statuses_count ?? 0,
    },
  };
}
