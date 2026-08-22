import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";

// Events this app emits. Kept as a closed union so a typo in a caller is a
// type error rather than a webhook nobody ever receives.
export const eventValidator = v.union(
  v.literal("detection"),
  v.literal("species_identified"),
  v.literal("test")
);

const DELIVERY_TIMEOUT_MS = 10_000;

// A user-supplied URL that the SERVER fetches is an SSRF vector: without this
// the endpoint could be pointed at cloud metadata services or anything else
// reachable from Convex's network. This app has no login, so the URL field is
// effectively public input and has to be treated as such.
//
// https-only also stops a secret being posted in clear text.
function validateUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("Not a valid URL");
  }
  if (url.protocol !== "https:") {
    throw new Error("Webhook URL must be https");
  }
  const host = url.hostname.toLowerCase();
  const blocked =
    host === "localhost" ||
    host === "0.0.0.0" ||
    host.endsWith(".localhost") ||
    host.endsWith(".internal") ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host === "[::1]" ||
    host === "::1";
  if (blocked) {
    throw new Error(
      "Webhook URL must be a public host — Convex runs in the cloud and cannot reach your LAN"
    );
  }
  return url.toString();
}

// --- Config -----------------------------------------------------------------

// The secret is deliberately absent from what the UI receives; `hasSecret` is
// enough to render the field's state without ever shipping the value back to a
// browser that anyone can open.
export const get = query({
  args: {},
  handler: async (ctx) => {
    const row = await ctx.db.query("webhook").first();
    if (!row) return null;
    const { secret, ...rest } = row;
    return { ...rest, hasSecret: Boolean(secret) };
  },
});

export const save = mutation({
  args: {
    enabled: v.boolean(),
    url: v.string(),
    onDetection: v.boolean(),
    onSpeciesIdentified: v.boolean(),
    // undefined leaves the stored secret alone; "" clears it. Without that
    // distinction the UI could not offer a field that stays blank when a
    // secret is already set.
    secret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // An empty URL is only allowed while disabled, so the row can exist in a
    // half-configured state without ever being deliverable.
    const url = args.url.trim() ? validateUrl(args.url) : "";
    if (args.enabled && !url) {
      throw new Error("A webhook URL is required to enable delivery");
    }

    const existing = await ctx.db.query("webhook").first();
    const patch = {
      enabled: args.enabled,
      url,
      onDetection: args.onDetection,
      onSpeciesIdentified: args.onSpeciesIdentified,
      updatedAt: Date.now(),
      ...(args.secret === undefined
        ? {}
        : { secret: args.secret.trim() || undefined }),
    };

    if (existing) {
      await ctx.db.patch(existing._id, patch);
    } else {
      await ctx.db.insert("webhook", patch);
    }
  },
});

// --- Delivery ---------------------------------------------------------------

// Read by the delivery action. Internal because it returns the secret.
export const config = internalQuery({
  args: {},
  handler: async (ctx) => await ctx.db.query("webhook").first(),
});

export const recordDelivery = internalMutation({
  args: {
    status: v.optional(v.number()),
    error: v.optional(v.string()),
    event: v.string(),
  },
  handler: async (ctx, { status, error, event }) => {
    const row = await ctx.db.query("webhook").first();
    if (!row) return;
    await ctx.db.patch(row._id, {
      lastStatus: status,
      lastError: error,
      lastEvent: event,
      lastAt: Date.now(),
    });
  },
});

// Assembles the payload at DELIVERY time rather than at trigger time, so a
// species_identified event carries the species and snapshot that were written
// moments earlier by a different mutation.
export const deliver = internalAction({
  args: {
    event: eventValidator,
    detectionId: v.optional(v.id("detections")),
  },
  handler: async (ctx, { event, detectionId }) => {
    const cfg = await ctx.runQuery(internal.webhooks.config);
    if (!cfg || !cfg.url) return;
    // Re-checked here, not just at the trigger, because the config can change
    // between a mutation scheduling this and the action running.
    if (event !== "test") {
      if (!cfg.enabled) return;
      if (event === "detection" && !cfg.onDetection) return;
      if (event === "species_identified" && !cfg.onSpeciesIdentified) return;
    }

    let payload: Record<string, unknown> = {
      event,
      sentAt: new Date().toISOString(),
    };

    if (detectionId) {
      const d = await ctx.runQuery(internal.webhooks.detectionPayload, {
        detectionId,
      });
      if (!d) return; // deleted before this landed
      payload = { ...payload, ...d };
    } else {
      payload = {
        ...payload,
        device: "bird-cam-1",
        species: null,
        confidence: 0.87,
        objectCount: 1,
        snapshotUrl: null,
        note: "Test dispatch from Manu — no sighting is attached.",
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
    try {
      const res = await fetch(cfg.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Manu/1.0 (+https://github.com/thoughtlabs-nz/manu)",
          ...(cfg.secret ? { "X-Manu-Secret": cfg.secret } : {}),
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      await ctx.runMutation(internal.webhooks.recordDelivery, {
        status: res.status,
        error: res.ok ? undefined : (await res.text()).slice(0, 200) || undefined,
        event,
      });
    } catch (err) {
      // A webhook is fire-and-forget: a dead relay must never take down
      // ingestion, so this is recorded and swallowed rather than thrown.
      await ctx.runMutation(internal.webhooks.recordDelivery, {
        error:
          err instanceof Error
            ? err.name === "AbortError"
              ? `Timed out after ${DELIVERY_TIMEOUT_MS / 1000}s`
              : err.message
            : "Delivery failed",
        event,
      });
    } finally {
      clearTimeout(timer);
    }
  },
});

// The sighting as the relay sees it. Flat and stable: n8n expressions are
// written against these field names, so renaming one breaks someone's workflow.
export const detectionPayload = internalQuery({
  args: { detectionId: v.id("detections") },
  handler: async (ctx, { detectionId }) => {
    const d = await ctx.db.get(detectionId);
    if (!d) return null;

    let snapshotUrl: string | null = null;
    if (d.snapshotId) {
      const snap = await ctx.db.get(d.snapshotId);
      if (snap) snapshotUrl = await ctx.storage.getUrl(snap.storageId);
    }

    return {
      detectionId: d._id,
      device: d.device,
      confidence: d.confidence,
      objectCount: d.objectCount,
      deviceTs: d.deviceTs,
      receivedAt: d.receivedAt,
      detectedAt: new Date(d.receivedAt).toISOString(),
      snapshotUrl,
      species:
        d.speciesStatus === "done" && d.speciesCommonName
          ? {
              commonName: d.speciesCommonName,
              scientificName: d.speciesScientificName ?? null,
              confidence: d.speciesConfidence ?? null,
              cost: d.speciesCost ?? null,
            }
          : null,
    };
  },
});

// Fired from the settings panel. Ignores `enabled` and the event toggles so a
// relay can be wired up and proven before anything is switched on.
export const sendTest = mutation({
  args: {},
  handler: async (ctx) => {
    const row = await ctx.db.query("webhook").first();
    if (!row || !row.url) throw new Error("Set a webhook URL first");
    await ctx.scheduler.runAfter(0, internal.webhooks.deliver, {
      event: "test",
    });
  },
});
