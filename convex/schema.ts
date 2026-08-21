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
    // USD charged for this sighting's species ID, for per-entry display.
    speciesCost: v.optional(v.number()),
  })
    .index("by_receivedAt", ["receivedAt"])
    .index("by_device", ["device", "receivedAt"]),

  // One row per OpenRouter call. Separate from detections so that calls which
  // succeed upstream but fail to parse — which are still billed — are counted,
  // and so cost history survives a detection being deleted.
  llmUsage: defineTable({
    detectionId: v.optional(v.id("detections")),
    model: v.string(),
    promptTokens: v.number(),
    completionTokens: v.number(),
    totalTokens: v.number(),
    // USD actually charged to the account (OpenRouter `usage.cost`).
    cost: v.number(),
    status: v.union(v.literal("done"), v.literal("failed")),
    createdAt: v.number(),
  }).index("by_createdAt", ["createdAt"]),

  // Raw training-data frames from capture mode. Deliberately NOT the same
  // table as snapshots: these are unlabelled bulk frames, must never be linked
  // to a detection, and must never trigger the (paid) species-ID pass.
  captures: defineTable({
    device: v.string(),
    deviceTs: v.number(),
    receivedAt: v.number(),
    storageId: v.id("_storage"),
    bytes: v.number(),
  }).index("by_receivedAt", ["receivedAt"]),

  snapshots: defineTable({
    device: v.string(),
    deviceTs: v.number(),
    receivedAt: v.number(),
    storageId: v.id("_storage"),
    detectionId: v.optional(v.id("detections")),
  })
    .index("by_device", ["device", "receivedAt"])
    // Lets a delete find EVERY snapshot belonging to a detection, not just the
    // one detection.snapshotId points at.
    .index("by_detection", ["detectionId"]),
});
