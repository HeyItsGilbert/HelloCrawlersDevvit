/**
 * Shared types for the Hello Crawlers episode bot.
 */

export interface EpisodeData {
  /** Unique identifier from the RSS feed — used for deduplication */
  guid: string;
  /** Episode title as-is from the RSS feed */
  title: string;
  /** Cleaned (HTML-stripped, decoded) episode description/show notes */
  description: string;
  /** RFC 2822 publish date string from the RSS feed */
  pubDate: string;
  /** Episode URL (link to the episode page) */
  link: string;
  /** Episode number from <itunes:episode>, if present */
  episodeNumber?: string;
}

export interface GeneratedPost {
  /** Full post title including "[Episode Discussion]" prefix */
  title: string;
  /** Markdown body for the Reddit post */
  body: string;
}
