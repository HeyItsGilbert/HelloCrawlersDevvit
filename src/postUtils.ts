/**
 * Shared pure utility functions used by both the Devvit app and the
 * web-based preview app (preview-site).
 *
 * IMPORTANT: Keep this file free of platform-specific imports.
 * No Devvit APIs, no Node built-ins, no browser-only globals.
 */

import { type EpisodeData, type GeneratedPost } from './types.js';

// ---------------------------------------------------------------------------
// YouTube helpers
// ---------------------------------------------------------------------------

/**
 * If the caller supplies a YouTube channel ID (starts with "UC"),
 * convert it to the corresponding Uploads playlist ID ("UU...").
 * The Uploads playlist is always sorted newest-first by the API.
 */
export function resolvePlaylistId(playlistId: string): string {
  if (playlistId.startsWith('UC')) {
    return 'UU' + playlistId.slice(2);
  }
  return playlistId;
}

// ---------------------------------------------------------------------------
// Gemini / LLM helpers
// ---------------------------------------------------------------------------

/**
 * Build the user message sent to Gemini containing video metadata.
 * The system prompt instructs the model to output the title on the
 * first line; everything else is the body.
 */
export function buildUserMessage(episode: EpisodeData): string {
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

/**
 * Split a raw Gemini response into a Reddit title and body.
 *
 * Convention: the first non-empty line is the post title;
 * everything after it is the body. The mod's system prompt must
 * instruct the model to output the title on the first line.
 */
export function parseGeneratedResponse(fullText: string, fallbackTitle: string): GeneratedPost {
  const lines = fullText.split('\n');
  const titleLineIndex = lines.findIndex((l) => l.trim().length > 0);

  if (titleLineIndex === -1) {
    return { title: fallbackTitle, body: fullText.trim() };
  }

  const title = lines[titleLineIndex].trim();
  const body = lines.slice(titleLineIndex + 1).join('\n').trim();

  return { title, body };
}

// ---------------------------------------------------------------------------
// Placeholder substitution
// ---------------------------------------------------------------------------

/**
 * Replace placeholder tokens in a user-supplied template string with values
 * from the episode. Placeholders are case-sensitive and use curly-brace syntax.
 *
 * Available tokens:
 *   {Title}         — video title
 *   {Description}   — video description (empty string if not set)
 *   {Published}     — ISO 8601 publish date
 *   {Link}          — full YouTube video URL
 *   {EpisodeNumber} — episode number, or empty string if not set
 *
 * Applied to: system prompt, prependText, appendText, videoLinkLabel.
 */
export function applyPlaceholders(template: string, episode: EpisodeData): string {
  return template
    .replace(/\{Title\}/g, episode.title)
    .replace(/\{Description\}/g, episode.description || '')
    .replace(/\{Published\}/g, episode.pubDate)
    .replace(/\{Link\}/g, episode.link)
    .replace(/\{EpisodeNumber\}/g, episode.episodeNumber ?? '');
}

// ---------------------------------------------------------------------------
// Post body assembly
// ---------------------------------------------------------------------------

/**
 * Assemble the final Reddit post body from its parts.
 * Mirrors the assembly order in the Devvit app's check_new_episodes job:
 *   [prependText, rawBody, videoLink, appendText]
 *
 * The video link is only included when both label and url are non-empty.
 * Empty/falsy parts are filtered out before joining with double newlines.
 */
export function assemblePostBody(
  prependText: string,
  rawBody: string,
  videoLinkLabel: string,
  videoUrl: string,
  appendText: string
): string {
  const linkPart = videoLinkLabel && videoUrl ? `[${videoLinkLabel}](${videoUrl})` : '';
  return [prependText, rawBody, linkPart, appendText].filter(Boolean).join('\n\n');
}
