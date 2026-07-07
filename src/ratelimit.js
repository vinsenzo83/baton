// BATON rate limiting — no dependency, per-IP fixed-window buckets.
// Blocks brute force (code enumeration) and DoS (unbounded room/pattern creation).
const buckets = new Map(); // key -> { count, resetAt }

export function rateLimit({ windowMs = 60_000, max = 60, key = "ip" } = {}) {
  return (req, res, next) => {
    const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket?.remoteAddress || "unknown";
    const k = `${key}:${ip}:${req.path}`;
    const now = Date.now();
    let b = buckets.get(k);
    if (!b || b.resetAt < now) { b = { count: 0, resetAt: now + windowMs }; buckets.set(k, b); }
    b.count++;
    res.setHeader("X-RateLimit-Limit", max);
    res.setHeader("X-RateLimit-Remaining", Math.max(0, max - b.count));
    if (b.count > max) {
      res.setHeader("Retry-After", Math.ceil((b.resetAt - now) / 1000));
      return res.status(429).json({ error: "Too many requests. Slow down." });
    }
    next();
  };
}

// Periodic sweep so the map doesn't grow unbounded.
export function startSweeper(intervalMs = 300_000) {
  const t = setInterval(() => {
    const now = Date.now();
    for (const [k, b] of buckets) if (b.resetAt < now) buckets.delete(k);
  }, intervalMs);
  t.unref?.();
  return t;
}

// Client IP helper for contributor de-duplication (verified-forgery defense).
export function clientIp(req) {
  return (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket?.remoteAddress || "unknown";
}
