/**
 * Спільний виклик ШІ для помічника й реклами: повертає JSON за схемою.
 *
 * Порядок: Claude (ANTHROPIC_API_KEY) → Gemini від Google (GEMINI_API_KEY, є безкоштовний ліміт)
 * → помилка, і тоді викликач бере готові шаблони.
 */

import Anthropic from "@anthropic-ai/sdk";

const CLAUDE_MODEL = "claude-opus-5-5";
// Безкоштовні моделі Gemini: перша, що відповість. Легкі (lite) відповідають швидко й майже завжди,
// сильніші на безкоштовному плані часто перевантажені (503). GEMINI_MODEL у Railway — щоб поставити свою першою.
const GEMINI_MODELS = [...new Set([process.env.GEMINI_MODEL, "gemini-flash-lite-latest", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-flash-latest"].filter(Boolean))];
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
    signal: AbortSignal.timeout(30000),
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
  const errors = [];
  for (const model of GEMINI_MODELS) {
    for (const withSchema of [true, false]) {
      try {
        return await geminiCall(model, prompt, schema, maxTokens, withSchema);
      } catch (err) {
        errors.push(`${model}: ${err.message}`);
        if (err.status === 401 || err.status === 403) throw new Error("ключ GEMINI_API_KEY не підходить");
        // 400 зі схемою — повторюємо ту саму модель без схеми; решта (перевантаження, ліміт,
        // моделі немає, поганий JSON) — одразу наступна модель.
        if (!(withSchema && err.status === 400)) break;
      }
    }
  }
  throw new Error("Gemini не відповів:\n  " + errors.join("\n  "));
}

/**
 * Звичайна розмова (для 🤖 ШІ-співрозмовника): system — інструкція, history — [{ role: "user"|"model", text }].
 * Лише Gemini (безкоштовно). Повертає текст відповіді або кидає помилку.
 */
export async function chatReply(system, history, maxTokens = 400) {
  if (!process.env.GEMINI_API_KEY) throw new Error("немає ключа ШІ");
  const errors = [];
  for (const model of GEMINI_MODELS) {
    try {
      const res = await fetch(`${GEMINI_URL}${model}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: history.map((m) => ({ role: m.role === "model" ? "model" : "user", parts: [{ text: m.text }] })),
          generationConfig: { maxOutputTokens: maxTokens, temperature: 1 },
        }),
        signal: AbortSignal.timeout(20000),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        errors.push(`${model}: ${res.status} ${body?.error?.message || ""}`);
        if (res.status === 401 || res.status === 403) break;
        continue;
      }
      const text = (body.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("").trim();
      if (text) return text;
      errors.push(`${model}: порожня відповідь (${body.candidates?.[0]?.finishReason || body.promptFeedback?.blockReason || "?"})`);
    } catch (err) { errors.push(`${model}: ${err.message}`); }
  }
  throw new Error("Gemini не відповів: " + errors.join("; "));
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
