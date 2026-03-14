import { Devvit, SettingScope } from "@devvit/public-api";

import { fetchPlaylistVideos, fetchYouTubeVideoById, matchesExclusionFilter } from "./episodeChecker.js";
import { generateEpisodePost } from "./llmClient.js";
import { createEpisodePost, updateEpisodePost, applyBotFlair, applyFlair, managePins } from "./postManager.js";
import { getVideoRecord, setVideoRecord } from "./videoRegistry.js";

Devvit.configure({
  redditAPI: true,
  redis: true,
  http: {
    domains: [
      'youtube.googleapis.com',          // YouTube Data API (video detection)
      'generativelanguage.googleapis.com', // Gemini API (post generation)
    ],
  },
});

// ---------------------------------------------------------------------------
// App settings — Installation-scoped so each subreddit configures its own
// ---------------------------------------------------------------------------

Devvit.addSettings([
  // --- YouTube Source ---
  {
    type: 'string',
    name: 'youtubePlaylistId',
    label: 'YouTube Playlist ID',
    helpText: 'Playlist to monitor for new videos. You can use a regular playlist ID (e.g. PLabc123) or a channel ID (e.g. UCabc123) — the app will automatically use that channel\'s Uploads playlist, which is always sorted newest-first.',
    scope: SettingScope.Installation,
  },
  {
    type: 'string',
    name: 'excludeTitleKeywords',
    label: 'Exclude Title Keywords (optional)',
    helpText: 'Comma-separated list of keywords. Videos whose titles contain any of these words are permanently skipped (e.g. "trailer, short, bonus").',
    defaultValue: '',
    scope: SettingScope.Installation,
  },

  // --- Gemini Configuration ---
  {
    type: 'string',
    name: 'geminiModel',
    label: 'Gemini Model',
    helpText: 'Model ID for post generation (default: gemini-2.0-flash, free tier).',
    defaultValue: 'gemini-2.0-flash',
    scope: SettingScope.Installation,
  },
  {
    type: 'paragraph',
    name: 'systemPrompt',
    label: 'System Prompt',
    helpText: 'Instructions for Gemini. First line of output is used as the post title. The user message will include: Title, Published date, Link, and Description. See SystemPrompt.example.md for a sample.',
    scope: SettingScope.Installation,
  },

  // --- Reddit Post Options ---
  // --- Bot Identity ---
  {
    type: 'string',
    name: 'botFlairEmoji',
    label: 'Bot Flair Emoji (optional)',
    helpText: 'Emoji shown in the bot\'s author flair on this subreddit, e.g. 🎙️',
    defaultValue: '',
    scope: SettingScope.Installation,
  },
  {
    type: 'string',
    name: 'botFlairText',
    label: 'Bot Flair Text (optional)',
    helpText: 'Display name shown in the bot\'s author flair on this subreddit, e.g. "Podcast Bot". Combined with the emoji if both are set.',
    defaultValue: '',
    scope: SettingScope.Installation,
  },

  // --- Reddit Post Options ---
  {
    type: 'string',
    name: 'videoLinkLabel',
    label: 'Video Link Label (optional)',
    helpText: 'If set, a link to the YouTube video is inserted between the generated body and Append Text. The label becomes the link text, e.g. "Watch on YouTube" → [Watch on YouTube](url). Leave blank to omit.',
    defaultValue: '',
    scope: SettingScope.Installation,
  },
  {
    type: 'paragraph',
    name: 'prependText',
    label: 'Prepend Text (optional)',
    helpText: 'Text added to the top of every generated post body. Useful for recurring links or disclaimers.',
    defaultValue: '',
    scope: SettingScope.Installation,
  },
  {
    type: 'paragraph',
    name: 'appendText',
    label: 'Append Text (optional)',
    helpText: 'Text added to the bottom of every generated post body. Useful for footers or recurring links.',
    defaultValue: '',
    scope: SettingScope.Installation,
  },
  {
    type: 'string',
    name: 'flairName',
    label: 'Post Flair (optional)',
    helpText: 'Exact name of a post flair template on this subreddit. Leave blank for no flair.',
    defaultValue: '',
    scope: SettingScope.Installation,
  },
]);


// ---------------------------------------------------------------------------
// Google API key management — stored in Redis, set via mod menu
// ---------------------------------------------------------------------------

const REDIS_KEY_GOOGLE_API_KEY = 'google_api_key';

const apiKeyForm = Devvit.createForm(
  {
    title: 'Set Google API Key',
    description: 'Your key is stored in this subreddit\'s Redis store. Get a free key from Google Cloud Console with YouTube Data API v3 and Generative Language API enabled.',
    fields: [
      {
        type: 'string',
        name: 'apiKey',
        label: 'Google API Key',
        required: true,
      },
    ],
    acceptLabel: 'Save',
    cancelLabel: 'Cancel',
  },
  async ({ values }, context) => {
    const key = values.apiKey?.trim();
    if (!key) {
      context.ui.showToast('API key cannot be empty.');
      return;
    }
    await context.redis.set(REDIS_KEY_GOOGLE_API_KEY, key);
    context.ui.showToast('Google API key saved.');
  }
);

Devvit.addMenuItem({
  label: 'Set Google API Key',
  description: 'Store your Google API key (YouTube + Gemini) for this subreddit.',
  location: 'subreddit',
  forUserType: 'moderator',
  onPress: (_event, context) => {
    context.ui.showForm(apiKeyForm);
  },
});

// ---------------------------------------------------------------------------
// Video checker — scheduler job
// ---------------------------------------------------------------------------

Devvit.addSchedulerJob({
  name: 'check_new_episodes',
  onRun: async (_event, context) => {
    const { redis, reddit, settings } = context;

    try {
      // 1. Read all settings
      const googleApiKey = await redis.get(REDIS_KEY_GOOGLE_API_KEY);
      const playlistId = await settings.get<string>('youtubePlaylistId');
      const excludeKeywords = (await settings.get<string>('excludeTitleKeywords')) || '';
      const geminiModel = (await settings.get<string>('geminiModel')) || 'gemini-2.0-flash';
      const systemPrompt = await settings.get<string>('systemPrompt');
      const botFlairEmoji = (await settings.get<string>('botFlairEmoji')) || '';
      const botFlairText = (await settings.get<string>('botFlairText')) || '';
      const videoLinkLabel = (await settings.get<string>('videoLinkLabel')) || '';
      const prependText = (await settings.get<string>('prependText')) || '';
      const appendText = (await settings.get<string>('appendText')) || '';
      const flairName = (await settings.get<string>('flairName')) || '';

      // 2. Validate required settings
      if (!googleApiKey) {
        console.error('[bot] Google API key not configured. Use the "Set Google API Key" mod menu item.');
        return;
      }
      if (!playlistId) {
        console.error('[bot] YouTube Playlist ID not configured. Set it in the app settings.');
        return;
      }
      if (!systemPrompt) {
        console.error('[bot] System prompt not configured. Set it in the app settings.');
        return;
      }

      // 3. Fetch playlist videos (newest first, up to 50)
      const subredditName = context.subredditName!;
      console.log(`[bot] Checking playlist ${playlistId} for ${subredditName}...`);
      const videos = await fetchPlaylistVideos(googleApiKey, playlistId);

      if (!videos.length) {
        console.log('[bot] No videos found in YouTube playlist.');
        return;
      }

      // 4. Walk videos newest-first; find the first unregistered, non-excluded video.
      //    We scan past already-known videos instead of stopping at them so that
      //    videos which were private (invisible to the API) when earlier videos
      //    were posted are still detected once they become public.
      const forceRepost = (await redis.get('force_repost')) === '1';
      if (forceRepost) {
        await redis.del('force_repost');
        console.log('[bot] force_repost flag set — bypassing registry check for newest video');
      }

      let episodeToPost = null;

      for (const video of videos) {
        // Skip registry check for the very first (newest) video when force_repost is active
        if (!forceRepost || episodeToPost !== null) {
          const record = await getVideoRecord(redis, video.guid);
          if (record) {
            console.log(`[bot] Skipping "${video.title}" (${video.guid}) — already ${record.status}`);
            continue; // Already handled — keep scanning for gaps
          }
        }

        if (matchesExclusionFilter(video.title, excludeKeywords)) {
          console.log(`[bot] Excluding video "${video.title}" (matches exclusion filter)`);
          await setVideoRecord(redis, video.guid, {
            title: video.title,
            status: 'excluded',
            processedAt: new Date().toISOString(),
          });
          continue;
        }

        if (!episodeToPost) {
          // Newest unregistered, non-excluded video — this is the one to post
          episodeToPost = video;
        } else {
          // Older unregistered video — mark as skipped so it's never posted
          console.log(`[bot] Skipping "${video.title}" (${video.guid}) — older than the video to post`);
          await setVideoRecord(redis, video.guid, {
            title: video.title,
            status: 'skipped',
            processedAt: new Date().toISOString(),
          });
        }
      }

      if (!episodeToPost) {
        console.log(`[bot] No new video to post.`);
        return;
      }

      const episode = episodeToPost;
      console.log(`[bot] New video detected: "${episode.title}"`);

      // 6. Generate post content via Gemini
      console.log('[bot] Calling Gemini API...');
      const { title, body: rawBody } = await generateEpisodePost(googleApiKey, episode, systemPrompt, geminiModel);
      console.log(`[bot] Generated title: "${title}"`);

      const videoLink = videoLinkLabel && episode.link ? `[${videoLinkLabel}](${episode.link})` : '';
      const body = [prependText, rawBody, videoLink, appendText].filter(Boolean).join('\n\n');

      // 7. Submit the link post (URL = episode video link, body = generated text)
      const post = await createEpisodePost(reddit, subredditName, title, episode.link, body);
      console.log(`[bot] Created post ${post.id}`);

      // 8. Apply post flair and bot author flair (if configured)
      if (flairName) {
        await applyFlair(reddit, subredditName, post.id, flairName);
      }
      await applyBotFlair(reddit, subredditName, botFlairEmoji, botFlairText);

      // 9. Pin new post & unpin the previous one
      await managePins(reddit, redis, post.id);

      // 10. Persist to registry and keep legacy keys for backwards compatibility
      await setVideoRecord(redis, episode.guid, {
        title: episode.title,
        status: 'posted',
        postId: post.id,
        processedAt: new Date().toISOString(),
      });
      await redis.set('last_episode_guid', episode.guid);
      await redis.set('last_episode_post_id', post.id);


      console.log(`[bot] Post complete: "${title}"`);
    } catch (err) {
      console.error(`[bot] Video checker failed: ${err}`);
      const triggeredBy = await redis.get('check_triggered_by');
      if (triggeredBy) {
        try {
          await reddit.sendPrivateMessage({
            to: triggeredBy,
            subject: 'Video check failed',
            text: `Hi u/${triggeredBy},\n\nThe video check you triggered on r/${context.subredditName!} failed with the following error:\n\n    ${err}\n\nPlease try again later. If the error persists, check the app logs for more details.`,
          });
          console.log(`[bot] Sent error notification PM to u/${triggeredBy}`);
        } catch (pmErr) {
          console.error(`[bot] Failed to send error notification PM: ${pmErr}`);
        }
      }
    }
  },
});

// ---------------------------------------------------------------------------
// Auto-schedule on app install
// ---------------------------------------------------------------------------

Devvit.addTrigger({
  event: 'AppInstall',
  onEvent: async (_event, context) => {
    try {
      // Cancel any existing job first (idempotent re-install)
      const existingJobId = await context.redis.get('episode_checker_job_id');
      if (existingJobId) {
        try {
          await context.scheduler.cancelJob(existingJobId);
        } catch (_) {
          // Job may already be gone — ignore
        }
      }

      const jobId = await context.scheduler.runJob({
        name: 'check_new_episodes',
        cron: '*/30 * * * *', // Every 30 minutes
      });

      await context.redis.set('episode_checker_job_id', jobId);
      console.log(`[bot] Scheduled video checker — job ID: ${jobId}`);
    } catch (err) {
      console.error(`[bot] Failed to schedule video checker: ${err}`);
    }
  },
});

// ---------------------------------------------------------------------------
// Manual trigger (moderator menu action)
// ---------------------------------------------------------------------------

Devvit.addMenuItem({
  label: 'Check for new videos',
  description: 'Manually check the YouTube playlist for new videos and generate a post if one is found.',
  location: 'subreddit',
  forUserType: 'moderator',
  onPress: async (_event, context) => {
    context.ui.showToast('Checking for new videos...');
    try {
      const currentUser = await context.reddit.getCurrentUser();
      if (currentUser) {
        await context.redis.set('check_triggered_by', currentUser.username);
      }
      await context.scheduler.runJob({
        name: 'check_new_episodes',
        runAt: new Date(),
      });
      context.ui.showToast('Video check triggered! Check logs for results.');
    } catch (err) {
      console.error(`[bot] Manual trigger failed: ${err}`);
      context.ui.showToast('Failed to trigger video check. See logs.');
    }
  },
});

// ---------------------------------------------------------------------------
// Force post latest video (testing — bypasses registry check)
// ---------------------------------------------------------------------------

Devvit.addMenuItem({
  label: 'Force post latest video (testing)',
  description: 'Re-post the newest playlist video even if it has already been posted. Sets a one-shot flag then triggers the normal check job.',
  location: 'subreddit',
  forUserType: 'moderator',
  onPress: async (_event, context) => {
    context.ui.showToast('Forcing post of latest video...');
    try {
      await context.redis.set('force_repost', '1');
      const currentUser = await context.reddit.getCurrentUser();
      if (currentUser) {
        await context.redis.set('check_triggered_by', currentUser.username);
      }
      await context.scheduler.runJob({
        name: 'check_new_episodes',
        runAt: new Date(),
      });
      context.ui.showToast('Force post triggered! Check logs for results.');
    } catch (err) {
      console.error(`[bot] Force post trigger failed: ${err}`);
      context.ui.showToast('Failed to trigger force post. See logs.');
    }
  },
});

// ---------------------------------------------------------------------------
// Regenerate latest post (re-run Gemini for the already-posted video)
// ---------------------------------------------------------------------------

Devvit.addSchedulerJob({
  name: 'regenerate_latest_post',
  onRun: async (_event, context) => {
    const { redis, reddit, settings } = context;

    try {
      const postId = await redis.get('last_episode_post_id');
      const videoId = await redis.get('last_episode_guid');

      if (!postId || !videoId) {
        console.error('[bot] No previous post found to regenerate.');
        return;
      }

      const googleApiKey = await redis.get(REDIS_KEY_GOOGLE_API_KEY);
      const geminiModel = (await settings.get<string>('geminiModel')) || 'gemini-2.0-flash';
      const systemPrompt = await settings.get<string>('systemPrompt');
      const botFlairEmoji = (await settings.get<string>('botFlairEmoji')) || '';
      const botFlairText = (await settings.get<string>('botFlairText')) || '';
      const videoLinkLabel = (await settings.get<string>('videoLinkLabel')) || '';
      const prependText = (await settings.get<string>('prependText')) || '';
      const appendText = (await settings.get<string>('appendText')) || '';

      if (!googleApiKey || !systemPrompt) {
        console.error('[bot] Missing required settings. Ensure Google API key is set via the mod menu and systemPrompt is configured.');
        return;
      }

      console.log(`[bot] Fetching video ${videoId} for regeneration...`);
      const episode = await fetchYouTubeVideoById(googleApiKey, videoId);
      if (!episode) {
        console.error(`[bot] Video ${videoId} not found on YouTube.`);
        return;
      }

      console.log(`[bot] Regenerating post for "${episode.title}"...`);
      const { body: rawBody } = await generateEpisodePost(googleApiKey, episode, systemPrompt, geminiModel);

      const videoLink = videoLinkLabel && episode.link ? `[${videoLinkLabel}](${episode.link})` : '';
      const body = [prependText, rawBody, videoLink, appendText].filter(Boolean).join('\n\n');

      await updateEpisodePost(reddit, postId, body);
      await applyBotFlair(reddit, context.subredditName!, botFlairEmoji, botFlairText);
      console.log(`[bot] Regenerated post ${postId}`);
    } catch (err) {
      console.error(`[bot] Regeneration failed: ${err}`);
      const triggeredBy = await redis.get('regenerate_triggered_by');
      if (triggeredBy) {
        try {
          await reddit.sendPrivateMessage({
            to: triggeredBy,
            subject: 'Post regeneration failed',
            text: `Hi u/${triggeredBy},\n\nThe post regeneration you triggered on r/${context.subredditName} failed with the following error:\n\n    ${err}\n\nPlease try again later. If the error persists, check the app logs for more details.`,
          });
          console.log(`[bot] Sent error notification PM to u/${triggeredBy}`);
        } catch (pmErr) {
          console.error(`[bot] Failed to send error notification PM: ${pmErr}`);
        }
      }
    }
  },
});

Devvit.addMenuItem({
  label: 'Regenerate latest post',
  description: 'Re-run Gemini for the last posted video and update the post body.',
  location: 'subreddit',
  forUserType: 'moderator',
  onPress: async (_event, context) => {
    context.ui.showToast('Regenerating post...');
    try {
      const currentUser = await context.reddit.getCurrentUser();
      if (currentUser) {
        await context.redis.set('regenerate_triggered_by', currentUser.username);
      }
      await context.scheduler.runJob({
        name: 'regenerate_latest_post',
        runAt: new Date(),
      });
      context.ui.showToast('Regeneration triggered! Check logs for results.');
    } catch (err) {
      console.error(`[bot] Regenerate trigger failed: ${err}`);
      context.ui.showToast('Failed to trigger regeneration. See logs.');
    }
  },
});

export default Devvit;
