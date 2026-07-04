import { SCOUT_UA, FETCH_TIMEOUT_MS } from "../config";
import { urlToId } from "../store/db";
import type { RawItem } from "../schema";
import { scoreItem } from "../intelligence/score";
import { fetchSingleFeed } from "./rss";

type GitHubTrendingSince = "daily" | "weekly" | "monthly";

type GitHubRepoSearchArgs = {
  query: string;
  limit?: number;
  pushedAfter?: string;
  sort?: "updated" | "stars";
};

type GitHubReleaseArgs = {
  repositories: string[];
  limit?: number;
};

type GitHubBlogSection = "blog" | "changelog";

type GitHubApiOwner = {
  login?: string;
};

type GitHubApiRepository = {
  full_name?: string;
  description?: string | null;
  html_url?: string;
  owner?: GitHubApiOwner;
  forks_count?: number;
  stargazers_count?: number;
  pushed_at?: string;
  updated_at?: string;
  language?: string | null;
};

type GitHubApiSearchResponse = {
  items?: GitHubApiRepository[];
};

type GitHubApiRelease = {
  html_url?: string;
  name?: string | null;
  tag_name?: string;
  body?: string | null;
  published_at?: string;
  created_at?: string;
  reactions?: {
    total_count?: number;
  };
  author?: GitHubApiOwner;
};

const GITHUB_HEADERS = {
  "User-Agent": SCOUT_UA,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
} as const;

function normalizeDate(value: string | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function buildRawItem(args: {
  url: string;
  title: string;
  body?: string;
  author?: string;
  publishedAt?: string;
  engagementScore?: number;
  metadata?: Record<string, string | number | boolean | null>;
}): RawItem {
  const raw: RawItem = {
    id: urlToId(args.url),
    source: "github",
    title: args.title.slice(0, 200),
    body: (args.body ?? "").slice(0, 1000),
    url: args.url,
    author: args.author ?? "github",
    engagement: {
      score: args.engagementScore ?? 0,
      comments: 0,
    },
    publishedAt: normalizeDate(args.publishedAt),
    scoutScore: 0,
    metadata: args.metadata,
  };
  raw.scoutScore = scoreItem(raw);
  return raw;
}

async function fetchText(url: string, accept: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": SCOUT_UA,
        Accept: accept,
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`github_http_${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchGithubJson<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: GITHUB_HEADERS,
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`github_http_${response.status}`);
    return await response.json() as T;
  } finally {
    clearTimeout(timeout);
  }
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, "\"");
}

function stripTags(value: string): string {
  return decodeHtml(value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

export async function getTrendingRepos(args: {
  language?: string;
  limit?: number;
  since?: GitHubTrendingSince;
} = {}): Promise<RawItem[]> {
  const search = new URLSearchParams();
  if (args.language) search.set("l", args.language);
  search.set("since", args.since ?? "daily");
  const html = await fetchText(`https://github.com/trending?${search.toString()}`, "text/html,application/xhtml+xml");

  const items: RawItem[] = [];
  const articleRegex = /<article[\s\S]*?class="Box-row"[\s\S]*?<\/article>/g;
  const matches = html.match(articleRegex) ?? [];

  for (const article of matches) {
    const repoPathMatch = article.match(/href="\/([^"/]+\/[^"/?#]+)"/);
    const repoPath = repoPathMatch?.[1]?.trim();
    if (!repoPath) continue;

    const repoUrl = `https://github.com/${repoPath}`;
    const repoTitle = repoPath.replace(/\s+/g, "");
    const descriptionMatch = article.match(/<p[^>]*class="[^"]*col-9[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
    const description = stripTags(descriptionMatch?.[1] ?? "");
    const starsMatch = article.match(/<svg[^>]*octicon-star[\s\S]*?<\/svg>\s*([\d,]+)/i);
    const forksMatch = article.match(/<svg[^>]*octicon-repo-forked[\s\S]*?<\/svg>\s*([\d,]+)/i);
    const todayStarsMatch = article.match(/([\d,]+)\s+stars\s+today/i);
    const periodStars = Number((todayStarsMatch?.[1] ?? "0").replace(/,/g, ""));
    const totalStars = Number((starsMatch?.[1] ?? "0").replace(/,/g, ""));
    const forks = Number((forksMatch?.[1] ?? "0").replace(/,/g, ""));

    items.push(buildRawItem({
      url: repoUrl,
      title: `${repoTitle}: ${description || "Trending repository"}`,
      body: description,
      author: repoPath.split("/")[0],
      engagementScore: periodStars > 0 ? periodStars : totalStars + forks,
      metadata: {
        lane: "github.trending",
        trendingSince: args.since ?? "daily",
        language: args.language ?? "",
        totalStars,
        forks,
        periodStars,
      },
    }));
  }

  return items.slice(0, args.limit ?? 10);
}

function buildSearchQuery(args: GitHubRepoSearchArgs): string {
  const parts = [args.query.trim()];
  if (args.pushedAfter) parts.push(`pushed:>=${args.pushedAfter}`);
  return parts.join(" ").trim();
}

function repoToRawItem(repo: GitHubApiRepository, query: string): RawItem | null {
  if (!repo.html_url || !repo.full_name) return null;
  return buildRawItem({
    url: repo.html_url,
    title: `${repo.full_name}: ${repo.description ?? "Repository update"}`,
    body: repo.description ?? "",
    author: repo.owner?.login ?? repo.full_name.split("/")[0],
    publishedAt: repo.pushed_at ?? repo.updated_at,
    engagementScore: (repo.stargazers_count ?? 0) + (repo.forks_count ?? 0),
    metadata: {
      lane: "github.searchRepos",
      query,
      language: repo.language ?? "",
      stars: repo.stargazers_count ?? 0,
      forks: repo.forks_count ?? 0,
    },
  });
}

export async function searchGithubRepos(args: GitHubRepoSearchArgs): Promise<RawItem[]> {
  const query = buildSearchQuery(args);
  const search = new URLSearchParams({
    q: query,
    sort: args.sort ?? "updated",
    order: "desc",
    per_page: String(Math.min(args.limit ?? 10, 100)),
  });
  const json = await fetchGithubJson<GitHubApiSearchResponse>(`https://api.github.com/search/repositories?${search.toString()}`);
  return (json.items ?? [])
    .map((repo) => repoToRawItem(repo, query))
    .filter((item): item is RawItem => item !== null)
    .slice(0, args.limit ?? 10);
}

export async function searchGithub(query: string, limit = 15): Promise<RawItem[]> {
  return searchGithubRepos({ query, limit });
}

function parseRepositorySlug(value: string): string | null {
  const trimmed = value.trim().replace(/^https:\/\/github\.com\//, "").replace(/\/+$/, "");
  return /^[^/]+\/[^/]+$/.test(trimmed) ? trimmed : null;
}

export async function getGithubReleases(args: GitHubReleaseArgs): Promise<RawItem[]> {
  const perRepoLimit = Math.max(1, Math.min(args.limit ?? 10, 20));
  const items: RawItem[] = [];

  for (const repository of args.repositories) {
    const slug = parseRepositorySlug(repository);
    if (!slug) continue;
    const releases = await fetchGithubJson<GitHubApiRelease[]>(
      `https://api.github.com/repos/${slug}/releases?per_page=${perRepoLimit}`,
    );
    for (const release of releases) {
      if (!release.html_url) continue;
      items.push(buildRawItem({
        url: release.html_url,
        title: `${slug} ${release.name ?? release.tag_name ?? "release"}`,
        body: stripTags(release.body ?? ""),
        author: release.author?.login ?? slug.split("/")[0],
        publishedAt: release.published_at ?? release.created_at,
        engagementScore: release.reactions?.total_count ?? 0,
        metadata: {
          lane: "github.releases",
          repository: slug,
          tagName: release.tag_name ?? "",
        },
      }));
    }
  }

  return items
    .sort((left, right) => {
      const leftTime = left.publishedAt ? new Date(left.publishedAt).getTime() : 0;
      const rightTime = right.publishedAt ? new Date(right.publishedAt).getTime() : 0;
      return rightTime - leftTime;
    })
    .slice(0, args.limit ?? 10);
}

function blogFeedUrl(section: GitHubBlogSection): string {
  return section === "changelog" ? "https://github.blog/changelog/feed/" : "https://github.blog/feed/";
}

export async function getGithubBlogPosts(args: {
  section?: GitHubBlogSection;
  limit?: number;
} = {}): Promise<RawItem[]> {
  const section = args.section ?? "blog";
  const items = await fetchSingleFeed(blogFeedUrl(section), `github-${section}`);
  return items.slice(0, args.limit ?? 10).map((item) => ({
    ...item,
    source: "github",
    author: item.author || "github",
    metadata: {
      lane: section === "changelog" ? "github.changelog" : "github.blog",
      feedSection: section,
    },
  }));
}
