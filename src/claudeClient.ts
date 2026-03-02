import { type EpisodeData, type GeneratedPost } from './types.js';

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * Call the Gemini API to generate a post from video metadata.
 * The system prompt and model are supplied by the caller (from app settings).
 * Returns a parsed { title, body } object ready for Reddit submission.
 */
export async function generateEpisodePost(
  apiKey: string,
  episode: EpisodeData,
  systemPrompt: string,
  geminiModel: string
): Promise<GeneratedPost> {
  const userMessage = buildUserMessage(episode);
  const url = `${GEMINI_API_BASE}/${encodeURIComponent(geminiModel)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: {
        parts: [{ text: systemPrompt }],
      },
      contents: [
        {
          role: 'user',
          parts: [{ text: userMessage }],
        },
      ],
      generationConfig: {
        maxOutputTokens: 1024,
      },
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '(unreadable)');
    throw new Error(`Gemini API error ${response.status}: ${errText}`);
  }

  const data = (await response.json()) as {
    candidates?: Array<{
      content: { parts: Array<{ text: string }> };
    }>;
  };

  const fullText = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  if (!fullText) {
    throw new Error('Gemini returned an empty response');
  }

  return parseGeneratedResponse(fullText, episode.title);
}

/**
 * Split the generated response into a Reddit title and body.
 *
 * Convention: the first non-empty line of the Gemini output is used as the
 * post title. Everything after it becomes the body. The system prompt
 * supplied by the mod controls what format the title takes.
 */
function parseGeneratedResponse(fullText: string, fallbackTitle: string): GeneratedPost {
  const lines = fullText.split('\n');

  // Find the first non-empty line — that's the title
  const titleLineIndex = lines.findIndex((l) => l.trim().length > 0);
  if (titleLineIndex === -1) {
    return {
      title: fallbackTitle,
      body: fullText.trim(),
    };
  }

  const title = lines[titleLineIndex].trim();

  // Everything after the title line is the body
  const body = lines
    .slice(titleLineIndex + 1)
    .join('\n')
    .trim();

  return { title, body };
}

/**
 * Build the user message containing video metadata.
 */
function buildUserMessage(episode: EpisodeData): string {
  const parts: string[] = [
    'New video released. Please generate the full post following your instructions.',
    '',
    `**Title:** ${episode.title}`,
  ];

  if (episode.episodeNumber) {
    parts.push(`**Episode Number:** ${episode.episodeNumber}`);
  }

  parts.push(`**Published:** ${episode.pubDate}`);

  if (episode.link) {
    parts.push(`**Link:** ${episode.link}`);
  }

  parts.push('', '**Description:**', episode.description || '(No description available)');

  return parts.join('\n');
}
