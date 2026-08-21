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
  if (request.headers.get("Authorization") !== `Bearer ${expected}`) {
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

export default http;
