/**
 * Apify-based job scrapers for the Outbound Lead Sweep.
 * Moved from src/lib/recon/collectors/apify-jobs.ts.
 *
 * INTEGRITY GUARANTEE (v2, 2026-05-05):
 * Every Apify run we kick off MUST end in one of two terminal states:
 *   1. SUCCEEDED - raw dataset items persisted to disk + normalized + returned
 *   2. NOT-SUCCEEDED - ApifyIncompleteRunError thrown WITH the run.id
 *
 * No silent empty returns. No paying for data we can't recover.
 *
 * Disk layout:
 *   logs/recon/apify-runs/<runId>.meta.json   - input + sweep + timestamps (written BEFORE polling)
 *   logs/recon/apify-runs/<runId>.items.json  - raw dataset items (written BEFORE normalization)
 *
 * Recovery: if the function throws ApifyIncompleteRunError, the runId can be
 * passed to recoverApifyRun() to fetch dataset items later.
 */
import fs from "fs";
import path from "path";
import { ApifyClient } from "apify-client";

// ─── Types ────────────────────────────────────────────────────────────────────

// Job item shape - structural subtype of Pathrix's RawItem. All fields that
// Pathrix's rawItemSchema requires are present with compatible types so
// JobItem is directly assignable to RawItem without casting.
export type JobItem = {
  source: "OUTBOUND_LEAD";
  sourceItemId: string;
  url: string;
  title: string;
  body: string;
  author?: string;
  channel: string;
  intent: "apply";
  publishedAt?: string;
  engagement: { score: number; comments: number };
  scoutScore: number;
  media: Array<{ kind: "image" | "link" | "video"; url: string }>;
  commentSample: never[];
  rawJson: unknown;
};

// Actor alias -> Apify actor ID mapping for the Outbound Lead Sweep.
// Notes on actor selection (verified live 2026-05-08):
//   - upwork-jobs: neatrat had a 10-runs/100-results lifetime cap on free tier and
//     silently returns SUCCEEDED with empty arrays after exhaustion. Switched to
//     flash_mage which is pay-per-event ($0.001 start + $0.003/result) without caps.
//   - linkedin-jobs: curious_coder is pay-per-event ($0.001/result), 66k users.
//   - peopleperhour-jobs: kept but disabled in default config.
export const JOB_ACTOR_MAP: Record<string, string> = {
  "upwork-jobs":        "flash_mage/upwork",
  "linkedin-jobs":      "curious_coder/linkedin-jobs-scraper",
  "peopleperhour-jobs": "getdataforme/PeoplePerHour-Job-Scraper",
};

// ─── Errors ───────────────────────────────────────────────────────────────────

export class ApifyIncompleteRunError extends Error {
  constructor(
    public runId: string,
    public status: string,
    public datasetId: string | undefined,
    public actor: string,
    public platform: string,
  ) {
    super(
      `Apify run ${runId} (actor=${actor}, platform=${platform}) ended with status=${status}. ` +
      `Dataset: ${datasetId ?? "<none>"}. Recover via recover_apify_run MCP tool.`,
    );
    this.name = "ApifyIncompleteRunError";
  }
}

// ─── Token ───────────────────────────────────────────────────────────────────

function getApifyToken(): string {
  const raw = process.env.APIFY_TOKENS ?? "";
  return raw.split(",")[0]?.trim() ?? "";
}

// ─── Disk audit helpers ──────────────────────────────────────────────────────

function apifyRunsDir(): string {
  const dir = path.join(process.cwd(), "logs", "recon", "apify-runs");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeRunMeta(runId: string, meta: Record<string, unknown>): void {
  try {
    fs.writeFileSync(
      path.join(apifyRunsDir(), `${runId}.meta.json`),
      JSON.stringify(meta, null, 2),
      "utf-8",
    );
  } catch {
    // Disk write failure must NOT break the scraper; the audit trail is best-effort.
  }
}

function writeRunItems(runId: string, items: unknown[]): void {
  try {
    fs.writeFileSync(
      path.join(apifyRunsDir(), `${runId}.items.json`),
      JSON.stringify(items, null, 2),
      "utf-8",
    );
  } catch {
    // Best-effort; raw items are still in memory at this point.
  }
}

// ─── Normalizers ─────────────────────────────────────────────────────────────

// Upwork normalizer for flash_mage/upwork. The actor returns two shapes:
//   - search-result: { id, title, link, data: { id, title, description, jobTile: { job: {...} } } }
//   - detail:        { id, title, link, data: { opening: {...}, job: {...}, contractTerms: {...} } }
// We handle both, preferring detail fields when present.
function normalizeUpwork(item: unknown, query: string): JobItem | null {
  const i = item as Record<string, unknown>;
  const url = (i.link ?? i.url ?? i.jobUrl ?? "") as string;
  if (!url) return null;

  const data = (i.data ?? {}) as Record<string, unknown>;
  const opening = (data.opening ?? {}) as Record<string, unknown>;
  const detailJob = (data.job ?? {}) as Record<string, unknown>;
  const buyer = (data.buyer ?? {}) as Record<string, unknown>;
  const contractTerms = (data.contractTerms ?? {}) as Record<string, unknown>;
  const fixedTerms = (contractTerms.fixedPriceContractTerms ?? {}) as Record<string, unknown>;
  const hourlyTerms = (contractTerms.hourlyContractTerms ?? {}) as Record<string, unknown>;

  const jobTile = (data.jobTile ?? {}) as Record<string, unknown>;
  const tileJob = (jobTile.job ?? {}) as Record<string, unknown>;
  const tileFixed = (tileJob.fixedPriceAmount ?? {}) as Record<string, unknown>;

  const sourceItemId = String(
    i.id ?? data.id ?? detailJob.ciphertext ?? tileJob.id ?? Buffer.from(url).toString("base64url").slice(0, 32),
  );
  const description = String(opening.description ?? data.description ?? "").slice(0, 2000);
  const title = String(i.title ?? data.title ?? query);
  const buyerCompany = (buyer.company as Record<string, unknown> | undefined)?.name as string | undefined;

  const fixedBudget = Number(
    (fixedTerms.amount as Record<string, unknown> | undefined)?.amount
    ?? tileFixed.amount
    ?? 0,
  );
  const hourlyMax = Number(hourlyTerms.hourlyBudgetMax ?? tileJob.hourlyBudgetMax ?? 0);
  const score = fixedBudget > 0 ? fixedBudget : hourlyMax;
  const totalApplicants = Number(detailJob.totalApplicants ?? 0);

  return {
    source: "OUTBOUND_LEAD",
    sourceItemId,
    url,
    title,
    body: description,
    author: buyerCompany,
    channel: "upwork",
    intent: "apply",
    publishedAt: (opening.postedOn ?? tileJob.publishTime ?? tileJob.createTime) as string | undefined,
    engagement: {
      score,
      comments: totalApplicants,
    },
    scoutScore: 0,
    media: [],
    commentSample: [],
    rawJson: item,
  };
}

function normalizeLinkedin(item: unknown, query: string): JobItem | null {
  const i = item as Record<string, unknown>;
  const url = (i.url ?? i.jobUrl ?? i.link ?? i.applyUrl ?? "") as string;
  if (!url) return null;
  const id = (i.id ?? i.jobId ?? Buffer.from(url).toString("base64url").slice(0, 32)) as string;
  const companySlug = i.companyUrl
    ? String(i.companyUrl).match(/\/company\/([^/?#]+)/)?.[1] ?? undefined
    : (i.companySlug as string | undefined);
  const posterPublicIdentifier = (i.posterPublicIdentifier ?? i.recruiterPublicIdentifier) as string | undefined;
  return {
    source: "OUTBOUND_LEAD",
    sourceItemId: id,
    url,
    title: ((i.title ?? i.jobTitle ?? query) as string),
    body: ((i.description ?? i.jobDescription ?? i.descriptionHtml ?? "") as string).replace(/<[^>]+>/g, "").slice(0, 2000),
    author: ((i.company ?? i.companyName ?? i.organization) as string | undefined),
    channel: "linkedin",
    intent: "apply",
    publishedAt: (i.postedAt ?? i.postedDate ?? i.date) as string | undefined,
    engagement: {
      score: 0,
      comments: (i.applicants ?? i.applies ?? 0) as number,
    },
    scoutScore: 0,
    media: [],
    commentSample: [],
    rawJson: { ...i, companySlug, posterPublicIdentifier },
  };
}

function normalizePeoplePerHour(item: unknown, query: string): JobItem | null {
  const i = item as Record<string, unknown>;
  const url = (i.url ?? i.jobUrl ?? i.link ?? "") as string;
  if (!url) return null;
  const id = (i.id ?? i.jobId ?? Buffer.from(url).toString("base64url").slice(0, 32)) as string;
  return {
    source: "OUTBOUND_LEAD",
    sourceItemId: id,
    url,
    title: ((i.title ?? i.jobTitle ?? query) as string),
    body: ((i.description ?? i.snippet ?? "") as string).slice(0, 2000),
    author: ((i.buyer ?? i.clientName ?? i.poster) as string | undefined),
    channel: "peopleperhour",
    intent: "apply",
    publishedAt: (i.postedAt ?? i.date ?? i.createdAt) as string | undefined,
    engagement: {
      score: (i.budget ?? i.budgetMin ?? 0) as number,
      comments: (i.proposalCount ?? i.bids ?? 0) as number,
    },
    scoutScore: 0,
    media: [],
    commentSample: [],
    rawJson: item,
  };
}

export type ApifyPlatform = "upwork" | "linkedin" | "peopleperhour";

export const APIFY_NORMALIZERS: Record<ApifyPlatform, (item: unknown, query: string) => JobItem | null> = {
  upwork: normalizeUpwork,
  linkedin: normalizeLinkedin,
  peopleperhour: normalizePeoplePerHour,
};

// ─── Actor input builders ────────────────────────────────────────────────────

// LinkedIn search params reference: f_TPR=r{seconds} (time posted),
// f_WT=2 (Remote), f_JT=C,P (Contract or Part-time, freelance-friendly).
// We push freshnessHours into f_TPR so the actor returns only items inside our
// window - downstream server-side freshness filter then has slack instead of
// throwing away most results.
function buildLinkedinSearchUrl(query: string, freshnessHours: number): string {
  const seconds = Math.max(3600, Math.round(freshnessHours * 3600));
  const params = new URLSearchParams({
    keywords: query,
    f_TPR: `r${seconds}`,
    f_WT: "2",
    f_JT: "C,P",
    sortBy: "DD",
  });
  return `https://www.linkedin.com/jobs/search/?${params.toString()}`;
}

interface ActorInputOpts {
  excludedSkills?: string[];
  freshnessHours?: number;
}

const DEFAULT_FRESHNESS_HOURS = 48;

const ACTOR_INPUT: Record<string, (query: string, limit: number, opts?: ActorInputOpts) => Record<string, unknown>> = {
  // flash_mage/upwork input. `query` is an array of keywords/URLs/job IDs.
  // `limit` caps results. `sort: "newest"` brings freshest items first; we don't
  // pass an actor-side age filter because flash_mage's input shape is undocumented.
  // Server-side freshness filter trims older items.
  "upwork-jobs": (query, limit) => ({
    query: [query],
    limit,
    sort: "newest",
    hourly: true,
    fixed: true,
  }),
  "linkedin-jobs": (query, limit, opts) => ({
    urls: [buildLinkedinSearchUrl(query, opts?.freshnessHours ?? DEFAULT_FRESHNESS_HOURS)],
    count: Math.max(10, limit),
    scrapeCompany: true,
  }),
  "peopleperhour-jobs": (query, limit) => ({
    queries: [query],
    item_limit: limit,
  }),
};

// ─── Public API ──────────────────────────────────────────────────────────────

export interface ApifyJobsCollectorArgs {
  // Legacy alias path: caller passes the alias (e.g. "upwork-jobs"), scout
  // resolves to the real Apify actor ID via JOB_ACTOR_MAP. Kept for backward
  // compatibility with sweeps that haven't been migrated to collectorId.
  actor: string;
  // SSOT path (Phase 5+): caller passes the real Apify actor ID directly
  // (e.g. "flash_mage/upwork"), resolved upstream via Collector.apifyActorId.
  // When provided, takes precedence over `actor` alias resolution.
  apifyActorId?: string;
  platform: ApifyPlatform;
  query: string;
  limit: number;
  sweepId?: string;
  excludedSkills?: string[];
  maxProposals?: number;
  minBudgetFixed?: number;
  freshnessHours?: number;
}

export interface ApifyJobsCollectorResult {
  items: JobItem[];
  apifyRunId: string;
  datasetId: string;
  status: string;
  itemCountRaw: number;
  startedAt: string;
  finishedAt: string;
}

/**
 * Run an Apify actor end-to-end with full audit trail and integrity guarantees.
 */
export async function collectFromApifyJobs(args: ApifyJobsCollectorArgs): Promise<ApifyJobsCollectorResult> {
  const token = getApifyToken();
  if (!token) throw new Error("APIFY_TOKENS not set in .env");

  // Prefer explicit apifyActorId (SSOT path: resolved upstream from Collector
  // table); fall back to alias lookup via JOB_ACTOR_MAP.
  const actorId = args.apifyActorId ?? JOB_ACTOR_MAP[args.actor];
  if (!actorId) throw new Error(`Unknown actor alias: ${args.actor}`);

  const client = new ApifyClient({ token });
  const inputBuilder = ACTOR_INPUT[args.actor];
  const inputOpts: ActorInputOpts = {
    excludedSkills: args.excludedSkills,
    freshnessHours: args.freshnessHours,
  };
  const input = inputBuilder ? inputBuilder(args.query, args.limit, inputOpts) : { query: args.query, limit: args.limit };

  const startedAt = new Date().toISOString();
  const startedRun = await client.actor(actorId).start(input);

  writeRunMeta(startedRun.id, {
    runId: startedRun.id,
    datasetId: startedRun.defaultDatasetId,
    actorId,
    actorAlias: args.actor,
    platform: args.platform,
    query: args.query,
    limit: args.limit,
    sweepId: args.sweepId,
    input,
    startedAt,
    initialStatus: startedRun.status,
  });

  const finishedRun = await client.run(startedRun.id).waitForFinish({ waitSecs: 600 });
  const finishedAt = new Date().toISOString();

  if (finishedRun.status !== "SUCCEEDED") {
    throw new ApifyIncompleteRunError(
      startedRun.id,
      finishedRun.status,
      finishedRun.defaultDatasetId,
      args.actor,
      args.platform,
    );
  }

  const datasetId = finishedRun.defaultDatasetId;
  if (!datasetId) {
    throw new ApifyIncompleteRunError(startedRun.id, "NO_DATASET", undefined, args.actor, args.platform);
  }
  const { items: rawItems } = await client.dataset(datasetId).listItems({ limit: args.limit });

  writeRunItems(startedRun.id, rawItems);

  const normalizer = APIFY_NORMALIZERS[args.platform];
  const normalized: JobItem[] = [];
  for (const item of rawItems) {
    try {
      const n = normalizer(item, args.query);
      if (n) normalized.push(n);
    } catch {
      // skip malformed items
    }
  }

  const excludedLower = (args.excludedSkills ?? []).map((s) => s.toLowerCase());
  const maxProposals = args.maxProposals ?? Infinity;
  const minBudgetFixed = args.minBudgetFixed ?? 0;
  const FULL_TIME_PATTERN = /full[- ]?time|permanent|salaried|\bfte\b|full time employee/i;

  const out = normalized.filter((item) => {
    const raw = item.rawJson as Record<string, unknown>;

    // Upwork (flash_mage): detail shape exposes raw.data.{job,contractTerms};
    // search-result shape exposes raw.data.jobTile.job.{fixedPriceAmount,jobType}.
    // LinkedIn (curious_coder): legacy fields on raw root.
    const upworkData = (raw.data ?? {}) as Record<string, unknown>;
    const upworkJob = (upworkData.job ?? {}) as Record<string, unknown>;
    const upworkContract = (upworkData.contractTerms ?? {}) as Record<string, unknown>;
    const upworkFixed = (upworkContract.fixedPriceContractTerms ?? {}) as Record<string, unknown>;
    const upworkTile = ((upworkData.jobTile ?? {}) as Record<string, unknown>).job as Record<string, unknown> | undefined ?? {};
    const upworkTileFixed = (upworkTile.fixedPriceAmount ?? {}) as Record<string, unknown>;

    const proposals = Number(
      upworkJob.totalApplicants
      ?? raw.proposalCount ?? raw.proposals ?? raw.bids
      ?? item.engagement.comments ?? 0,
    );
    if (proposals > maxProposals) return false;

    const fixedBudget = Number(
      (upworkFixed.amount as Record<string, unknown> | undefined)?.amount
      ?? upworkTileFixed.amount
      ?? 0,
    );
    const budget = fixedBudget > 0 ? fixedBudget : Number(raw.budget ?? raw.budgetAmount ?? 0);
    const upworkJobType = String(upworkTile.jobType ?? raw.jobType ?? raw.type ?? "").toLowerCase();
    const isFixedJob = fixedBudget > 0 || upworkJobType.includes("fixed");
    if (isFixedJob && budget > 0 && budget < minBudgetFixed) return false;

    if (args.platform === "linkedin" && raw.isActivelyHiring === false) return false;

    if (args.platform === "linkedin") {
      const empType = String(raw.employmentType ?? raw.contractType ?? "").toLowerCase();
      const titleBody = `${item.title} ${item.body}`.toLowerCase();
      if (FULL_TIME_PATTERN.test(empType) || FULL_TIME_PATTERN.test(titleBody)) return false;
    }

    if (excludedLower.length > 0) {
      const titleLower = item.title.toLowerCase();
      if (excludedLower.some((s) => titleLower.includes(s))) return false;
    }

    return true;
  });

  return {
    items: out,
    apifyRunId: startedRun.id,
    datasetId,
    status: finishedRun.status,
    itemCountRaw: rawItems.length,
    startedAt,
    finishedAt,
  };
}
