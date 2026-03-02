import { Devvit, SettingScope } from "@devvit/public-api";

import { fetchLatestYouTubeEpisode, isNewEpisode } from "./episodeChecker.js";
import { generateEpisodePost } from "./claudeClient.js";
import { createEpisodePost, applyEpisodeFlair, managePins } from "./postManager.js";

Devvit.configure({
  redditAPI: true,
  redis: true,
  http: {
    domains: [
      'youtube.googleapis.com',          // YouTube Data API (episode detection)
      'generativelanguage.googleapis.com', // Gemini API (post generation)
    ],
  },
});

// ---------------------------------------------------------------------------
// App settings & secrets
// ---------------------------------------------------------------------------

Devvit.addSettings([
  {
    type: 'string',
    name: 'googleApiKey',
    label: 'Google API Key (YouTube Data API + Gemini)',
    isSecret: true,
    scope: SettingScope.App,
  },
  {
    type: 'string',
    name: 'subredditName',
    label: 'Subreddit name (without r/)',
    scope: SettingScope.Installation,
    defaultValue: 'hellocrawlers',
  },
]);

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
// Episode checker — scheduler job
// ---------------------------------------------------------------------------

Devvit.addSchedulerJob({
  name: 'check_new_episodes',
  onRun: async (_event, context) => {
    const { redis, reddit, settings } = context;

    try {
      // 1. Retrieve the Google API key (needed for both YouTube and Gemini)
      const googleApiKey = await settings.get<string>('googleApiKey');
      if (!googleApiKey) {
        console.error('[episodeBot] Google API key not configured. Run: npx devvit settings set googleApiKey');
        return;
      }

      // 2. Fetch the latest episode from YouTube
      console.log('[episodeBot] Fetching YouTube playlist...');
      const episode = await fetchLatestYouTubeEpisode(googleApiKey);

      if (!episode) {
        console.log('[episodeBot] No episodes found in YouTube playlist.');
        return;
      }

      // 3. Skip if this episode was already processed
      if (!(await isNewEpisode(redis, episode))) {
        console.log(`[episodeBot] No new episode. Latest: "${episode.title}"`);
        return;
      }

      console.log(`[episodeBot] 🆕 New episode detected: "${episode.title}"`);

      // 4. Generate post content via Gemini
      console.log('[episodeBot] Calling Gemini API...');
      const { title, body } = await generateEpisodePost(googleApiKey, episode);
      console.log(`[episodeBot] Generated title: "${title}"`);

      // 5. Determine target subreddit
      const subredditName =
        (await settings.get<string>('subredditName')) || 'hellocrawlers';

      // 6. Submit the Reddit post
      const post = await createEpisodePost(reddit, subredditName, title, body);
      console.log(`[episodeBot] 📝 Created post ${post.id}`);

      // 7. Apply "Episode Discussion" flair
      await applyEpisodeFlair(reddit, subredditName, post.id);

      // 8. Pin new post & unpin the previous one
      await managePins(reddit, redis, post.id);

      // 9. Persist state so we don't reprocess this episode
      await redis.set('last_episode_guid', episode.guid);
      await redis.set('last_episode_post_id', post.id);

      console.log(`[episodeBot] ✅ Episode post complete: "${title}"`);
    } catch (err) {
      console.error('[episodeBot] Episode checker failed:', err);
    }
  },
});

// ---------------------------------------------------------------------------
// Episode checker — auto-schedule on app install
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
      console.log(`[episodeBot] Scheduled episode checker — job ID: ${jobId}`);
    } catch (err) {
      console.error('[episodeBot] Failed to schedule episode checker:', err);
    }
  },
});

// ---------------------------------------------------------------------------
// Episode checker — manual trigger (moderator menu action on subreddit)
// ---------------------------------------------------------------------------

Devvit.addMenuItem({
  label: 'Check for new episodes',
  description: 'Manually trigger the Hello Crawlers RSS check and post a new episode discussion if one is available.',
  location: 'subreddit',
  forUserType: 'moderator',
  onPress: async (_event, context) => {
    context.ui.showToast('Checking for new episodes…');
    try {
      await context.scheduler.runJob({
        name: 'check_new_episodes',
        runAt: new Date(),
      });
      context.ui.showToast('Episode check triggered! Check logs for results.');
    } catch (err) {
      console.error('[episodeBot] Manual trigger failed:', err);
      context.ui.showToast('Failed to trigger episode check. See logs.');
    }
  },
});

export default Devvit;
