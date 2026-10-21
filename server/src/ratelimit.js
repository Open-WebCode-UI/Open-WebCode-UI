// Minimal fixed-window in-memory rate limiter (per key). Replace with a shared store for multi-instance deployments.
const buckets = new Map();
export function hit(key, limit, windowMs) {
  const t = Date.now();
  let b = buckets.get(key);
  if (!b || b.reset < t) { b = { count: 0, reset: t + windowMs }; buckets.set(key, b); }
  b.count++;
  if (buckets.size > 10000) for (const [k, v] of buckets) if (v.reset < t) buckets.delete(k);
  return b.count <= limit;
}
export const resetRateLimits = () => buckets.clear();
export const rateLimit = (name, limit, windowMs) => (req, res, next) =>
  hit(`${name}:${req.ip}`, limit, windowMs) ? next() : res.status(429).json({ error: 'rate_limited' });
