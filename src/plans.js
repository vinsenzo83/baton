// BATON plans — structure, quotas, gating. Payment integration (Lemon Squeezy / Stripe keys,
// pricing, legal) is a human step; this file is the enforcement layer the app runs against.
// SEAT = one concurrent session (participant) in a room. Orchestrating Claude + Codex +
// Gemini + people together = that many seats. This is BATON's core value axis: how big an
// AI orchestra you can run. Measured by member COUNT on join — no heartbeat needed.
// Handoff count is the secondary axis (solo use); seats is the collaboration axis (teams).
export const PLANS = {
  free: {
    label: "Free", price: 0,
    limits: { seatsPerRoom: 2, snapshotsPerMonth: 20, activeRooms: 3, retentionDays: 7, corpusPull: true },
  },
  pro: {
    label: "Pro", price: 8,
    limits: { seatsPerRoom: 4, snapshotsPerMonth: Infinity, activeRooms: 20, retentionDays: 90, corpusPull: true },
  },
  team: {
    label: "Team", price: 25,
    limits: { seatsPerRoom: 10, snapshotsPerMonth: Infinity, activeRooms: Infinity, retentionDays: 365, corpusPull: true, org: true, audit: true },
  },
};

export function planOf(name) { return PLANS[name] || PLANS.free; }

// Anonymous (no api_key) = a small free TRIAL, per-key-less shared bucket. Low on purpose so
// real use hits the wall and converts to a free signup (baton_signup → own 20/mo bucket).
// Tune here; the whole funnel keys off this number.
// PAYMENT OFF (pivot phase): all gating disabled so the product can be dogfooded freely.
// Set BATON_BILLING=on to re-enable the funnel/seats/quotas later. Runtime-checked (not
// import-time) so tests and env changes take effect without reload.
export const isBillingOn = () => process.env.BATON_BILLING === "on";
export const anonMonthly = () => (isBillingOn() ? 5 : Infinity);

// yyyy-mm bucket for monthly counters. Timestamp passed in (Date.now() is unavailable in some contexts).
export function monthKey(ts) {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
