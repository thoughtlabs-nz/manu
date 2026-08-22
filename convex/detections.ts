import { internalMutation, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
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
    const detectionId = await ctx.db.insert("detections", {
      ...args,
      receivedAt: Date.now(),
    });

    // Fires immediately, so this payload has no species and usually no photo
    // yet — the snapshot arrives on a separate request moments later. The
    // relay that wants a named bird with a picture should listen for
    // species_identified instead. Scheduled rather than awaited because a
    // mutation cannot make outbound requests, and because a slow or dead
    // webhook must never delay ingesting a sighting.
    await ctx.scheduler.runAfter(0, internal.webhooks.deliver, {
      event: "detection",
      detectionId,
    });

    return detectionId;
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

// Deletes a detection and its linked snapshot (both the DB row and the
// stored file). No auth on this app yet — the press-and-hold gesture on the
// client is protection against accidental taps, not against a stranger with
// the URL; same caveat as testUpload.
export const remove = mutation({
  args: { detectionId: v.id("detections") },
  handler: async (ctx, { detectionId }) => {
    const detection = await ctx.db.get(detectionId);
    if (!detection) return;

    // Delete EVERY snapshot belonging to this detection, not just the one
    // detection.snapshotId points at. The device uploads a snapshot on each
    // inference for the whole cooldown, so a sighting can own several; the
    // rest were previously left behind with their storage blobs.
    const owned = await ctx.db
      .query("snapshots")
      .withIndex("by_detection", (q) => q.eq("detectionId", detectionId))
      .collect();

    const seen = new Set<string>();
    for (const snapshot of owned) {
      seen.add(snapshot._id as string);
      await ctx.storage.delete(snapshot.storageId);
      await ctx.db.delete(snapshot._id);
    }

    // Belt and braces: the forward reference may point at a row whose
    // back-reference was never written.
    if (detection.snapshotId && !seen.has(detection.snapshotId as string)) {
      const snapshot = await ctx.db.get(detection.snapshotId);
      if (snapshot) {
        await ctx.storage.delete(snapshot.storageId);
        await ctx.db.delete(snapshot._id);
      }
    }

    await ctx.db.delete(detectionId);
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
