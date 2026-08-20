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

// POST /snapshots  { device, ts, image_b64 }  (JPEG, base64)
http.route({
  path: "/snapshots",
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
    const imageB64 = body["image_b64"];
    if (typeof device !== "string" || typeof imageB64 !== "string") {
      return new Response("Missing device/image_b64", { status: 400 });
    }

    let buffer: ArrayBuffer;
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

    const storageId = await ctx.storage.store(
      new Blob([buffer], { type: "image/jpeg" })
    );

    const id = await ctx.runMutation(internal.snapshots.ingest, {
      device,
      deviceTs: typeof body["ts"] === "number" ? body["ts"] : 0,
      storageId,
    });

    return Response.json({ ok: true, id });
  }),
});

export default http;
