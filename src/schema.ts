export type Platform =
  | "reddit"
  | "hn"
  | "github"
  | "rss"
  | "x"
  | "youtube"
  | "instagram"
  | "polymarket"
  | "web"
  | "linkedin"
  | "upwork"
  | "fiverr";

export type TargetType =
  | "SOCIAL_MEDIA"
  | "OWN_PROFILE"
  | "DEVELOPER"
  | "FREELANCE"
  | "PREDICTION"
  | "NEWS_RESEARCH";

export type AuthType =
  | "NO_AUTH"
  | "FREE_API_KEY"
  | "COOKIE_AUTH"
  | "ACCOUNT_AUTH";

export interface Engagement {
  score: number;
  comments: number;
  ratio?: number;
  topComment?: string;
  probability?: number;
}

export interface RawItem {
  /** SHA-256 of normalized URL - dedup key */
  id: string;
  source: Platform;
  title: string;
  body: string;
  url: string;
  author: string;
  engagement: Engagement;
  publishedAt: string;
  /** Per-source normalized score (0-1) */
  scoutScore: number;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface SourceItem extends RawItem {
  /** Reciprocal Rank Fusion score across all streams */
  rrfScore: number;
}

export interface ProfilePost {
  id: string;
  url: string;
  content: string;
  publishedAt: string;
  likes: number;
  comments: number;
  shares?: number;
  reposts?: number;
  views?: number;
  isViral: boolean;
  // Rich media
  imageUrl?: string;
  mediaUrl?: string;
  thumbnailUrl?: string;
  mediaType?: string;
  mediaProductType?: string;
  // Reddit-specific
  subreddit?: string;
  isComment?: boolean;
  commentPermalink?: string;
}

export interface OpenThread {
  myCommentId: string;
  myCommentBody: string;
  myCommentUrl: string;
  postTitle: string;
  postUrl: string;
  subreddit: string;
  latestReply: {
    author: string;
    body: string;
    publishedAt: string;
    url: string;
  };
  totalReplies: number;
  isUrgent: boolean;
}

export interface ProfileSnapshot {
  platform: Platform;
  handle: string;
  fetchedAt: string;
  followers: number;
  posts: ProfilePost[];
  stats: Record<string, number | string>;
  avatarUrl?: string;
  bannerUrl?: string;
  displayName?: string;
  pendingThreads?: OpenThread[];
}

export interface CommentSample {
  id: string;
  author?: string;
  body: string;
  score: number;
  replyCount?: number;
  upvoteRatio?: number;
  url?: string;
}

export interface Cluster {
  label: string;
  items: string[];
  representative: string;
}

export interface ScoutReport {
  query: string;
  items: SourceItem[];
  clusters: Cluster[];
  runId: string;
  generatedAt: string;
  sourceBreakdown: Partial<Record<Platform, number>>;
}

export interface SubQuery {
  label: string;
  searchQuery: string;
  sources: Platform[];
  weight: number;
}
