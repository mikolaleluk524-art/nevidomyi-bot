/**
 * Спільний виклик ШІ для помічника й реклами: повертає JSON за схемою.
 *
 * Порядок: Claude (ANTHROPIC_API_KEY) → Gemini від Google (GEMINI_API_KEY, є безкоштовний ліміт)
 * → помилка, і тоді викликач бере готові шаблони.
 */

import Anthropic from "@anthropic-ai/sdk";

const CLAUDE_MODEL = "claude-opus-5-5";
// Безкоштовні моделі Gemini: перша, що відповість. GEMINI_MODEL у Railway — щоб вказати свою.
const GEMINI_MODELS = [process.env.GEMINI_MODEL, "gemini-flash-latest", "gemini-2.5-flash"].filter(Boolean);
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/";

export const aiProvider = () => (process.env.ANTHROPIC_API_KEY ? "claude" : process.env.GEMINI_API_KEY ? "gemini" : null);
export const aiEnabled = () => aiProvider() !== null;

async function askClaude(prompt, schema, maxTokens) {
  const client = new Anthropic();
  const request = {
    model: CLAUDE_MODEL,
    max_tokens: maxTokens,
    output_config: { effort: "low", format: { type: "json_schema", schema } },
    messages: [{ role: "user", content: prompt }],
  };
  let response;
  try {
    // Якщо модель відмовить, сервер сам спробує запасну модель.
    response = await client.beta.messages.create({ ...request, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" });
  } catch (err) {
    if (!(err instanceof Anthropic.BadRequestError)) throw err;
    response = await client.messages.create(request);
  }
  if (response.stop_reason === "refusal") throw new Error("refusal");
  return JSON.parse(response.content.find((b) => b.type === "text")?.text ?? "");
}

// Gemini інколи загортає JSON у ```json … ``` — знімаємо обгортку.
function parseLoose(text) {
  const t = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  return JSON.parse(t);
}

async function geminiCall(model, prompt, schema, maxTokens, withSchema) {
  const generationConfig = { responseMimeType: "application/json", maxOutputTokens: maxTokens, temperature: 0.9 };
  if (withSchema) generationConfig.responseJsonSchema = schema;
  const res = await fetch(`${GEMINI_URL}${model}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt + "\n\nВідповідай лише JSON за цією схемою:\n" + JSON.stringify(schema) }] }],
      generationConfig,
    }),
    signal: AbortSignal.timeout(60000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`Gemini ${res.status}: ${body?.error?.message || res.statusText}`);
    err.status = res.status;
    throw err;
  }
  const cand = body.candidates?.[0];
  const text = (cand?.content?.parts || []).map((p) => p.text || "").join("");
  if (!text) throw new Error(`Gemini: порожня відповідь (${cand?.finishReason || body.promptFeedback?.blockReason || "?"})`);
  return parseLoose(text);
}

async function askGemini(prompt, schema, maxTokens) {
  let last;
  for (const model of GEMINI_MODELS) {
    for (const withSchema of [true, false]) {
      try {
        return await geminiCall(model, prompt, schema, maxTokens, withSchema);
      } catch (err) {
        last = err;
        if (err.status === 401 || err.status === 403) throw new Error("ключ GEMINI_API_KEY не підходить");
        if (err.status === 429) throw new Error("Gemini: вичерпано безкоштовний ліміт, спробуй пізніше");
        if (err.status === 404) break; // такої моделі немає — пробуємо наступну
        // 400 зі схемою — повторюємо без схеми; інші помилки — теж ще одна спроба
      }
    }
  }
  throw last;
}

/** Повертає { source: "claude" | "gemini", data } або кидає помилку. */
export async function askJSON(prompt, schema, maxTokens = 4000) {
  const provider = aiProvider();
  if (provider === "claude") return { source: "claude", data: await askClaude(prompt, schema, maxTokens) };
  if (provider === "gemini") return { source: "gemini", data: await askGemini(prompt, schema, maxTokens) };
  throw new Error("немає ключа ШІ");
}

export function logAIError(where, err) {
  if (err instanceof Anthropic.AuthenticationError) console.error(`[${where}] ключ ANTHROPIC_API_KEY не підходить`);
  else if (err instanceof Anthropic.RateLimitError) console.error(`[${where}] ліміт запитів Claude, беру шаблони`);
  else if (err instanceof Anthropic.APIConnectionError) console.error(`[${where}] немає з'єднання з Claude, беру шаблони`);
  else if (err instanceof Anthropic.APIError) console.error(`[${where}] Claude API ${err.status}: ${err.message}`);
  else console.error(`[${where}]`, err.message);
}
