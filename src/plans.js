// BATON plans — structure, quotas, gating. Payment integration (Lemon Squeezy / Stripe keys,
// pricing, legal) is a human step; this file is the enforcement layer the app runs against.
export const PLANS = {
  free: {
    label: "Free", price: 0,
    limits: { snapshotsPerMonth: 20, activeRooms: 2, retentionDays: 7, corpusPull: true },
  },
  pro: {
    label: "Pro", price: 8,
    limits: { snapshotsPerMonth: Infinity, activeRooms: Infinity, retentionDays: 90, corpusPull: true },
  },
  team: {
    label: "Team", price: 25,
    limits: { snapshotsPerMonth: Infinity, activeRooms: Infinity, retentionDays: 365, corpusPull: true, org: true, audit: true },
  },
};

export function planOf(name) { return PLANS[name] || PLANS.free; }

// Anonymous (no api_key / unregistered) callers share ONE global bucket because MCP tool
// calls carry no client IP. Keep it generous so honest anonymous use isn't griefed by one
// heavy user; the real paid gate (20/mo) applies to REGISTERED Free accounts. At payment
// launch this converts to "signup required for a personal bucket" (see BILLING.md).
export const ANON_MONTHLY = 10000;

// yyyy-mm bucket for monthly counters. Timestamp passed in (Date.now() is unavailable in some contexts).
export function monthKey(ts) {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
