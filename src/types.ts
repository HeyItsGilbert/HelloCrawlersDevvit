/**
 * Shared types for the YouTube + Gemini auto-post bot.
 */

export interface EpisodeData {
  /** Unique identifier (YouTube video ID) — used for deduplication */
  guid: string;
  /** Video title as-is from YouTube */
  title: string;
  /** Video description from YouTube */
  description: string;
  /** ISO 8601 publish date string from YouTube */
  pubDate: string;
  /** Video URL */
  link: string;
  /** Episode number, if present */
  episodeNumber?: string;
}

export interface GeneratedPost {
  /** Post title (first line of Gemini output) */
  title: string;
  /** Markdown body for the Reddit post */
  body: string;
}
