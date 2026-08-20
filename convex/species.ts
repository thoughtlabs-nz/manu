import { v } from "convex/values";
import { internalAction, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";

// OpenRouter uses the OpenAI-compatible chat completions format, so any
// vision-capable model on OpenRouter works here. Override via the
// OPENROUTER_MODEL env var; this default is just a cheap, widely-available
// fallback.
const DEFAULT_MODEL = "openai/gpt-4o-mini";

const PROMPT = `You are identifying a bird species from a backyard camera-trap photo. The photo may be low-resolution, poorly lit, motion-blurred, or only partially show the bird.

Respond with ONLY a JSON object, no other text, no markdown fences:
{
  "commonName": string,        // best-guess common species name, or "Unknown bird" if you genuinely cannot tell
  "scientificName": string|null,
  "confidence": number,        // 0 to 1, your honest confidence in commonName
  "note": string|null          // one short clause on distinguishing features, or why you're unsure
}

If the image does not clearly show a bird at all, set commonName to "Unknown bird" and confidence to 0.`;

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export const identify = internalAction({
  args: { detectionId: v.id("detections"), storageId: v.id("_storage") },
  handler: async (ctx, { detectionId, storageId }) => {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      console.error("OPENROUTER_API_KEY not set; skipping species ID");
      await ctx.runMutation(internal.species.recordResult, {
        detectionId,
        status: "failed",
      });
      return;
    }

    const blob = await ctx.storage.get(storageId);
    if (!blob) {
      await ctx.runMutation(internal.species.recordResult, {
        detectionId,
        status: "failed",
      });
      return;
    }

    try {
      const imageB64 = await blobToBase64(blob);
      const model = process.env.OPENROUTER_MODEL ?? DEFAULT_MODEL;

      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          "HTTP-Referer": "https://manu-bird-cam.pages.dev",
          "X-Title": "Manu bird camera",
        },
        body: JSON.stringify({
          model,
          temperature: 0.2,
          max_tokens: 300,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: PROMPT },
                {
                  type: "image_url",
                  image_url: { url: `data:image/jpeg;base64,${imageB64}` },
                },
              ],
            },
          ],
        }),
      });

      if (!res.ok) {
        console.error("OpenRouter error", res.status, await res.text());
        await ctx.runMutation(internal.species.recordResult, {
          detectionId,
          status: "failed",
        });
        return;
      }

      const data = await res.json();
      const text: string = data.choices?.[0]?.message?.content ?? "";
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) throw new Error(`no JSON in model response: ${text}`);
      const parsed = JSON.parse(match[0]);

      await ctx.runMutation(internal.species.recordResult, {
        detectionId,
        status: "done",
        commonName:
          typeof parsed.commonName === "string" ? parsed.commonName : "Unknown bird",
        scientificName:
          typeof parsed.scientificName === "string" ? parsed.scientificName : undefined,
        confidence:
          typeof parsed.confidence === "number" ? parsed.confidence : undefined,
      });
    } catch (err) {
      console.error("species identify failed", err);
      await ctx.runMutation(internal.species.recordResult, {
        detectionId,
        status: "failed",
      });
    }
  },
});

export const recordResult = internalMutation({
  args: {
    detectionId: v.id("detections"),
    status: v.union(v.literal("done"), v.literal("failed")),
    commonName: v.optional(v.string()),
    scientificName: v.optional(v.string()),
    confidence: v.optional(v.number()),
  },
  handler: async (ctx, { detectionId, status, commonName, scientificName, confidence }) => {
    const existing = await ctx.db.get(detectionId);
    if (!existing) return; // detection could theoretically be gone by the time this lands
    await ctx.db.patch(detectionId, {
      speciesStatus: status,
      ...(commonName !== undefined ? { speciesCommonName: commonName } : {}),
      ...(scientificName !== undefined ? { speciesScientificName: scientificName } : {}),
      ...(confidence !== undefined ? { speciesConfidence: confidence } : {}),
    });
  },
});
