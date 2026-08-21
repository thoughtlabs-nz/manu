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
    // The device uploads a snapshot on every inference for the whole cooldown,
    // so one sighting owns several. Attribute EVERY snapshot to its detection:
    // previously only the first was linked and the rest were unreachable, so
    // deleting a sighting left them (and their storage blobs) behind forever.
    const owner = candidates[0];
    if (owner) {
      await ctx.db.patch(snapshotId, { detectionId: owner._id });

      // ...but only the first triggers the paid species ID, and only the first
      // becomes the sighting's display image.
      if (owner.snapshotId === undefined) {
        await ctx.db.patch(owner._id, { snapshotId, speciesStatus: "pending" });
        await ctx.scheduler.runAfter(0, internal.species.identify, {
          detectionId: owner._id,
          storageId: args.storageId,
        });
      }
    }

    return snapshotId;
  },
});
