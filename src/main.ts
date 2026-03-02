import { Devvit, SettingScope } from "@devvit/public-api";

import { fetchLatestYouTubeEpisode, isNewEpisode } from "./episodeChecker.js";
import { generateEpisodePost } from "./claudeClient.js";
import { createEpisodePost, applyFlair, managePins } from "./postManager.js";

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
// App settings — all Installation-scoped so each subreddit configures its own
// ---------------------------------------------------------------------------

Devvit.addSettings([
  // --- API Access ---
  {
    type: 'string',
    name: 'googleApiKey',
    label: 'Google API Key (YouTube Data API + Gemini)',
    helpText: 'Free from Google Cloud Console. Enable YouTube Data API v3 and Generative Language API.',
    isSecret: true,
    scope: SettingScope.Installation,
  },

  // --- YouTube Source ---
  {
    type: 'string',
    name: 'youtubePlaylistId',
    label: 'YouTube Playlist ID',
    helpText: 'The playlist to monitor for new videos (e.g., PL0WMaa8s_mXGb3089AMtiyvordHKAZKi9).',
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
    helpText: 'Instructions for Gemini. First line of output is used as the post title. See SystemPrompt.example.md for a sample.',
    scope: SettingScope.Installation,
  },

  // --- Reddit Post Options ---
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
// Mop (comment moderation tool) — unchanged
// ---------------------------------------------------------------------------

const nukeFields: FormField[] = [
  {
    name: "remove",
    label: "Remove comments",
    type: "boolean",
    defaultValue: true,
  },
  {
    name: "lock",
    label: "Lock comments",
    type: "boolean",
    defaultValue: false,
  },
  {
    name: "skipDistinguished",
    label: "Skip distinguished comments",
    type: "boolean",
    defaultValue: false,
  },
] as const;

const nukeForm = Devvit.createForm(
  () => {
    return {
      fields: nukeFields,
      title: "Mop Comments",
      acceptLabel: "Mop",
      cancelLabel: "Cancel",
    };
  },
  async ({ values }, context) => {
    if (!values.lock && !values.remove) {
      context.ui.showToast("You must select either lock or remove.");
      return;
    }

    if (context.commentId) {
      const result = await handleNuke(
        {
          remove: values.remove,
          lock: values.lock,
          skipDistinguished: values.skipDistinguished,
          commentId: context.commentId,
          subredditId: context.subredditId,
        },
        context
      );
      console.log(
        `Mop result - ${result.success ? "success" : "fail"} - ${result.message
        }`
      );
      context.ui.showToast(
        `${result.success ? "Success" : "Failed"} : ${result.message}`
      );
    } else {
      context.ui.showToast(`Mop failed! Please try again later.`);
    }
  }
);

Devvit.addMenuItem({
  label: "Mop comments",
  description:
    "Remove this comment and all child comments. This might take a few seconds to run.",
  location: "comment",
  forUserType: "moderator",
  onPress: (_, context) => {
    context.ui.showForm(nukeForm);
  },
});

const nukePostForm = Devvit.createForm(
  () => {
    return {
      fields: nukeFields,
      title: "Mop Post Comments",
      acceptLabel: "Mop",
      cancelLabel: "Cancel",
    };
  },
  async ({ values }, context) => {
    if (!values.lock && !values.remove) {
      context.ui.showToast("You must select either lock or remove.");
      return;
    }

    if (!context.postId) {
      throw new Error("No post ID");
    }

    const result = await handleNukePost(
      {
        remove: values.remove,
        lock: values.lock,
        skipDistinguished: values.skipDistinguished,
        postId: context.postId,
        subredditId: context.subredditId,
      },
      context
    );
    console.log(
      `Mop result - ${result.success ? "success" : "fail"} - ${result.message}`
    );
    context.ui.showToast(
      `${result.success ? "Success" : "Failed"} : ${result.message}`
    );
  }
);

Devvit.addMenuItem({
  label: "Mop post comments",
  description:
    "Remove all comments of this post. This might take a few seconds to run.",
  location: "post",
  forUserType: "moderator",
  onPress: (_, context) => {
    context.ui.showForm(nukePostForm);
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
      const googleApiKey = await settings.get<string>('googleApiKey');
      const playlistId = await settings.get<string>('youtubePlaylistId');
      const geminiModel = (await settings.get<string>('geminiModel')) || 'gemini-2.0-flash';
      const systemPrompt = await settings.get<string>('systemPrompt');
      const flairName = (await settings.get<string>('flairName')) || '';

      // 2. Validate required settings
      if (!googleApiKey) {
        console.error('[bot] Google API key not configured. Set it in the app settings.');
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

      // 3. Fetch the latest video from the YouTube playlist
      const subredditName = context.subredditName!;
      console.log(`[bot] Checking playlist ${playlistId} for ${subredditName}...`);
      const episode = await fetchLatestYouTubeEpisode(googleApiKey, playlistId);

      if (!episode) {
        console.log('[bot] No videos found in YouTube playlist.');
        return;
      }

      // 4. Skip if already processed
      if (!(await isNewEpisode(redis, episode))) {
        console.log(`[bot] No new video. Latest: "${episode.title}"`);
        return;
      }

      console.log(`[bot] New video detected: "${episode.title}"`);

      // 5. Generate post content via Gemini
      console.log('[bot] Calling Gemini API...');
      const { title, body } = await generateEpisodePost(googleApiKey, episode, systemPrompt, geminiModel);
      console.log(`[bot] Generated title: "${title}"`);

      // 6. Submit the Reddit post
      const post = await createEpisodePost(reddit, subredditName, title, body);
      console.log(`[bot] Created post ${post.id}`);

      // 7. Apply flair (if configured)
      if (flairName) {
        await applyFlair(reddit, subredditName, post.id, flairName);
      }

      // 8. Pin new post & unpin the previous one
      await managePins(reddit, redis, post.id);

      // 9. Persist state so we don't reprocess this video
      await redis.set('last_episode_guid', episode.guid);
      await redis.set('last_episode_post_id', post.id);

      console.log(`[bot] Post complete: "${title}"`);
    } catch (err) {
      console.error('[bot] Video checker failed:', err);
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
      console.error('[bot] Failed to schedule video checker:', err);
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
      await context.scheduler.runJob({
        name: 'check_new_episodes',
        runAt: new Date(),
      });
      context.ui.showToast('Video check triggered! Check logs for results.');
    } catch (err) {
      console.error('[bot] Manual trigger failed:', err);
      context.ui.showToast('Failed to trigger video check. See logs.');
    }
  },
});

export default Devvit;
