/**
 * Universal LLM factory — works with any OpenAI-compatible endpoint.
 *
 * Priority order:
 *   1. LLM_BASE_URL  → any OpenAI-compatible server (Ollama, OpenRouter,
 *                       LM Studio, Jan, vLLM, Together, Groq, …)
 *   2. ANTHROPIC_API_KEY → Anthropic Claude (native SDK)
 *   3. OPENAI_API_KEY    → OpenAI GPT (no base URL override)
 *   4. fallback          → echo mode (useful for testing without any key)
 *
 * Env vars:
 *   LLM_BASE_URL   Base URL for OpenAI-compatible API.
 *                  Ollama:      http://localhost:11434/v1
 *                  LM Studio:   http://localhost:1234/v1
 *                  OpenRouter:  https://openrouter.ai/api/v1
 *                  Groq:        https://api.groq.com/openai/v1
 *   LLM_API_KEY    API key for the above (use "ollama" for Ollama, real key for others).
 *                  Defaults to OPENAI_API_KEY if not set.
 *   SOLVER_MODEL / EVALUATOR_MODEL / POSTER_MODEL
 *                  Override the model name per role.
 *   DEFAULT_MODEL  Override when no role-specific model var is set.
 *                  Ollama default:     llama3
 *                  OpenAI default:     gpt-4o-mini
 *                  Anthropic default:  claude-3-5-haiku-20241022
 *
 * Usage:
 *   import { createLLM } from "../sdk/llm.mjs";
 *   const llm = await createLLM({ role: "solver", maxTokens: 2048 });
 *   const answer = await llm(systemPrompt, userPrompt);
 */

export async function createLLM({ role = "agent", maxTokens = 2048, label = role } = {}) {
  const roleModelVar = `${role.toUpperCase()}_MODEL`;
  const modelEnv = process.env[roleModelVar] ?? process.env.DEFAULT_MODEL;

  // ── Path 1: Any OpenAI-compatible endpoint via LLM_BASE_URL ─────────────
  if (process.env.LLM_BASE_URL) {
    const { default: OpenAI } = await import("openai");
    const baseURL = process.env.LLM_BASE_URL.replace(/\/$/, "");
    const apiKey = process.env.LLM_API_KEY ?? process.env.OPENAI_API_KEY ?? "ollama";
    const model = modelEnv ?? defaultModelForBaseUrl(baseURL);

    console.log(`[${label}] LLM: ${baseURL} model=${model}`);

    const client = new OpenAI({ baseURL, apiKey });
    return async (systemPrompt, userPrompt) => {
      const res = await client.chat.completions.create({
        model,
        max_tokens: maxTokens,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ]
      });
      return res.choices[0].message.content;
    };
  }

  // ── Path 2: Anthropic Claude ────────────────────────────────────────────
  if (process.env.ANTHROPIC_API_KEY) {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const model = modelEnv ?? "claude-3-5-haiku-20241022";
    console.log(`[${label}] LLM: Anthropic ${model}`);
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    return async (systemPrompt, userPrompt) => {
      const msg = await client.messages.create({
        model,
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }]
      });
      return msg.content[0].text;
    };
  }

  // ── Path 3: OpenAI ───────────────────────────────────────────────────────
  if (process.env.OPENAI_API_KEY) {
    const { default: OpenAI } = await import("openai");
    const model = modelEnv ?? "gpt-4o-mini";
    console.log(`[${label}] LLM: OpenAI ${model}`);
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    return async (systemPrompt, userPrompt) => {
      const res = await client.chat.completions.create({
        model,
        max_tokens: maxTokens,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ]
      });
      return res.choices[0].message.content;
    };
  }

  // ── Path 4: Echo fallback (no key configured) ────────────────────────────
  console.warn(
    `[${label}] ⚠️  No LLM configured. Set one of:\n` +
    `  LLM_BASE_URL=http://localhost:11434/v1  (Ollama — free, local)\n` +
    `  ANTHROPIC_API_KEY=sk-ant-...            (Claude)\n` +
    `  OPENAI_API_KEY=sk-...                   (GPT / OpenRouter)\n` +
    `  Running in echo mode.`
  );
  return async (_sys, userPrompt) => `[echo — no LLM configured] ${userPrompt}`;
}

// Pick a sensible default model based on the base URL.
function defaultModelForBaseUrl(baseURL) {
  if (baseURL.includes("openrouter.ai")) return "openai/gpt-4o-mini";
  if (baseURL.includes("groq.com")) return "llama-3.1-8b-instant";
  if (baseURL.includes("together.xyz")) return "meta-llama/Llama-3-8b-chat-hf";
  if (baseURL.includes("localhost:11434")) return "llama3";   // Ollama
  if (baseURL.includes("localhost:1234")) return "local-model"; // LM Studio
  return "gpt-4o-mini"; // safe default for unknown endpoints
}
