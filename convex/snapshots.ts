import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";

// The device POSTs the detection first, then the snapshot moments later.
// Link the snapshot to the most recent unlinked detection from the same
// device within this window.
const LINK_WINDOW_MS = 120_000;

export const ingest = internalMutation({
  args: {
    device: v.string(),
    deviceTs: v.number(),
    storageId: v.id("_storage"),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const snapshotId = await ctx.db.insert("snapshots", {
      ...args,
      receivedAt: now,
    });

    const candidates = await ctx.db
      .query("detections")
      .withIndex("by_device", (q) =>
        q.eq("device", args.device).gte("receivedAt", now - LINK_WINDOW_MS)
      )
      .order("desc")
      .take(10);
    const target = candidates.find((d) => d.snapshotId === undefined);
    if (target) {
      await ctx.db.patch(target._id, { snapshotId, speciesStatus: "pending" });
      await ctx.db.patch(snapshotId, { detectionId: target._id });
      await ctx.scheduler.runAfter(0, internal.species.identify, {
        detectionId: target._id,
        storageId: args.storageId,
      });
    }

    return snapshotId;
  },
});
