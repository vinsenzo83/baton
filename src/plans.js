// BATON plans — structure, quotas, gating. Payment integration (Lemon Squeezy / Stripe keys,
// pricing, legal) is a human step; this file is the enforcement layer the app runs against.
export const PLANS = {
  free: {
    label: "Free", price: 0,
    limits: { snapshotsPerMonth: 20, activeRooms: 2, seats: 1, retentionDays: 7, corpusPull: true },
  },
  pro: {
    label: "Pro", price: 8,
    limits: { snapshotsPerMonth: Infinity, activeRooms: 20, seats: 1, retentionDays: 90, corpusPull: true },
  },
  team: {
    // Seat-based: base price covers `seats` concurrent members sharing the org (measured by
    // join events, no heartbeat needed). This is the healthy "collaboration" charge (§ pricing review).
    label: "Team", price: 25,
    limits: { snapshotsPerMonth: Infinity, activeRooms: Infinity, seats: 5, retentionDays: 365, corpusPull: true, org: true, audit: true },
  },
};

export function planOf(name) { return PLANS[name] || PLANS.free; }

// Anonymous (no api_key) = a small free TRIAL, per-key-less shared bucket. Low on purpose so
// real use hits the wall and converts to a free signup (baton_signup → own 20/mo bucket).
// Tune here; the whole funnel keys off this number.
export const ANON_MONTHLY = 5;

// yyyy-mm bucket for monthly counters. Timestamp passed in (Date.now() is unavailable in some contexts).
export function monthKey(ts) {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
