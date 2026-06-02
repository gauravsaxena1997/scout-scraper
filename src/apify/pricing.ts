export type PricingModel =
  | "PRICE_PER_DATASET_ITEM"
  | "PAY_PER_EVENT"
  | "FLAT_PRICE_PER_MONTH"
  | "FREE";

export type ActorPricing = {
  costPerResult: number | null;
  pricingModel: PricingModel | null;
  raw: unknown;
};

const APIFY_BASE = "https://api.apify.com/v2/acts";
const CACHE_TTL_MS = 60 * 60 * 1000;

const pricingCache = new Map<string, { expiresAt: number; value: ActorPricing }>();

function getApifyToken(): string {
  const raw = process.env.APIFY_TOKENS ?? "";
  return raw.split(",")[0]?.trim() ?? "";
}

function actorIdToUrl(actorId: string): string {
  return `${APIFY_BASE}/${actorId.replace("/", "~")}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function pickLatestPricing(pricingInfos: unknown): Record<string, unknown> | null {
  if (!Array.isArray(pricingInfos) || pricingInfos.length === 0) return null;
  let best: Record<string, unknown> | null = null;
  let bestAt = "";
  for (const entry of pricingInfos) {
    const record = asRecord(entry);
    if (!record) continue;
    const startedAt = record.startedAt;
    const ts = typeof startedAt === "string" ? startedAt : "";
    if (ts >= bestAt) {
      bestAt = ts;
      best = record;
    }
  }
  return best;
}

function eventPrice(event: unknown): number | null {
  const record = asRecord(event);
  if (!record) return null;
  const flat = record.eventPriceUsd;
  if (typeof flat === "number") return flat;

  const tiered = asRecord(record.eventTieredPricingUsd);
  const free = tiered ? asRecord(tiered.FREE) : null;
  const price = free?.tieredEventPriceUsd;
  return typeof price === "number" ? price : null;
}

function extractPerResultPrice(entry: Record<string, unknown>): number | null {
  const model = entry.pricingModel as PricingModel | undefined;

  if (model === "FREE") return 0;
  if (model === "PRICE_PER_DATASET_ITEM") {
    const value = entry.pricePerUnitUsd;
    return typeof value === "number" ? value : null;
  }
  if (model === "PAY_PER_EVENT") {
    const pricingPerEvent = asRecord(entry.pricingPerEvent);
    const events = pricingPerEvent ? asRecord(pricingPerEvent.actorChargeEvents) : null;
    if (!events) return null;

    for (const event of Object.values(events)) {
      const record = asRecord(event);
      if (record?.isPrimaryEvent === true) return eventPrice(record);
    }

    for (const key of ["apify-default-dataset-item", "result"]) {
      const price = eventPrice(events[key]);
      if (price !== null) return price;
    }
  }
  return null;
}

export async function fetchActorPricing(actorId: string): Promise<ActorPricing> {
  const token = getApifyToken();
  if (!token) return { costPerResult: null, pricingModel: null, raw: null };

  try {
    const res = await fetch(`${actorIdToUrl(actorId)}?token=${encodeURIComponent(token)}`);
    if (!res.ok) return { costPerResult: null, pricingModel: null, raw: null };

    const json = asRecord(await res.json());
    const data = json ? asRecord(json.data) : null;
    if (!data) return { costPerResult: null, pricingModel: null, raw: null };

    const latest = pickLatestPricing(data.pricingInfos);
    if (!latest) return { costPerResult: 0, pricingModel: "FREE", raw: null };

    const model = (latest.pricingModel as PricingModel | undefined) ?? null;
    return {
      costPerResult: extractPerResultPrice(latest),
      pricingModel: model,
      raw: latest,
    };
  } catch {
    return { costPerResult: null, pricingModel: null, raw: null };
  }
}

export async function getActorPricing(actorId: string): Promise<ActorPricing> {
  const cached = pricingCache.get(actorId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const value = await fetchActorPricing(actorId);
  pricingCache.set(actorId, { expiresAt: Date.now() + CACHE_TTL_MS, value });
  return value;
}
