import { Devvit, SettingScope } from "@devvit/public-api";

import { fetchPlaylistVideos, fetchYouTubeVideoById } from "./episodeChecker.js";
import { generateEpisodePost } from "./llmClient.js";
import { createEpisodePost, updateEpisodePost, applyBotFlair, applyFlair, managePins } from "./postManager.js";
import { getVideoRecord, setVideoRecord } from "./videoRegistry.js";
import { assemblePostBody, applyPlaceholders, matchesExclusionFilter } from "./postUtils.js";

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

  // --- Approval Gate ---
  {
    type: 'string',
    name: 'notificationMods',
    label: 'Notification Recipients (optional)',
    helpText: 'Comma-separated Reddit usernames to notify when a post is queued for approval (e.g. "alice, bob"). Leave blank to send to the general mod inbox instead.',
    defaultValue: '',
    scope: SettingScope.Installation,
  },
  {
    type: 'boolean',
    name: 'requireModApproval',
    label: 'Hold posts for mod approval',
    helpText: 'When enabled, generated posts are queued in the mod inbox for review instead of being submitted immediately. Use "Post pending episode" or "Edit & Post pending episode" in Mod Tools to publish.',
    defaultValue: false,
    scope: SettingScope.Installation,
  },
  {
    type: 'number',
    name: 'autoApproveWindowMinutes',
    label: 'Auto-approve window (minutes, 0 = off)',
    helpText: 'Only applies when "Hold posts for mod approval" is on. The post auto-publishes after this many minutes if no mod takes action. Set to 0 to require explicit mod approval with no timeout.',
    defaultValue: 0,
    scope: SettingScope.Installation,
  },
]);


// ---------------------------------------------------------------------------
// Redis key constants
// ---------------------------------------------------------------------------

const REDIS_KEY_GOOGLE_API_KEY = 'google_api_key';
const REDIS_KEY_PENDING_POST = 'pending_post';
const REDIS_KEY_PENDING_POST_JOB_ID = 'pending_post_job_id';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PendingPost {
  title: string;
  body: string;
  url: string;
  videoId: string;
  videoTitle: string;
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Failure notification helper
// ---------------------------------------------------------------------------

type RedditClient = Devvit.Context['reddit'];

/**
 * Send a failure PM to the appropriate recipients.
 *
 * Priority: if notificationMods are configured, PM each of them.
 * Otherwise fall back to the individual mod who triggered the action
 * (fallbackRecipient). If neither is available, only log — never throws.
 */
async function sendFailureNotification(
  reddit: RedditClient,
  notificationMods: string[],
  fallbackRecipient: string | null | undefined,
  subject: string,
  text: string,
): Promise<void> {
  const recipients = notificationMods.length > 0
    ? notificationMods
    : (fallbackRecipient ? [fallbackRecipient] : []);

  for (const recipient of recipients) {
    try {
      await reddit.sendPrivateMessage({ to: recipient, subject, text });
      console.log(`[bot] Sent failure notification PM to u/${recipient}`);
    } catch (pmErr) {
      console.error(`[bot] Failed to send failure notification to u/${recipient}: ${pmErr}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Google API key management — stored in Redis, set via mod menu
// ---------------------------------------------------------------------------

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
// Edit pending post form — pre-populated from Redis, posts on submit
// ---------------------------------------------------------------------------

const editPendingPostForm = Devvit.createForm(
  (data: { title: string; body: string }) => ({
    title: 'Edit Episode Post',
    fields: [
      {
        type: 'string',
        name: 'postTitle',
        label: 'Post Title',
        defaultValue: data.title,
        required: true,
      },
      {
        type: 'paragraph',
        name: 'postBody',
        label: 'Post Body',
        defaultValue: data.body,
        required: true,
      },
    ],
    acceptLabel: 'Post Now',
    cancelLabel: 'Cancel',
  }),
  async ({ values }, context) => {
    const { redis, scheduler } = context;

    const pendingJson = await redis.get(REDIS_KEY_PENDING_POST);
    if (!pendingJson) {
      context.ui.showToast('No pending episode found. It may have already been posted or cancelled.');
      return;
    }

    // Write edited content back to Redis before triggering the post job
    const pending: PendingPost = JSON.parse(pendingJson);
    pending.title = (values.postTitle as string).trim();
    pending.body = (values.postBody as string).trim();
    await redis.set(REDIS_KEY_PENDING_POST, JSON.stringify(pending));

    // Cancel any scheduled auto-approve job — we're posting immediately
    const existingJobId = await redis.get(REDIS_KEY_PENDING_POST_JOB_ID);
    if (existingJobId) {
      try { await scheduler.cancelJob(existingJobId); } catch (_) { /* already fired */ }
      await redis.del(REDIS_KEY_PENDING_POST_JOB_ID);
    }

    await scheduler.runJob({ name: 'post_pending_episode', runAt: new Date() });
    context.ui.showToast('Posting edited episode...');
  }
);

// ---------------------------------------------------------------------------
// Video checker — scheduler job
// ---------------------------------------------------------------------------

Devvit.addSchedulerJob({
  name: 'check_new_episodes',
  onRun: async (_event, context) => {
    const { redis, reddit, settings } = context;
    // Hoisted so the catch block can reference it even if an early error occurs
    let notificationMods: string[] = [];

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
      const requireModApproval = (await settings.get<boolean>('requireModApproval')) ?? false;
      const autoApproveWindowMinutes = (await settings.get<number>('autoApproveWindowMinutes')) ?? 0;
      const notificationModsSetting = (await settings.get<string>('notificationMods')) || '';
      notificationMods = notificationModsSetting.split(',').map(u => u.trim()).filter(Boolean);

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

      // 5. Generate post content via Gemini
      console.log('[bot] Calling Gemini API...');
      const { title, body: rawBody } = await generateEpisodePost(googleApiKey, episode, systemPrompt, geminiModel);
      console.log(`[bot] Generated title: "${title}"`);

      const body = assemblePostBody(
        applyPlaceholders(prependText, episode),
        rawBody,
        applyPlaceholders(videoLinkLabel, episode),
        episode.link,
        applyPlaceholders(appendText, episode),
      );

      // 6. Queue for mod approval, or post immediately
      if (requireModApproval) {
        // If there's already a pending post, don't overwrite it — the mod must act first
        const existingPending = await redis.get(REDIS_KEY_PENDING_POST);
        if (existingPending) {
          console.log('[bot] A post is already pending mod approval. Skipping until it is posted or cancelled.');
          return;
        }

        const pendingPost: PendingPost = {
          title,
          body,
          url: episode.link,
          videoId: episode.guid,
          videoTitle: episode.title,
          generatedAt: new Date().toISOString(),
        };
        await redis.set(REDIS_KEY_PENDING_POST, JSON.stringify(pendingPost));

        // Schedule auto-approve if a window is configured
        if (autoApproveWindowMinutes > 0) {
          const autoApproveAt = new Date(Date.now() + autoApproveWindowMinutes * 60 * 1000);
          const jobId = await context.scheduler.runJob({
            name: 'post_pending_episode',
            runAt: autoApproveAt,
          });
          await redis.set(REDIS_KEY_PENDING_POST_JOB_ID, jobId);
          console.log(`[bot] Post queued for auto-approval in ${autoApproveWindowMinutes} minute(s) — job ${jobId}`);
        } else {
          console.log('[bot] Post queued pending explicit mod approval.');
        }

        // Send notification (non-fatal — post is safely stored in Redis regardless)
        const autoApproveNote = autoApproveWindowMinutes > 0
          ? `\n\nThis post will **auto-publish in ${autoApproveWindowMinutes} minute${autoApproveWindowMinutes === 1 ? '' : 's'}** if no mod takes action.`
          : '';
        const notificationBodyMarkdown = [
          `**New episode ready to review:**`,
          ``,
          `**Title:** ${title}`,
          ``,
          `---`,
          ``,
          body.length > 1000 ? body.slice(0, 1000) + '\n\n*(preview truncated)*' : body,
          ``,
          `---`,
          ``,
          `**Video:** ${episode.link}`,
          ``,
          `Use **Mod Tools** on r/${subredditName} to take action:`,
          `- **"Post pending episode"** — publish as-is`,
          `- **"Edit & Post pending episode"** — edit title/body before publishing`,
          `- **"Cancel pending episode"** — discard this post`,
          autoApproveNote,
        ].join('\n');

        if (notificationMods.length > 0) {
          // Notify each listed mod via private message
          for (const modUsername of notificationMods) {
            try {
              await reddit.sendPrivateMessage({
                to: modUsername,
                subject: `New episode ready: ${title}`,
                text: notificationBodyMarkdown,
              });
              console.log(`[bot] Sent pending-post notification PM to u/${modUsername}`);
            } catch (pmErr) {
              console.error(`[bot] Failed to send notification PM to u/${modUsername}: ${pmErr}`);
            }
          }
        } else {
          // Fall back to general mod inbox via modmail
          try {
            const sub = await reddit.getSubredditByName(subredditName);
            await reddit.modMail.createModInboxConversation({
              subredditId: sub.id,
              subject: `New episode ready: ${title}`,
              bodyMarkdown: notificationBodyMarkdown,
            });
            console.log('[bot] Sent modmail notification for pending post.');
          } catch (mailErr) {
            console.error(`[bot] Failed to send modmail notification: ${mailErr}`);
          }
        }

        return;
      }

      // 7. Immediate post path (requireModApproval = false)
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
      await sendFailureNotification(
        reddit,
        notificationMods,
        triggeredBy,
        'Video check failed',
        `The video check on r/${context.subredditName!} failed with the following error:\n\n    ${err}\n\nPlease try again later. If the error persists, check the app logs for more details.`,
      );
    }
  },
});

// ---------------------------------------------------------------------------
// Post pending episode — scheduler job
// Handles both explicit mod approval (runAt: new Date()) and auto-approve timer
// ---------------------------------------------------------------------------

Devvit.addSchedulerJob({
  name: 'post_pending_episode',
  onRun: async (_event, context) => {
    const { redis, reddit, settings } = context;
    let notificationMods: string[] = [];

    try {
      const pendingJson = await redis.get(REDIS_KEY_PENDING_POST);
      if (!pendingJson) {
        // Already posted or cancelled — nothing to do
        console.log('[bot] post_pending_episode: no pending post found (already posted or cancelled).');
        return;
      }

      const pending: PendingPost = JSON.parse(pendingJson);
      const subredditName = context.subredditName!;

      const flairName = (await settings.get<string>('flairName')) || '';
      const botFlairEmoji = (await settings.get<string>('botFlairEmoji')) || '';
      const botFlairText = (await settings.get<string>('botFlairText')) || '';
      const notificationModsSetting = (await settings.get<string>('notificationMods')) || '';
      notificationMods = notificationModsSetting.split(',').map(u => u.trim()).filter(Boolean);

      console.log(`[bot] Posting pending episode: "${pending.title}"`);
      const post = await createEpisodePost(reddit, subredditName, pending.title, pending.url, pending.body);
      console.log(`[bot] Created post ${post.id}`);

      if (flairName) {
        await applyFlair(reddit, subredditName, post.id, flairName);
      }
      await applyBotFlair(reddit, subredditName, botFlairEmoji, botFlairText);
      await managePins(reddit, redis, post.id);

      await setVideoRecord(redis, pending.videoId, {
        title: pending.videoTitle,
        status: 'posted',
        postId: post.id,
        processedAt: new Date().toISOString(),
      });
      await redis.set('last_episode_guid', pending.videoId);
      await redis.set('last_episode_post_id', post.id);

      // Clean up pending state
      await redis.del(REDIS_KEY_PENDING_POST);
      await redis.del(REDIS_KEY_PENDING_POST_JOB_ID);

      console.log(`[bot] Pending episode posted: "${pending.title}"`);
    } catch (err) {
      console.error(`[bot] Failed to post pending episode: ${err}`);
      const triggeredBy = await redis.get('check_triggered_by');
      await sendFailureNotification(
        reddit,
        notificationMods,
        triggeredBy,
        'Episode post failed',
        `Failed to post the pending episode on r/${context.subredditName} with error:\n\n    ${err}\n\nThe episode content is still saved. Try using "Post pending episode" in Mod Tools to retry.`,
      );
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
// Pending episode — mod approval actions
// ---------------------------------------------------------------------------

Devvit.addMenuItem({
  label: 'Post pending episode',
  description: 'Publish the queued episode post as-is.',
  location: 'subreddit',
  forUserType: 'moderator',
  onPress: async (_event, context) => {
    const { redis, scheduler } = context;
    const pendingJson = await redis.get(REDIS_KEY_PENDING_POST);
    if (!pendingJson) {
      context.ui.showToast('No episode is pending approval.');
      return;
    }
    // Cancel any scheduled auto-approve job before posting now
    const existingJobId = await redis.get(REDIS_KEY_PENDING_POST_JOB_ID);
    if (existingJobId) {
      try { await scheduler.cancelJob(existingJobId); } catch (_) { /* already fired */ }
      await redis.del(REDIS_KEY_PENDING_POST_JOB_ID);
    }
    await scheduler.runJob({ name: 'post_pending_episode', runAt: new Date() });
    context.ui.showToast('Posting episode...');
  },
});

Devvit.addMenuItem({
  label: 'Edit & Post pending episode',
  description: 'Edit the queued episode title and body before publishing.',
  location: 'subreddit',
  forUserType: 'moderator',
  onPress: async (_event, context) => {
    const pendingJson = await context.redis.get(REDIS_KEY_PENDING_POST);
    if (!pendingJson) {
      context.ui.showToast('No episode is pending approval.');
      return;
    }
    const pending: PendingPost = JSON.parse(pendingJson);
    context.ui.showForm(editPendingPostForm, { title: pending.title, body: pending.body });
  },
});

Devvit.addMenuItem({
  label: 'Cancel pending episode',
  description: 'Discard the queued episode post without publishing.',
  location: 'subreddit',
  forUserType: 'moderator',
  onPress: async (_event, context) => {
    const { redis, scheduler } = context;
    const pendingJson = await redis.get(REDIS_KEY_PENDING_POST);
    if (!pendingJson) {
      context.ui.showToast('No pending episode to cancel.');
      return;
    }
    const existingJobId = await redis.get(REDIS_KEY_PENDING_POST_JOB_ID);
    if (existingJobId) {
      try { await scheduler.cancelJob(existingJobId); } catch (_) { /* already fired */ }
      await redis.del(REDIS_KEY_PENDING_POST_JOB_ID);
    }
    await redis.del(REDIS_KEY_PENDING_POST);
    context.ui.showToast('Pending episode cancelled.');
  },
});

// ---------------------------------------------------------------------------
// Regenerate latest post (re-run Gemini for the already-posted video)
// ---------------------------------------------------------------------------

Devvit.addSchedulerJob({
  name: 'regenerate_latest_post',
  onRun: async (_event, context) => {
    const { redis, reddit, settings } = context;
    let notificationMods: string[] = [];

    try {
      const notificationModsSetting = (await settings.get<string>('notificationMods')) || '';
      notificationMods = notificationModsSetting.split(',').map(u => u.trim()).filter(Boolean);

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

      const body = assemblePostBody(
        applyPlaceholders(prependText, episode),
        rawBody,
        applyPlaceholders(videoLinkLabel, episode),
        episode.link,
        applyPlaceholders(appendText, episode),
      );

      await updateEpisodePost(reddit, postId, body);
      await applyBotFlair(reddit, context.subredditName!, botFlairEmoji, botFlairText);
      console.log(`[bot] Regenerated post ${postId}`);
    } catch (err) {
      console.error(`[bot] Regeneration failed: ${err}`);
      const triggeredBy = await redis.get('regenerate_triggered_by');
      await sendFailureNotification(
        reddit,
        notificationMods,
        triggeredBy,
        'Post regeneration failed',
        `The post regeneration on r/${context.subredditName} failed with the following error:\n\n    ${err}\n\nPlease try again later. If the error persists, check the app logs for more details.`,
      );
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
