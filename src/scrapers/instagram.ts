import { spawnSync } from "child_process";
import path from "path";
import fs from "fs";
import { urlToId } from "../store/db";
import type { RawItem, ProfileSnapshot } from "../schema";

// Use process.cwd() so the path resolves correctly whether this module is bundled or not
const SCRIPT = path.join(process.cwd(), "packages/scout/src/python/instagram.py");

function getVenvPython(): string {
  if (process.env.SCOUT_VENV_PYTHON) return process.env.SCOUT_VENV_PYTHON;
  const venvRoot = process.env.SCOUT_VENV_ROOT;
  if (venvRoot) {
    const candidates = [
      path.join(venvRoot, "bin", "python3"),
      path.join(venvRoot, "bin", "python"),
    ];
    const found = candidates.find((c) => fs.existsSync(c));
    if (found) return found;
  }
  return "python3";
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Python script output is a runtime JSON blob; shape unknown at compile time
function runScript(args: string[]): any {
  const python = getVenvPython();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SCOUT_IG_USERNAME: process.env.SCOUT_IG_USERNAME ?? "",
    SCOUT_IG_PASSWORD: process.env.SCOUT_IG_PASSWORD ?? "",
  };
  const result = spawnSync(python, [SCRIPT, ...args], {
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 5 * 1024 * 1024,
    env,
  });
  if (result.error) throw new Error(`Instagram script error: ${result.error.message}`);
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`Instagram script parse error: ${result.stdout?.slice(0, 200)}`);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Instagram scrape media object comes from Python script; shape unknown at compile time
function mapMedia(m: any): RawItem | null {
  if (!m?.url) return null;
  return {
    id: urlToId(m.url),
    source: "instagram",
    title: (m.caption ?? "").slice(0, 200),
    body: m.caption ?? "",
    url: m.url,
    author: m.author ? `@${m.author}` : "",
    publishedAt: m.publishedAt ?? new Date().toISOString(),
    scoutScore: 0,
    engagement: {
      score: m.likes ?? 0,
      comments: m.comments ?? 0,
      ratio: undefined,
      topComment: undefined,
      probability: undefined,
    },
  };
}

export async function searchInstagram(query: string, limit = 20): Promise<RawItem[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Python script search result is a runtime JSON blob; shape unknown at compile time
  const raw = runScript(["search", query, "--limit", String(limit)]) as any;
  if (!Array.isArray(raw)) {
    if (raw?.error) throw new Error(`Instagram search: ${raw.error}`);
    return [];
  }
  return raw.flatMap((m) => mapMedia(m) ?? []).slice(0, limit);
}

export async function scrapeInstagramProfile(handle: string): Promise<ProfileSnapshot> {
  const clean = handle.replace(/^@/, "");
  const raw = runScript(["profile", clean]);

  if (raw?.error) throw new Error(`Instagram profile: ${raw.error}`);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Instagram profile post object from Python script; shape unknown at compile time
  const posts = (raw.posts ?? []).map((p: any) => ({
    id: p.id ?? urlToId(p.url ?? ""),
    url: p.url ?? "",
    content: p.caption ?? "",
    publishedAt: p.publishedAt ?? new Date().toISOString(),
    likes: p.likes ?? 0,
    comments: p.comments ?? 0,
    shares: 0,
    views: 0,
    isViral: (p.likes ?? 0) > 10_000,
  }));

  return {
    platform: "instagram",
    handle: clean,
    fetchedAt: new Date().toISOString(),
    followers: raw.followers ?? 0,
    posts,
    stats: {
      followersCount: raw.followers ?? 0,
      followingCount: raw.following ?? 0,
      postsCount: raw.postsCount ?? 0,
      avgLikes: raw.stats?.avgLikes ?? 0,
      avgComments: raw.stats?.avgComments ?? 0,
    },
  };
}
