import { internalMutation, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { deviceSettings } from "./schema";

// A device is considered online if a beacon landed within this window. Three
// beats, not one: a single dropped POST (wifi hiccup, Convex cold start) is
// routine and should not flap the indicator.
const ONLINE_WINDOW_MS = 35_000;

// Claimed commands are kept briefly so the UI can show what was just sent,
// then reaped by the next beacon. Without the sweep this table grows forever.
const COMMAND_TTL_MS = 10 * 60_000;

const settingsValidator = v.object(deviceSettings);

// --- The beacon -------------------------------------------------------------
//
// Called once per beat by the /beacon HTTP route. Does three things in one
// transaction, which is the whole point of the design: records what the device
// reported, hands back any command queued since the last beat, and hands back
// the desired config if the device has not yet applied the current revision.
export const beacon = internalMutation({
  args: {
    device: v.string(),
    deviceTs: v.number(),
    uptime: v.number(),
    rssi: v.number(),
    freeInternal: v.number(),
    largestFreeInternal: v.number(),
    freePsram: v.number(),
    loopTime: v.number(),
    temperature: v.number(),
    inferences: v.number(),
    appliedRev: v.number(),
    reported: settingsValidator,
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const { device } = args;

    const existing = await ctx.db
      .query("deviceStatus")
      .withIndex("by_device", (q) => q.eq("device", device))
      .unique();

    const status = { ...args, receivedAt: now };
    if (existing) {
      await ctx.db.patch(existing._id, status);
    } else {
      await ctx.db.insert("deviceStatus", status);
    }

    // --- Config --------------------------------------------------------------
    // A device that has never been seen seeds its own config row from what it
    // reported. The alternative — inventing defaults server-side — would push a
    // configuration change at every new camera the first time it phoned home,
    // silently overwriting settings that were tuned on the device itself.
    let config = await ctx.db
      .query("deviceConfig")
      .withIndex("by_device", (q) => q.eq("device", device))
      .unique();

    if (!config) {
      const id = await ctx.db.insert("deviceConfig", {
        device,
        rev: 1,
        updatedAt: now,
        settings: args.reported,
      });
      config = (await ctx.db.get(id))!;
    }

    // --- Commands ------------------------------------------------------------
    const pending = await ctx.db
      .query("deviceCommands")
      .withIndex("by_device_status", (q) =>
        q.eq("device", device).eq("status", "pending")
      )
      .take(8);

    for (const cmd of pending) {
      await ctx.db.patch(cmd._id, { status: "claimed", claimedAt: now });
    }

    // Sweep old claimed commands. Piggybacked on the beacon rather than run as
    // a cron so it costs nothing extra and only runs for devices that are live.
    const claimed = await ctx.db
      .query("deviceCommands")
      .withIndex("by_device_status", (q) =>
        q.eq("device", device).eq("status", "claimed")
      )
      .take(50);
    for (const cmd of claimed) {
      if (now - cmd.createdAt > COMMAND_TTL_MS) await ctx.db.delete(cmd._id);
    }

    return {
      commands: pending.map((c) => c.kind),
      configRev: config.rev,
      // Only ship the payload when the device is actually behind. On a steady
      // state beat this keeps the response down to a few dozen bytes.
      config: args.appliedRev === config.rev ? null : config.settings,
    };
  },
});

// --- Queries for the UI -----------------------------------------------------

export const list = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("deviceStatus").collect();
    const now = Date.now();

    return await Promise.all(
      rows
        .sort((a, b) => a.device.localeCompare(b.device))
        .map(async (s) => {
          const config = await ctx.db
            .query("deviceConfig")
            .withIndex("by_device", (q) => q.eq("device", s.device))
            .unique();

          const inFlight = await ctx.db
            .query("deviceCommands")
            .withIndex("by_device_status", (q) =>
              q.eq("device", s.device).eq("status", "pending")
            )
            .take(8);

          return {
            ...s,
            online: now - s.receivedAt < ONLINE_WINDOW_MS,
            // True while a config change has been made but not yet collected.
            configPending: config ? config.rev !== s.appliedRev : false,
            desired: config?.settings ?? s.reported,
            queuedCommands: inFlight.map((c) => c.kind),
          };
        })
    );
  },
});

// --- Control ----------------------------------------------------------------

export const sendCommand = mutation({
  args: {
    device: v.string(),
    kind: v.union(v.literal("trigger"), v.literal("restart")),
  },
  handler: async (ctx, { device, kind }) => {
    // Collapse a repeated press that has not been collected yet. Queueing five
    // restarts because someone clicked five times is never what was meant.
    const already = await ctx.db
      .query("deviceCommands")
      .withIndex("by_device_status", (q) =>
        q.eq("device", device).eq("status", "pending")
      )
      .take(8);
    if (already.some((c) => c.kind === kind)) return null;

    return await ctx.db.insert("deviceCommands", {
      device,
      kind,
      status: "pending",
      createdAt: Date.now(),
    });
  },
});

// Patch one or more settings and bump the revision, which is what makes the
// next beacon carry them down to the device.
export const updateConfig = mutation({
  args: {
    device: v.string(),
    // Every field optional: the UI sends only the control that moved, so two
    // people editing different settings cannot clobber each other's value.
    settings: v.object({
      minConfidence: v.optional(v.number()),
      detectionEnabled: v.optional(v.boolean()),
      snapshotUploads: v.optional(v.boolean()),
      captureMode: v.optional(v.boolean()),
      captureInterval: v.optional(v.number()),
      brightness: v.optional(v.number()),
      contrast: v.optional(v.number()),
      saturation: v.optional(v.number()),
      aeLevel: v.optional(v.number()),
    }),
  },
  handler: async (ctx, { device, settings }) => {
    const config = await ctx.db
      .query("deviceConfig")
      .withIndex("by_device", (q) => q.eq("device", device))
      .unique();

    // No row yet means the device has never beaconed, so there is nothing
    // trustworthy to merge into — the seed on first contact owns that.
    if (!config) throw new Error(`No config for ${device} yet — wait for its first beacon`);

    const next = { ...config.settings };
    for (const [key, value] of Object.entries(settings)) {
      if (value !== undefined) (next as Record<string, unknown>)[key] = value;
    }

    await ctx.db.patch(config._id, {
      settings: next,
      rev: config.rev + 1,
      updatedAt: Date.now(),
    });
  },
});
