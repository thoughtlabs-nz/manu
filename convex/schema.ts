import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  detections: defineTable({
    device: v.string(),
    // COCO class for v1 ("bird"); real species once server-side ID lands
    species: v.string(),
    confidence: v.number(),
    objectCount: v.number(),
    // Epoch seconds reported by the device's SNTP clock (0/small if unsynced)
    deviceTs: v.number(),
    // Server receive time (epoch ms) — authoritative timestamp
    receivedAt: v.number(),
    snapshotId: v.optional(v.id("snapshots")),
    // Server-side species ID (v3), run once a snapshot links to this detection
    speciesStatus: v.optional(
      v.union(v.literal("pending"), v.literal("done"), v.literal("failed"))
    ),
    speciesCommonName: v.optional(v.string()),
    speciesScientificName: v.optional(v.string()),
    speciesConfidence: v.optional(v.number()),
  })
    .index("by_receivedAt", ["receivedAt"])
    .index("by_device", ["device", "receivedAt"]),

  snapshots: defineTable({
    device: v.string(),
    deviceTs: v.number(),
    receivedAt: v.number(),
    storageId: v.id("_storage"),
    detectionId: v.optional(v.id("detections")),
  }).index("by_device", ["device", "receivedAt"]),
});
