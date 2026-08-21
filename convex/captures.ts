import { internalMutation, mutation, query } from "./_generated/server";
import { v } from "convex/values";

// Capture mode can run for hours at ~40KB/frame, so cap how much we keep.
// At the default 10s capture interval this is roughly 14 hours of collection.
const MAX_CAPTURES = 5000;

export const ingest = internalMutation({
  args: {
    device: v.string(),
    deviceTs: v.number(),
    storageId: v.id("_storage"),
    bytes: v.number(),
  },
  handler: async (ctx, args) => {
    const total = await ctx.db.query("captures").take(MAX_CAPTURES + 1);
    if (total.length > MAX_CAPTURES) {
      // Refuse rather than silently evicting: losing the oldest frames of a
      // deliberate collection run is worse than being told to stop.
      throw new Error(
        `Capture limit reached (${MAX_CAPTURES}). Download and clear them before collecting more.`
      );
    }
    return await ctx.db.insert("captures", { ...args, receivedAt: Date.now() });
  },
});

// Paged listing with download URLs, for pulling the set down to label.
export const list = query({
  args: { limit: v.optional(v.number()), before: v.optional(v.number()) },
  handler: async (ctx, { limit, before }) => {
    const rows = await ctx.db
      .query("captures")
      .withIndex("by_receivedAt", (q) =>
        before === undefined ? q : q.lt("receivedAt", before)
      )
      .order("desc")
      .take(Math.min(limit ?? 200, 500));

    return Promise.all(
      rows.map(async (r) => ({
        id: r._id,
        receivedAt: r.receivedAt,
        bytes: r.bytes,
        url: await ctx.storage.getUrl(r.storageId),
      }))
    );
  },
});

export const stats = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("captures").take(MAX_CAPTURES + 1);
    return {
      count: rows.length,
      totalBytes: rows.reduce((n, r) => n + r.bytes, 0),
      limit: MAX_CAPTURES,
    };
  },
});

// Delete every capture and its stored blob. Destructive and irreversible —
// intended for after you have downloaded a collection run with
// scripts/fetch_captures.py. Deliberately not called by anything automatic.
export const clear = mutation({
  args: { confirm: v.literal("yes-delete-all-captures") },
  handler: async (ctx) => {
    const rows = await ctx.db.query("captures").collect();
    for (const r of rows) {
      await ctx.storage.delete(r.storageId);
      await ctx.db.delete(r._id);
    }
    return { deleted: rows.length };
  },
});
