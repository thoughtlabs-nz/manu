import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// The settings the UI is allowed to drive, shared by the desired config
// (deviceConfig.settings) and the device's echo of reality
// (deviceStatus.reported) so the two can never drift apart in shape.
//
// Deliberately a SUBSET of what the device exposes. White balance, special
// effect, gain ceiling and the manual exposure/gain pair stay device-local:
// they are set-once-and-forget, and every field added here costs bytes in a
// beacon response that has to fit the device's response buffer.
export const deviceSettings = {
  minConfidence: v.number(),
  detectionEnabled: v.boolean(),
  snapshotUploads: v.boolean(),
  captureMode: v.boolean(),
  captureInterval: v.number(),
  brightness: v.number(),
  contrast: v.number(),
  saturation: v.number(),
  aeLevel: v.number(),
};

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


  // --- Device telemetry & control (the 10s beacon) --------------------------
  //
  // The camera sits on a home LAN behind NAT: Convex can never call it. Every
  // exchange is therefore device-initiated. The beacon is ONE POST every 10s
  // that carries stats up and takes any pending command + desired config back
  // down in the response body, so a single request serves both directions.
  //
  // 10s is a deliberate compromise, not a default. Each beat costs ~2 Convex
  // function calls (HTTP action + mutation), so 10s is ~520k calls/month for
  // one camera against a 1M free-tier budget. Faster beats buy button latency
  // with quota; slower beats save quota at the cost of a laggy UI.

  // ONE row per device, PATCHED in place — never appended. At one row per beat
  // this table would grow 8,640 rows/day/camera describing a "now" that is
  // stale ten seconds later. History that matters already lives in
  // `detections`; this table is a live dashboard, not a log.
  deviceStatus: defineTable({
    device: v.string(),
    // Server receive time (epoch ms). Liveness is derived from this, not from
    // the device clock, which can be unsynced or wrong.
    receivedAt: v.number(),
    deviceTs: v.number(),
    uptime: v.number(),
    rssi: v.number(),
    // Memory is the diagnostic that actually matters on this board: it
    // boot-loops with std::bad_alloc when internal RAM runs short (see the
    // esp32_camera notes in bird-cam.yaml). `largestFreeInternal` is the more
    // honest number of the two — a fragmented heap can show plenty free and
    // still fail a 40KB snapshot allocation.
    freeInternal: v.number(),
    largestFreeInternal: v.number(),
    freePsram: v.number(),
    loopTime: v.number(),
    temperature: v.number(),
    // Inferences since boot. Divided by uptime this gives the real achieved
    // inference rate, which is capped by the camera's idle_framerate (1fps),
    // not by the model.
    inferences: v.number(),
    // What the device believes its own settings are, echoed every beat. The UI
    // renders THIS, not the desired config, so a control always shows what the
    // hardware is actually doing.
    reported: v.object(deviceSettings),
    // Config generation the device has applied. When this lags deviceConfig.rev
    // the beacon response carries the new values down.
    appliedRev: v.number(),
  }).index("by_device", ["device"]),

  // Desired settings, one row per device. Kept separate from deviceStatus so a
  // beacon write (every 10s) never races a user edit (rare) on the same doc.
  //
  // `rev` is what stops the cloud from stomping on local changes. The device
  // applies the payload only when rev differs from what it last applied, so a
  // slider moved on the device's own page or in Home Assistant sticks until
  // someone deliberately changes it here.
  deviceConfig: defineTable({
    device: v.string(),
    rev: v.number(),
    updatedAt: v.number(),
    settings: v.object(deviceSettings),
  }).index("by_device", ["device"]),

  // One row per user-initiated command, claimed by the next beacon.
  //
  // A table rather than a flag on deviceConfig so that pressing a button twice
  // queues two actions instead of silently collapsing into one, and so the UI
  // can show a command as sent-but-not-yet-collected during the ≤10s window
  // before the device picks it up.
  deviceCommands: defineTable({
    device: v.string(),
    kind: v.union(v.literal("trigger"), v.literal("restart")),
    status: v.union(v.literal("pending"), v.literal("claimed")),
    createdAt: v.number(),
    claimedAt: v.optional(v.number()),
  }).index("by_device_status", ["device", "status", "createdAt"]),

  // --- Outbound webhook -------------------------------------------------------
  //
  // A single generic POST target, on the assumption that whatever receives it
  // (n8n, Zapier, a script) is the router. That is why there is one URL and no
  // filtering here beyond which events fire: the payload carries confidence,
  // species and device, and deciding what to do with a 42%-confidence sparrow
  // is the relay's job, not this table's.
  //
  // Singleton by convention — `save` patches the first row rather than
  // inserting. A table rather than an env var because it has to be editable
  // from the UI without a redeploy.
  webhook: defineTable({
    enabled: v.boolean(),
    url: v.string(),
    // Sent as X-Manu-Secret so the receiver can reject anything that did not
    // come from here. Write-only: never returned to the client.
    secret: v.optional(v.string()),
    // Which moments fire. Both are useful and mean different things: a
    // detection is immediate but knows nothing about species and has no photo
    // yet, while the species event lands seconds later with both.
    onDetection: v.boolean(),
    onSpeciesIdentified: v.boolean(),
    // Last delivery outcome, so the UI can show whether the endpoint is
    // actually reachable. Wiring up a relay is otherwise pure guesswork.
    lastStatus: v.optional(v.number()),
    lastAt: v.optional(v.number()),
    lastError: v.optional(v.string()),
    lastEvent: v.optional(v.string()),
    updatedAt: v.number(),
  }),

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
