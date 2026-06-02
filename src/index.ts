export { registerScoutTools, runGetTrending } from "./tools";
export { configureHandles, ScoutConfigSchema } from "./config";
export type { ScoutConfig } from "./config";
export { startScoutServer } from "./server/http";
export type { ScoutServerOptions } from "./server/http";
export { getActorPricing, fetchActorPricing } from "./apify/pricing";
export type { ActorPricing, PricingModel } from "./apify/pricing";
export { runApifyActor, recoverApifyRun, listApifyRuns } from "./apify/runs";
export type { ApifyRunActorArgs, ApifyRunActorResult, RecoverApifyRunArgs, ListApifyRunsArgs, ApifyRunSummary } from "./apify/runs";
export { scrapeOwnProfile, getComments, getSubredditPosts, getSubredditRules, searchSubreddit, searchReddit } from "./scrapers/reddit";
export type { RedditRules, RedditSortKind } from "./scrapers/reddit";
export { scrapeYoutubeProfile, getYoutubeChannelVideos } from "./scrapers/youtube";
export { analyzeVideo, analyzeVideos } from "./vision/pipeline";
export type { VideoAnalysis, VideoAnalysisError, AnalyzeVideosResult } from "./vision/pipeline";
export { getInstagramChannelPosts, getInstagramChannelPostsDetailed } from "./scrapers/apify";
export type { InstagramPost, InstagramChannelPostsResult } from "./scrapers/apify";
export { saveProfileSnapshot, resolveThread, isThreadResolved, getThreadCloseState, reopenThread } from "./store/db";
export type { CloseReason } from "./store/db";
// Unified media store: canonical paths + cleanup for downloaded artifacts.
export { cleanupOldMedia, getMediaRoot, transcriptPath, videoPath, imageDir, rawScrapePath, visionDir, saveTranscript, readTranscript, saveRawScrape, saveVisionText, downloadImageSlides, downloadVideoFile } from "./store/media-store";
export type { RawItem, SourceItem, Platform, Engagement, ProfileSnapshot, ProfilePost, OpenThread, CommentSample } from "./schema";

// ─── Scraper primitives ──────────────────────────────────────────────────────
export { fetchAllFeeds, fetchSingleFeed, fetchYouTubeChannelFeed } from "./scrapers/rss";
export { getHnByDate } from "./scrapers/hn";

// ─── Generic job/feed collectors ─────────────────────────────────────────────
export { collectFromApifyJobs, ApifyIncompleteRunError, JOB_NORMALIZERS, JOB_ACTOR_MAP } from "./scrapers/apify-jobs";
export type { JobListing, ApifyPlatform, ApifyJobsCollectorArgs, ApifyJobsCollectorResult } from "./scrapers/apify-jobs";
export { fetchRssFeed } from "./scrapers/rss-outbound";
export type { FeedItem, FetchRssResult } from "./scrapers/rss-outbound";
export { getTrendingRepos } from "./scrapers/github";
export { getTrendingPolymarket } from "./scrapers/polymarket";

// ─── Open event hook (implement to receive lifecycle events from Scout) ───────

export type PackageEvent = {
  type: string;
  payload: Record<string, unknown>;
  timestamp: string;
};

export type OnEventHook = (e: PackageEvent) => void | Promise<void>;
