/**
 * Simple in-memory sliding-window limiter. Fine for a single instance;
 * swap for Redis/Upstash if you scale to multiple instances.
 */
const buckets = new Map<string, number[]>();

export function rateLimit(key: string, limit = 20, windowMs = 10 * 60 * 1000) {
  const now = Date.now();
  const hits = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  if (hits.length >= limit) {
    buckets.set(key, hits);
    return { ok: false, retryAfter: Math.ceil((windowMs - (now - hits[0])) / 1000) };
  }
  hits.push(now);
  buckets.set(key, hits);
  if (buckets.size > 5000) {
    for (const [k, v] of buckets) if (!v.some((t) => now - t < windowMs)) buckets.delete(k);
  }
  return { ok: true, retryAfter: 0 };
}
