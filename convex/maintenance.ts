import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

// Batched: a single Convex mutation has read/write limits, and there can be
// thousands of orphans. Call repeatedly until `remaining` is 0.
const BATCH = 200;

export const orphanReport = query({
  args: {},
  handler: async (ctx) => {
    const snapshots = await ctx.db.query("snapshots").collect();
    const captures = await ctx.db.query("captures").collect();
    const detections = await ctx.db.query("detections").collect();
    const files = await ctx.db.system.query("_storage").collect();

    const liveDetections = new Set(detections.map((d) => d._id as string));
    // A snapshot is dead if it never linked to a detection, or its detection
    // has since been deleted.
    const deadSnapshots = snapshots.filter(
      (s) => !s.detectionId || !liveDetections.has(s.detectionId as string)
    );
    const referenced = new Set<string>([
      ...snapshots.map((s) => s.storageId as string),
      ...captures.map((c) => c.storageId as string),
    ]);
    const orphanFiles = files.filter((f) => !referenced.has(f._id as string));

    return {
      detections: detections.length,
      snapshots: snapshots.length,
      captures: captures.length,
      // Snapshot rows whose detection is gone (or that never had one).
      deadSnapshotRows: deadSnapshots.length,
      // Storage blobs no row points at.
      orphanFiles: orphanFiles.length,
      orphanBytes: orphanFiles.reduce((n, f) => n + (f.size ?? 0), 0),
      totalFiles: files.length,
      // Should be ~1. Higher means the device is sending more than one
      // snapshot per sighting again (the cooldown-flood this project has hit
      // before), which is wasted uplink, storage and device CPU.
      snapshotsPerDetection:
        detections.length
          ? Number((snapshots.length / detections.length).toFixed(2))
          : 0,
    };
  },
});

// Deletes snapshot rows that belong to no live detection (plus their blobs),
// then storage blobs that no row references at all.
export const cleanupOrphans = mutation({
  args: { confirm: v.literal("yes-delete-orphans") },
  handler: async (ctx) => {
    const detections = await ctx.db.query("detections").collect();
    const live = new Set(detections.map((d) => d._id as string));

    let rowsDeleted = 0;
    const snapshots = await ctx.db.query("snapshots").collect();
    for (const s of snapshots) {
      if (rowsDeleted >= BATCH) break;
      if (s.detectionId && live.has(s.detectionId as string)) continue;
      await ctx.storage.delete(s.storageId);
      await ctx.db.delete(s._id);
      rowsDeleted++;
    }

    // Re-read after the deletions above so we don't delete a blob still in use.
    const remainingSnaps = await ctx.db.query("snapshots").collect();
    const captures = await ctx.db.query("captures").collect();
    const referenced = new Set<string>([
      ...remainingSnaps.map((s) => s.storageId as string),
      ...captures.map((c) => c.storageId as string),
    ]);

    let filesDeleted = 0;
    let bytesFreed = 0;
    const files = await ctx.db.system.query("_storage").collect();
    for (const f of files) {
      if (filesDeleted >= BATCH) break;
      if (referenced.has(f._id as string)) continue;
      bytesFreed += f.size ?? 0;
      await ctx.storage.delete(f._id);
      filesDeleted++;
    }

    const remaining =
      files.filter((f) => !referenced.has(f._id as string)).length - filesDeleted;

    return { rowsDeleted, filesDeleted, bytesFreed, remaining: Math.max(remaining, 0) };
  },
});
