import { query } from "./_generated/server";

const DAY = 24 * 60 * 60 * 1000;

// All-time is capped rather than unbounded: a Convex query must stay within
// its read limits, and this dashboard only needs a headline figure. If the
// cap is ever hit the UI shows it as a floor ("$1.23+") rather than lying.
const ALL_TIME_CAP = 10_000;

export const summary = query({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();

    const rows = await ctx.db
      .query("llmUsage")
      .withIndex("by_createdAt")
      .order("desc")
      .take(ALL_TIME_CAP);

    const sum = (rs: typeof rows) => rs.reduce((n, r) => n + r.cost, 0);
    const since = (ms: number) => rows.filter((r) => r.createdAt >= now - ms);

    const last24h = since(DAY);
    const last7d = since(7 * DAY);
    const last30d = since(30 * DAY);

    const byModel: Record<string, { calls: number; cost: number; tokens: number }> = {};
    for (const r of rows) {
      const m = (byModel[r.model] ??= { calls: 0, cost: 0, tokens: 0 });
      m.calls += 1;
      m.cost += r.cost;
      m.tokens += r.totalTokens;
    }

    const failed = rows.filter((r) => r.status === "failed");

    return {
      last24h: { calls: last24h.length, cost: sum(last24h) },
      last7d: { calls: last7d.length, cost: sum(last7d) },
      last30d: { calls: last30d.length, cost: sum(last30d) },
      allTime: { calls: rows.length, cost: sum(rows), capped: rows.length >= ALL_TIME_CAP },
      avgCostPerCall: rows.length ? sum(rows) / rows.length : 0,
      // Calls that were billed but produced no usable answer — money wasted.
      wasted: { calls: failed.length, cost: sum(failed) },
      byModel,
    };
  },
});
