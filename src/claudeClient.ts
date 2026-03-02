import { type EpisodeData, type GeneratedPost } from './types.js';
import { SYSTEM_PROMPT } from './systemPrompt.js';

const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
// Use the model the user requested in the task description
const CLAUDE_MODEL = 'claude-sonnet-4-20250514';

/**
 * Call the Claude API to generate an episode discussion post.
 * Returns a parsed { title, body } object ready for Reddit submission.
 */
export async function generateEpisodePost(
  apiKey: string,
  episode: EpisodeData
): Promise<GeneratedPost> {
  const userMessage = buildUserMessage(episode);

  const response = await fetch(CLAUDE_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [
        { role: 'user', content: userMessage },
      ],
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '(unreadable)');
    throw new Error(`Claude API error ${response.status}: ${errText}`);
  }

  const data = (await response.json()) as {
    content: Array<{ type: string; text: string }>;
  };

  const fullText = data.content?.[0]?.text ?? '';
  if (!fullText) {
    throw new Error('Claude returned an empty response');
  }

  return parseClaudeResponse(fullText, episode.title);
}

/**
 * Split the Claude response into a Reddit title and body.
 *
 * The system prompt instructs Claude to put the title on the first line
 * in the format: [Episode Discussion] {episode_title}
 * The body follows after a blank line separator.
 */
function parseClaudeResponse(fullText: string, fallbackTitle: string): GeneratedPost {
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
 * Build the user message sent to Claude containing episode metadata.
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

  parts.push('', '**Episode Description (cleaned show notes):**', episode.description || '(No description available)');

  return parts.join('\n');
}
