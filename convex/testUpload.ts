import { v } from "convex/values";
import { mutation } from "./_generated/server";
import { internal } from "./_generated/api";

// This mutation has no auth (neither does the rest of this dashboard yet),
// so it's a soft target for abuse if the URL leaks. Cap volume rather than
// leave it fully open — cheap insurance against a runaway OpenRouter bill.
const RATE_LIMIT_PER_HOUR = 30;
const DEVICE_LABEL = "test-upload";

export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    return await ctx.storage.generateUploadUrl();
  },
});

export const createFromUpload = mutation({
  args: { storageId: v.id("_storage") },
  handler: async (ctx, { storageId }) => {
    const now = Date.now();
    const recentTestUploads = await ctx.db
      .query("detections")
      .withIndex("by_device", (q) =>
        q.eq("device", DEVICE_LABEL).gte("receivedAt", now - 60 * 60 * 1000)
      )
      .collect();
    if (recentTestUploads.length >= RATE_LIMIT_PER_HOUR) {
      throw new Error(
        `Rate limit: ${RATE_LIMIT_PER_HOUR} test uploads/hour reached. Try again later.`
      );
    }

    const snapshotId = await ctx.db.insert("snapshots", {
      device: DEVICE_LABEL,
      deviceTs: Math.floor(now / 1000),
      receivedAt: now,
      storageId,
    });
    const detectionId = await ctx.db.insert("detections", {
      device: DEVICE_LABEL,
      species: "bird",
      confidence: 1,
      objectCount: 1,
      deviceTs: Math.floor(now / 1000),
      receivedAt: now,
      snapshotId,
      speciesStatus: "pending",
    });
    await ctx.db.patch(snapshotId, { detectionId });
    await ctx.scheduler.runAfter(0, internal.species.identify, {
      detectionId,
      storageId,
    });
    return detectionId;
  },
});
