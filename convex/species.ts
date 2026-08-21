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
  "note": string|null          // under 10 words on distinguishing features, or why you're unsure
}

If the image does not clearly show a bird at all, set commonName to "Unknown bird" and confidence to 0.

Only show birds that are native to New Zealand in your response as this the location of the camera.`;

// Some models (or a too-small max_tokens) truncate before the closing
// brace. Try a full JSON.parse first; if that fails, pull fields out
// individually so a truncated-but-otherwise-good answer isn't thrown away.
function extractSpeciesFields(text: string): {
  commonName: string;
  scientificName?: string;
  confidence?: number;
} | null {
  const objMatch = text.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try {
      const parsed = JSON.parse(objMatch[0]);
      if (typeof parsed.commonName === "string") return parsed;
    } catch {
      // fall through to field-by-field extraction below
    }
  }
  const commonName = text.match(/"commonName"\s*:\s*"([^"]*)"/)?.[1];
  if (!commonName) return null;
  const scientificName = text.match(/"scientificName"\s*:\s*"([^"]*)"/)?.[1];
  const confidenceStr = text.match(/"confidence"\s*:\s*([0-9.]+)/)?.[1];
  return {
    commonName,
    scientificName,
    confidence: confidenceStr ? Number(confidenceStr) : undefined,
  };
}

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
          "HTTP-Referer": "https://manu.thoughtlabs.co.nz",
          "X-Title": "Manu bird camera",
        },
        body: JSON.stringify({
          model,
          temperature: 0.1,
          max_tokens: 500,
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
      const parsed = extractSpeciesFields(text);

      // Record spend BEFORE the parse can throw: OpenRouter bills for the call
      // whether or not we could read the answer, so accounting must not depend
      // on our parser succeeding. Cost is returned automatically in
      // `usage.cost` (USD actually charged) — the `usage: {include: true}`
      // parameter is deprecated and has no effect.
      const usage = data.usage ?? {};
      const cost = typeof usage.cost === "number" ? usage.cost : 0;
      await ctx.runMutation(internal.species.recordUsage, {
        detectionId,
        // Read the model from the RESPONSE, not the request: it reflects what
        // actually served the call.
        model: typeof data.model === "string" ? data.model : model,
        promptTokens: usage.prompt_tokens ?? 0,
        completionTokens: usage.completion_tokens ?? 0,
        totalTokens: usage.total_tokens ?? 0,
        cost,
        status: parsed ? "done" : "failed",
      });

      if (!parsed) throw new Error(`no usable species data in model response: ${text}`);

      await ctx.runMutation(internal.species.recordResult, {
        detectionId,
        status: "done",
        cost,
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
    cost: v.optional(v.number()),
  },
  handler: async (ctx, { detectionId, status, commonName, scientificName, confidence, cost }) => {
    const existing = await ctx.db.get(detectionId);
    if (!existing) return; // detection could theoretically be gone by the time this lands
    await ctx.db.patch(detectionId, {
      speciesStatus: status,
      ...(commonName !== undefined ? { speciesCommonName: commonName } : {}),
      ...(scientificName !== undefined ? { speciesScientificName: scientificName } : {}),
      ...(confidence !== undefined ? { speciesConfidence: confidence } : {}),
      ...(cost !== undefined ? { speciesCost: cost } : {}),
    });
  },
});

// One row per OpenRouter call, including calls that were billed but returned
// nothing usable. Kept separate from the detection so cost history survives the
// sighting being deleted.
export const recordUsage = internalMutation({
  args: {
    detectionId: v.optional(v.id("detections")),
    model: v.string(),
    promptTokens: v.number(),
    completionTokens: v.number(),
    totalTokens: v.number(),
    cost: v.number(),
    status: v.union(v.literal("done"), v.literal("failed")),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("llmUsage", { ...args, createdAt: Date.now() });
  },
});
