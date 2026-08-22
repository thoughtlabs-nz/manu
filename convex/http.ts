import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";

// The ESPHome device sends `Authorization: Bearer <token>`; the token must
// match the DETECTION_API_KEY env var (npx convex env set DETECTION_API_KEY ...).
function unauthorized(request: Request): Response | null {
  const expected = process.env.DETECTION_API_KEY;
  if (!expected) {
    return new Response("DETECTION_API_KEY not configured", { status: 500 });
  }
  // Compare bare tokens. DETECTION_API_KEY has been set both ways in practice
  // ("<token>" and "Bearer <token>"); the latter used to fail every request
  // with a 401 that looked like a wrong key, because the check built
  // "Bearer Bearer <token>". Tolerate the prefix on either side instead.
  const strip = (v: string) => v.replace(/^Bearer\s+/i, "").trim();
  const provided = request.headers.get("Authorization");
  if (!provided || strip(provided) !== strip(expected)) {
    return new Response("Unauthorized", { status: 401 });
  }
  return null;
}

const http = httpRouter();

// POST /detections  { device, species, confidence, object_count, ts }
http.route({
  path: "/detections",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const denied = unauthorized(request);
    if (denied) return denied;

    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    const device = body["device"];
    const species = body["species"];
    const confidence = body["confidence"];
    if (
      typeof device !== "string" ||
      typeof species !== "string" ||
      typeof confidence !== "number"
    ) {
      return new Response("Missing device/species/confidence", { status: 400 });
    }

    const id = await ctx.runMutation(internal.detections.ingest, {
      device,
      species,
      confidence,
      objectCount:
        typeof body["object_count"] === "number" ? body["object_count"] : 1,
      deviceTs: typeof body["ts"] === "number" ? body["ts"] : 0,
    });

    return Response.json({ ok: true, id });
  }),
});

// POST /snapshots
//
// Two body formats are accepted:
//
//  1. Raw JPEG  (Content-Type: image/jpeg) — what the ESP32 sends.
//     Metadata rides in headers: X-Device, X-Timestamp (epoch seconds).
//     ESPHome hardcodes a 5120-byte cap on JSON serialization
//     (esphome/components/json/json_util.cpp), so a base64 JPEG can NEVER
//     fit in a JSON body — it silently truncates and this route 400s. Raw
//     bytes also avoid base64's 33% overhead on a constrained uplink.
//
//  2. JSON { device, ts, image_b64 } — kept for curl/manual testing.
//
// `X-Capture: 1` diverts the frame to the `captures` table instead: raw
// unlabelled training data, never linked to a detection and never sent to the
// (paid) species-ID pass. It reuses this route rather than adding /captures so
// no new secret URL is needed on every builder — the ESPHome secrets file on
// the Home Assistant side is not always reachable.
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;

http.route({
  path: "/snapshots",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const denied = unauthorized(request);
    if (denied) return denied;

    const contentType = request.headers.get("Content-Type") ?? "";
    const isBinary =
      contentType.startsWith("image/jpeg") ||
      contentType.startsWith("application/octet-stream");

    let device: string;
    let deviceTs: number;
    let buffer: ArrayBuffer;

    if (isBinary) {
      const url = new URL(request.url);
      device =
        request.headers.get("X-Device") ?? url.searchParams.get("device") ?? "";
      const rawTs =
        request.headers.get("X-Timestamp") ?? url.searchParams.get("ts") ?? "";
      deviceTs = Number.parseInt(rawTs, 10);
      if (!Number.isFinite(deviceTs)) deviceTs = 0;

      if (!device) {
        return new Response("Missing X-Device", { status: 400 });
      }

      buffer = await request.arrayBuffer();
      if (buffer.byteLength === 0) {
        return new Response("Empty image body", { status: 400 });
      }
      if (buffer.byteLength > MAX_SNAPSHOT_BYTES) {
        return new Response("Image too large", { status: 413 });
      }
    } else {
      let body: Record<string, unknown>;
      try {
        body = await request.json();
      } catch {
        return new Response("Invalid JSON", { status: 400 });
      }

      const d = body["device"];
      const imageB64 = body["image_b64"];
      if (typeof d !== "string" || typeof imageB64 !== "string") {
        return new Response("Missing device/image_b64", { status: 400 });
      }
      device = d;
      deviceTs = typeof body["ts"] === "number" ? body["ts"] : 0;

      try {
        const binary = atob(imageB64);
        buffer = new ArrayBuffer(binary.length);
        const bytes = new Uint8Array(buffer);
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }
      } catch {
        return new Response("Invalid base64", { status: 400 });
      }
    }

    // A truncated JPEG still stores fine but is useless to the species-ID
    // pass, so reject anything that isn't a plausible JPEG up front.
    const head = new Uint8Array(buffer.slice(0, 2));
    if (head[0] !== 0xff || head[1] !== 0xd8) {
      return new Response("Body is not a JPEG (missing SOI marker)", {
        status: 400,
      });
    }

    const storageId = await ctx.storage.store(
      new Blob([buffer], { type: "image/jpeg" })
    );

    if (request.headers.get("X-Capture") === "1") {
      try {
        const id = await ctx.runMutation(internal.captures.ingest, {
          device,
          deviceTs,
          storageId,
          bytes: buffer.byteLength,
        });
        return Response.json({ ok: true, capture: true, id });
      } catch (err) {
        // Storage already holds the blob; drop it so a refused capture does
        // not leak an orphaned file.
        await ctx.storage.delete(storageId);
        return new Response(
          err instanceof Error ? err.message : "Capture rejected",
          { status: 507 }
        );
      }
    }

    const id = await ctx.runMutation(internal.snapshots.ingest, {
      device,
      deviceTs,
      storageId,
    });

    return Response.json({ ok: true, id, bytes: buffer.byteLength });
  }),
});

// POST /beacon
//
// The device's 10-second heartbeat, and the ONLY way anything reaches the
// camera. It sits behind NAT on a home LAN with no inbound path, so Convex can
// never call it; instead the device asks, every 10s, and the answer rides back
// in this response. Stats go up, commands and config come down, one request.
//
// Request:  { device, ts, uptime, rssi, free_internal, largest_free_internal,
//             free_psram, loop_time, temperature, inferences, config_rev,
//             settings: {...} }
// Response: { ok, commands: ["trigger"], config_rev, config: {...} | null }
//
// The response MUST stay small: ESPHome buffers it into a fixed
// max_response_buffer_size (2kB in bird-cam.yaml) and silently truncates past
// it, which would surface as a JSON parse failure on the device rather than an
// error here. `config` is null on a steady-state beat for exactly this reason.
function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function bool(v: unknown): boolean {
  return v === true;
}

http.route({
  path: "/beacon",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const denied = unauthorized(request);
    if (denied) return denied;

    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    const device = body["device"];
    if (typeof device !== "string" || !device) {
      return new Response("Missing device", { status: 400 });
    }

    const s = (body["settings"] ?? {}) as Record<string, unknown>;

    // Coerced rather than validated: a beacon is telemetry, and dropping a
    // whole beat because one sensor has not published yet (they read NaN
    // before their first update) would blind the UI for no good reason.
    const result = await ctx.runMutation(internal.devices.beacon, {
      device,
      deviceTs: num(body["ts"]),
      uptime: num(body["uptime"]),
      rssi: num(body["rssi"]),
      freeInternal: num(body["free_internal"]),
      largestFreeInternal: num(body["largest_free_internal"]),
      freePsram: num(body["free_psram"]),
      loopTime: num(body["loop_time"]),
      temperature: num(body["temperature"]),
      inferences: num(body["inferences"]),
      appliedRev: num(body["config_rev"]),
      reported: {
        minConfidence: num(s["min_confidence"]),
        detectionEnabled: bool(s["detection_enabled"]),
        snapshotUploads: bool(s["snapshot_uploads"]),
        captureMode: bool(s["capture_mode"]),
        captureInterval: num(s["capture_interval"]),
        brightness: num(s["brightness"]),
        contrast: num(s["contrast"]),
        saturation: num(s["saturation"]),
        aeLevel: num(s["ae_level"]),
      },
    });

    return Response.json({
      ok: true,
      commands: result.commands,
      config_rev: result.configRev,
      // snake_case on the wire to match the keys the device sends up, so the
      // ESPHome lambda reads one naming convention throughout.
      config: result.config
        ? {
            min_confidence: result.config.minConfidence,
            detection_enabled: result.config.detectionEnabled,
            snapshot_uploads: result.config.snapshotUploads,
            capture_mode: result.config.captureMode,
            capture_interval: result.config.captureInterval,
            brightness: result.config.brightness,
            contrast: result.config.contrast,
            saturation: result.config.saturation,
            ae_level: result.config.aeLevel,
          }
        : null,
    });
  }),
});

export default http;
