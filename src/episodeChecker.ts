import { type EpisodeData } from './types.js';

const PLAYLIST_ID = 'PL0WMaa8s_mXGb3089AMtiyvordHKAZKi9';
const YT_API_BASE = 'https://youtube.googleapis.com/youtube/v3';

interface YouTubePlaylistResponse {
  items?: Array<{
    snippet: {
      publishedAt: string;
      title: string;
      description: string;
      resourceId: {
        videoId: string;
      };
    };
  }>;
}

/**
 * Fetch the latest episode from the Hello Crawlers YouTube playlist.
 * Returns null if the playlist is empty.
 */
export async function fetchLatestYouTubeEpisode(apiKey: string): Promise<EpisodeData | null> {
  const url =
    `${YT_API_BASE}/playlistItems` +
    `?part=snippet&maxResults=1&playlistId=${PLAYLIST_ID}&key=${encodeURIComponent(apiKey)}`;

  const response = await fetch(url);
  if (!response.ok) {
    const errText = await response.text().catch(() => '(unreadable)');
    throw new Error(`YouTube API error ${response.status}: ${errText}`);
  }

  const data = (await response.json()) as YouTubePlaylistResponse;
  const item = data.items?.[0];
  if (!item) return null;

  const { snippet } = item;
  const videoId = snippet.resourceId.videoId;

  return {
    guid: videoId,
    title: snippet.title,
    description: snippet.description ?? '',
    pubDate: snippet.publishedAt,
    link: `https://www.youtube.com/watch?v=${videoId}`,
    episodeNumber: undefined,
  };
}

/**
 * Check whether the given episode is newer than the last one we processed.
 * Uses Redis key `last_episode_guid` for comparison.
 */
export async function isNewEpisode(
  redis: { get: (key: string) => Promise<string | undefined | null> },
  episode: EpisodeData
): Promise<boolean> {
  const lastGuid = await redis.get('last_episode_guid');
  return lastGuid !== episode.guid;
}
