import { internalMutation, query } from "./_generated/server";
import { v } from "convex/values";
import type { QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";

async function withSnapshotUrl(ctx: QueryCtx, d: Doc<"detections">) {
  let snapshotUrl: string | null = null;
  if (d.snapshotId) {
    const snap = await ctx.db.get(d.snapshotId);
    if (snap) snapshotUrl = await ctx.storage.getUrl(snap.storageId);
  }
  return { ...d, snapshotUrl };
}

export const ingest = internalMutation({
  args: {
    device: v.string(),
    species: v.string(),
    confidence: v.number(),
    objectCount: v.number(),
    deviceTs: v.number(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("detections", {
      ...args,
      receivedAt: Date.now(),
    });
  },
});

// Recent detections, newest first, with a signed URL for the snapshot if one
// was linked. This is the main feed query for the web app.
export const recent = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const rows = await ctx.db
      .query("detections")
      .withIndex("by_receivedAt")
      .order("desc")
      .take(Math.min(limit ?? 50, 200));

    return await Promise.all(rows.map((d) => withSnapshotUrl(ctx, d)));
  },
});

// All detections within a caller-computed time window (the client owns day
// boundaries so "today" respects the viewer's local timezone, not the
// server's). Used when a calendar day is selected.
export const byDay = query({
  args: { start: v.number(), end: v.number() },
  handler: async (ctx, { start, end }) => {
    const rows = await ctx.db
      .query("detections")
      .withIndex("by_receivedAt", (q) => q.gte("receivedAt", start).lt("receivedAt", end))
      .order("desc")
      .collect();
    return await Promise.all(rows.map((d) => withSnapshotUrl(ctx, d)));
  },
});

// Lightweight rows (no snapshot lookups) for the calendar's per-day dots and
// the reports panel. Capped for safety; a personal camera won't get near this.
export const summary = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("detections")
      .withIndex("by_receivedAt")
      .order("desc")
      .take(5000);
    return rows.map((d) => ({
      _id: d._id,
      receivedAt: d.receivedAt,
      species: d.species,
      speciesCommonName: d.speciesCommonName,
      speciesStatus: d.speciesStatus,
    }));
  },
});

// Simple per-device summary for a dashboard header.
export const stats = query({
  args: {},
  handler: async (ctx) => {
    const since = Date.now() - 24 * 60 * 60 * 1000;
    const recent = await ctx.db
      .query("detections")
      .withIndex("by_receivedAt", (q) => q.gte("receivedAt", since))
      .collect();

    const byDevice: Record<string, number> = {};
    for (const d of recent) {
      byDevice[d.device] = (byDevice[d.device] ?? 0) + 1;
    }
    return {
      last24h: recent.length,
      byDevice,
      latestAt: recent.length
        ? Math.max(...recent.map((d) => d.receivedAt))
        : null,
    };
  },
});
