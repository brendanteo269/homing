/**
 * A token bucket per caller, held in memory.
 *
 * Nothing here is authentication and nothing here is a quota. The job is
 * narrower: one loop pointed at `/api/analyse` should not be able to run up a
 * compute bill, and a burst of searches should not get this deployment's
 * address throttled by OneMap — which would break the app for everybody, not
 * just for whoever was noisy.
 *
 * A bucket refills continuously rather than resetting on a clock edge, so a
 * reader who pauses for a few seconds always has room again, while a script
 * running flat out settles at exactly the refill rate.
 *
 * ponytail: per instance, so a deployment running four of them allows four
 * times the rate, and a cold start forgives everything. That is the right
 * trade at this size — it is a brake, not a meter, and it needs no Redis, no
 * account and no dependency. Move the buckets to a shared store if the limit
 * ever has to be exact.
 */

interface Bucket {
  tokens: number;
  at: number;
}

const buckets = new Map<string, Bucket>();
/** Past this, the oldest buckets go. An idle bucket is a full one anyway. */
const MAX_BUCKETS = 10_000;

export interface Limit {
  /** Requests per minute once the burst is spent. */
  perMinute: number;
  /** How many may arrive at once from cold. */
  burst: number;
}

export interface Verdict {
  ok: boolean;
  /** Whole seconds until one more request would be allowed. */
  retryAfter: number;
}

export function take(key: string, { perMinute, burst }: Limit): Verdict {
  const now = Date.now();
  const perMs = perMinute / 60_000;

  if (buckets.size > MAX_BUCKETS) {
    // Cheapest possible eviction: the map is insertion-ordered, so the first
    // keys out are the ones least recently created. Dropping a bucket only
    // ever forgives a caller, so being rough about it costs nothing.
    for (const k of buckets.keys()) {
      buckets.delete(k);
      if (buckets.size <= MAX_BUCKETS / 2) break;
    }
  }

  const bucket = buckets.get(key);
  const tokens = bucket
    ? Math.min(burst, bucket.tokens + (now - bucket.at) * perMs)
    : burst;

  if (tokens < 1) {
    buckets.set(key, { tokens, at: now });
    return { ok: false, retryAfter: Math.max(1, Math.ceil((1 - tokens) / perMs / 1000)) };
  }

  buckets.set(key, { tokens: tokens - 1, at: now });
  return { ok: true, retryAfter: 0 };
}

/**
 * Who is asking, as well as it can be known.
 *
 * Behind a proxy the client address is the first entry in `x-forwarded-for`;
 * the rest of that header is the chain of proxies and is trivially spoofable,
 * so only the first hop is read. With no proxy header at all every caller
 * shares one bucket, which is the safe way round: local development sees the
 * limit rather than silently skipping it.
 */
export function callerOf(request: Request) {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}

/** Only for the check script: bucket state is process-wide and sticky. */
export function resetLimits() {
  buckets.clear();
}
