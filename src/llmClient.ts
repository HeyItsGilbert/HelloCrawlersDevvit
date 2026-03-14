import { type EpisodeData, type GeneratedPost } from './types.js';
import { buildUserMessage, parseGeneratedResponse, applyPlaceholders } from './postUtils.js';

// Uses the OpenAI-compatible endpoint to avoid colon-in-path URLs like
// `:generateContent`, which Devvit's HTTP proxy misinterprets as gRPC routing.
const GEMINI_OPENAI_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';

/**
 * Call the Gemini API to generate a post from video metadata.
 * Uses the OpenAI-compatible endpoint so the URL has no colon-prefixed
 * method segment, which is required for Devvit's HTTP proxy.
 */
export async function generateEpisodePost(
  apiKey: string,
  episode: EpisodeData,
  systemPrompt: string,
  geminiModel: string
): Promise<GeneratedPost> {
  const resolvedSystemPrompt = applyPlaceholders(systemPrompt, episode);
  const userMessage = buildUserMessage(episode);

  console.log(`[llmClient] POST ${GEMINI_OPENAI_URL} (model: ${geminiModel})`);
  console.log(`[llmClient] System prompt: ${resolvedSystemPrompt.length} chars, user message: ${userMessage.length} chars`);

  const response = await fetch(GEMINI_OPENAI_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: geminiModel,
      messages: [
        { role: 'system', content: resolvedSystemPrompt },
        { role: 'user', content: userMessage },
      ],
      max_tokens: 4096,
    }),
  });

  console.log(`[llmClient] Response status: ${response.status}`);

  if (!response.ok) {
    const errText = await response.text().catch(() => '(unreadable)');
    console.error(`[llmClient] Error response: ${errText.slice(0, 500)}`);
    throw new Error(`Gemini API error ${response.status}: ${errText}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{
      message: { content: string };
      finish_reason: string;
    }>;
  };

  const choice = data.choices?.[0];
  const fullText = choice?.message?.content ?? '';
  const finishReason = choice?.finish_reason ?? 'unknown';

  console.log(`[llmClient] finish_reason: ${finishReason}, response length: ${fullText.length} chars`);
  if (finishReason === 'length') {
    console.warn('[llmClient] Response was cut off by max_tokens limit — consider raising it or shortening the system prompt.');
  }

  if (!fullText) {
    console.error(`[llmClient] Empty response. Raw: ${JSON.stringify(data).slice(0, 500)}`);
    throw new Error('Gemini returned an empty response');
  }

  return parseGeneratedResponse(fullText, episode.title);
}

