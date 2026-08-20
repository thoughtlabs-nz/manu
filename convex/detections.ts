import { internalMutation, query } from "./_generated/server";
import { v } from "convex/values";

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

    return await Promise.all(
      rows.map(async (d) => {
        let snapshotUrl: string | null = null;
        if (d.snapshotId) {
          const snap = await ctx.db.get(d.snapshotId);
          if (snap) snapshotUrl = await ctx.storage.getUrl(snap.storageId);
        }
        return { ...d, snapshotUrl };
      })
    );
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
