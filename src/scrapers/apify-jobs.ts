/**
 * Generic Apify-backed job listing collectors.
 *
 * Every actor run must end in one of two terminal outcomes:
 *   1. SUCCEEDED - raw dataset items are persisted and normalized.
 *   2. NOT-SUCCEEDED - ApifyIncompleteRunError is thrown with run metadata.
 *
 * Scout returns generic job listings. Host applications decide how those
 * listings map into their own product schemas.
 */
import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { ApifyClient } from "apify-client";

// ─── Types ────────────────────────────────────────────────────────────────────

export type JobListing = {
  id: string;
  url: string;
  title: string;
  description: string;
  author?: string;
  platform: ApifyPlatform;
  publishedAt?: string;
  metrics: {
    budget?: number;
    applicants?: number;
  };
  raw: unknown;
};

// Actor alias -> Apify actor ID mapping for common job listing actors.
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

function stableUrlId(prefix: string, url: string): string {
  return `${prefix}:${createHash("sha256").update(url).digest("hex").slice(0, 24)}`;
}

// ─── Token ───────────────────────────────────────────────────────────────────

function getApifyToken(): string {
  const raw = process.env.APIFY_TOKENS ?? "";
  return raw.split(",")[0]?.trim() ?? "";
}

// ─── Disk audit helpers ──────────────────────────────────────────────────────

function apifyRunsDir(): string {
  const dir = path.join(process.cwd(), "logs", "apify-runs");
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
function normalizeUpwork(item: unknown, query: string): JobListing | null {
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

  const id = stableUrlId("upwork", url);
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
    id,
    url,
    title,
    description,
    author: buyerCompany,
    platform: "upwork",
    publishedAt: (opening.postedOn ?? tileJob.publishTime ?? tileJob.createTime) as string | undefined,
    metrics: {
      budget: score,
      applicants: totalApplicants,
    },
    raw: item,
  };
}

function normalizeLinkedin(item: unknown, query: string): JobListing | null {
  const i = item as Record<string, unknown>;
  const url = (i.url ?? i.jobUrl ?? i.link ?? i.applyUrl ?? "") as string;
  if (!url) return null;
  const id = (i.id ?? i.jobId ?? stableUrlId("linkedin-job", url)) as string;
  const companySlug = i.companyUrl
    ? String(i.companyUrl).match(/\/company\/([^/?#]+)/)?.[1] ?? undefined
    : (i.companySlug as string | undefined);
  const posterPublicIdentifier = (i.posterPublicIdentifier ?? i.recruiterPublicIdentifier) as string | undefined;
  return {
    id,
    url,
    title: ((i.title ?? i.jobTitle ?? query) as string),
    description: ((i.description ?? i.jobDescription ?? i.descriptionHtml ?? "") as string).replace(/<[^>]+>/g, "").slice(0, 2000),
    author: ((i.company ?? i.companyName ?? i.organization) as string | undefined),
    platform: "linkedin",
    publishedAt: (i.postedAt ?? i.postedDate ?? i.date) as string | undefined,
    metrics: {
      applicants: (i.applicants ?? i.applies ?? 0) as number,
    },
    raw: { ...i, companySlug, posterPublicIdentifier },
  };
}

function normalizePeoplePerHour(item: unknown, query: string): JobListing | null {
  const i = item as Record<string, unknown>;
  const url = (i.url ?? i.jobUrl ?? i.link ?? "") as string;
  if (!url) return null;
  const id = (i.id ?? i.jobId ?? stableUrlId("peopleperhour-job", url)) as string;
  return {
    id,
    url,
    title: ((i.title ?? i.jobTitle ?? query) as string),
    description: ((i.description ?? i.snippet ?? "") as string).slice(0, 2000),
    author: ((i.buyer ?? i.clientName ?? i.poster) as string | undefined),
    platform: "peopleperhour",
    publishedAt: (i.postedAt ?? i.date ?? i.createdAt) as string | undefined,
    metrics: {
      budget: (i.budget ?? i.budgetMin ?? 0) as number,
      applicants: (i.proposalCount ?? i.bids ?? 0) as number,
    },
    raw: item,
  };
}

export type ApifyPlatform = "upwork" | "linkedin" | "peopleperhour";

export const JOB_NORMALIZERS: Record<ApifyPlatform, (item: unknown, query: string) => JobListing | null> = {
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
  actor: string;
  apifyActorId?: string;
  platform: ApifyPlatform;
  query: string;
  limit: number;
  runGroupId?: string;
  excludedSkills?: string[];
  maxProposals?: number;
  minBudgetFixed?: number;
  freshnessHours?: number;
}

export interface ApifyJobsCollectorResult {
  items: JobListing[];
  apifyRunId: string;
  datasetId: string;
  status: string;
  itemCountRaw: number;
  startedAt: string;
  finishedAt: string;
  /** Actual Apify compute cost for this run in USD (from Run.usageTotalUsd). */
  usageTotalUsd: number;
}

/**
 * Run an Apify actor end-to-end with full audit trail and integrity guarantees.
 */
export async function collectFromApifyJobs(args: ApifyJobsCollectorArgs): Promise<ApifyJobsCollectorResult> {
  const token = getApifyToken();
  if (!token) throw new Error("APIFY_TOKENS not set in .env");

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
    runGroupId: args.runGroupId,
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

  const normalizer = JOB_NORMALIZERS[args.platform];
  const normalized: JobListing[] = [];
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
    const raw = item.raw as Record<string, unknown>;

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
      ?? item.metrics.applicants ?? 0,
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
      const titleBody = `${item.title} ${item.description}`.toLowerCase();
      if (FULL_TIME_PATTERN.test(empType) || FULL_TIME_PATTERN.test(titleBody)) return false;
    }

    if (excludedLower.length > 0) {
      const titleLower = item.title.toLowerCase();
      if (excludedLower.some((s) => titleLower.includes(s))) return false;
    }

    return true;
  });

  const settledRun = await client.run(startedRun.id).get();

  return {
    items: out,
    apifyRunId: startedRun.id,
    datasetId,
    status: finishedRun.status,
    itemCountRaw: rawItems.length,
    startedAt,
    finishedAt,
    usageTotalUsd: settledRun?.usageTotalUsd ?? finishedRun.usageTotalUsd ?? 0,
  };
}
