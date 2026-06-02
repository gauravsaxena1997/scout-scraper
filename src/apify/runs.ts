import { ApifyClient } from "apify-client";

export type ApifyRunActorArgs = {
  actorId: string;
  input: Record<string, unknown>;
  limit?: number;
  waitSecs?: number;
};

export type ApifyRunActorResult = {
  actorId: string;
  runId: string;
  status: string;
  datasetId: string | undefined;
  itemCountRaw: number;
  items: unknown[];
  startedAt?: string;
  finishedAt?: string;
  usageTotalUsd: number;
};

export type RecoverApifyRunArgs = {
  runId: string;
  limit?: number;
};

export type ListApifyRunsArgs = {
  actorId: string;
  limit?: number;
  status?: string;
};

export type ApifyRunSummary = {
  id: string;
  status: string;
  startedAt?: string;
  finishedAt?: string;
  usageTotalUsd: number;
  datasetId?: string;
};

function getApifyToken(): string {
  const raw = process.env.APIFY_TOKENS ?? "";
  return raw.split(",")[0]?.trim() ?? "";
}

function client(): ApifyClient {
  const token = getApifyToken();
  if (!token) throw new Error("APIFY_TOKENS not set");
  return new ApifyClient({ token });
}

function iso(value: Date | string | undefined): string | undefined {
  return value instanceof Date ? value.toISOString() : value;
}

export async function runApifyActor(args: ApifyRunActorArgs): Promise<ApifyRunActorResult> {
  const apify = client();
  const startedRun = await apify.actor(args.actorId).start(args.input);
  const finishedRun = await apify.run(startedRun.id).waitForFinish({ waitSecs: args.waitSecs ?? 600 });
  const settledRun = await apify.run(startedRun.id).get();
  const datasetId = finishedRun.defaultDatasetId;
  const rawItems = datasetId
    ? (await apify.dataset(datasetId).listItems({ limit: args.limit ?? 1000 })).items
    : [];

  return {
    actorId: args.actorId,
    runId: startedRun.id,
    status: finishedRun.status,
    datasetId,
    itemCountRaw: rawItems.length,
    items: rawItems,
    startedAt: iso(settledRun?.startedAt ?? finishedRun.startedAt),
    finishedAt: iso(settledRun?.finishedAt ?? finishedRun.finishedAt),
    usageTotalUsd: settledRun?.usageTotalUsd ?? finishedRun.usageTotalUsd ?? 0,
  };
}

export async function recoverApifyRun(args: RecoverApifyRunArgs): Promise<Omit<ApifyRunActorResult, "actorId">> {
  const apify = client();
  const run = await apify.run(args.runId).get();
  if (!run) throw new Error(`Apify run ${args.runId} not found`);

  const datasetId = run.defaultDatasetId;
  const rawItems = datasetId
    ? (await apify.dataset(datasetId).listItems({ limit: args.limit ?? 1000 })).items
    : [];

  return {
    runId: run.id,
    status: run.status,
    datasetId,
    itemCountRaw: rawItems.length,
    items: rawItems,
    startedAt: iso(run.startedAt),
    finishedAt: iso(run.finishedAt),
    usageTotalUsd: run.usageTotalUsd ?? 0,
  };
}

export async function listApifyRuns(args: ListApifyRunsArgs): Promise<ApifyRunSummary[]> {
  const apify = client();
  const { items } = await apify.actor(args.actorId).runs().list({
    limit: args.limit ?? 20,
    desc: true,
  });
  const filtered = args.status ? items.filter((run) => run.status === args.status) : items;
  return filtered.map((run) => ({
    id: run.id,
    status: run.status,
    startedAt: iso(run.startedAt),
    finishedAt: iso(run.finishedAt),
    usageTotalUsd: run.usageTotalUsd ?? 0,
    datasetId: run.defaultDatasetId,
  }));
}
