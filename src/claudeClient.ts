import { type EpisodeData, type GeneratedPost } from './types.js';
import { SYSTEM_PROMPT } from './systemPrompt.js';

const GEMINI_MODEL = 'gemini-2.0-flash';
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * Call the Gemini API to generate an episode discussion post.
 * Returns a parsed { title, body } object ready for Reddit submission.
 */
export async function generateEpisodePost(
  apiKey: string,
  episode: EpisodeData
): Promise<GeneratedPost> {
  const userMessage = buildUserMessage(episode);
  const url = `${GEMINI_API_BASE}/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: {
        parts: [{ text: SYSTEM_PROMPT }],
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
 * The system prompt instructs the model to put the title on the first line
 * in the format: [Episode Discussion] {episode_title}
 * The body follows after a blank line separator.
 */
function parseGeneratedResponse(fullText: string, fallbackTitle: string): GeneratedPost {
  const lines = fullText.split('\n');

  // Find the first non-empty line — that's the title
  const titleLineIndex = lines.findIndex((l) => l.trim().length > 0);
  if (titleLineIndex === -1) {
    // Completely empty response — shouldn't happen, but be defensive
    return {
      title: `[Episode Discussion] ${fallbackTitle}`,
      body: fullText.trim(),
    };
  }

  const rawTitleLine = lines[titleLineIndex].trim();

  // Normalise: ensure it starts with "[Episode Discussion]"
  const episodeDiscussionPrefix = '[Episode Discussion]';
  let title: string;
  if (rawTitleLine.toLowerCase().startsWith('[episode discussion]')) {
    title = rawTitleLine;
  } else {
    title = `${episodeDiscussionPrefix} ${rawTitleLine}`;
  }

  // Everything after the title line is the body
  const body = lines
    .slice(titleLineIndex + 1)
    .join('\n')
    .trim();

  return { title, body };
}

/**
 * Build the user message containing episode metadata.
 */
function buildUserMessage(episode: EpisodeData): string {
  const parts: string[] = [
    'New episode released. Please generate the full discussion post following your post structure instructions.',
    '',
    `**Episode Title:** ${episode.title}`,
  ];

  if (episode.episodeNumber) {
    parts.push(`**Episode Number:** ${episode.episodeNumber}`);
  }

  parts.push(`**Published:** ${episode.pubDate}`);

  if (episode.link) {
    parts.push(`**Episode Link:** ${episode.link}`);
  }

  parts.push('', '**Episode Description:**', episode.description || '(No description available)');

  return parts.join('\n');
}
