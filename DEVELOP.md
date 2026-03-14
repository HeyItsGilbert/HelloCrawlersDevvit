# Developer Setup

## Project structure

```
src/
  main.ts              -- Entry point: settings, scheduler, triggers, menu actions
  episodeChecker.ts    -- YouTube Data API: fetch latest video from playlist
  llmClient.ts         -- Gemini API: generate post with mod-supplied prompt
  postManager.ts       -- Reddit post creation, flair, pin management
  postUtils.ts         -- Shared pure utilities (no Devvit/browser deps):
                          resolvePlaylistId, buildUserMessage,
                          parseGeneratedResponse, assemblePostBody
  videoRegistry.ts     -- Redis-backed registry of processed videos
  types.ts             -- Shared TypeScript types (EpisodeData, GeneratedPost, VideoRecord)

preview-site/  -- React + Vite preview web app (deployed to Netlify)
netlify.toml                  -- Netlify deploy config (base: preview-site/)
```

## 1. Install dependencies

```bash
npm install
```

## 2. Start a playtest session

```bash
npm run dev
```

This installs the app to your test subreddit and streams logs.

## 3. Set the Google API Key

Each subreddit stores its own Google API key via a mod menu action.

1. Navigate to your subreddit.
2. Open the **Mod Tools** menu and select **Set Google API Key**.
3. Paste your key into the masked input and click **Save**.

The key is stored in the subreddit's Redis store. To get a key, visit the visit the [AI Studio](https://aistudio.google.com/), create a project and API key. Then go to [Google Cloud Console](https://console.cloud.google.com/), switch to the new project, and enable both the **YouTube Data API v3**.

## 4. Configure installation settings

In your subreddit's app settings page (Mod Tools > Installed Apps), configure:

- **YouTube Playlist ID** -- The ID of the playlist to monitor (the part after `list=` in the URL).
- **System Prompt** -- Instructions for Gemini that control the voice and format of generated posts. The user message will include: **Title**, **Published**, **Link**, and **Description** — reference these in your prompt. See `SystemPrompt.example.md` for a sample.
- **Video Link Label** (optional) -- A label for an auto-inserted link to the YouTube video, placed after the generated body. E.g. `Watch on YouTube` produces `[Watch on YouTube](url)`. Leave blank to omit.
- **Prepend Text** (optional) -- Text added to the top of every post body (e.g. a recurring link or disclaimer).
- **Append Text** (optional) -- Text added to the bottom of every post body (e.g. a footer or recurring links).
- **Post Flair** (optional) -- The exact name of a post flair template on your subreddit.
- **Gemini Model** (optional) -- Defaults to `gemini-2.0-flash` (free tier).

## 5. HTTP domains

Both `youtube.googleapis.com` and `generativelanguage.googleapis.com` are on the Devvit global allowlist. No additional domain approval is needed.

# Commands

| Command              | Description                                             |
|----------------------|---------------------------------------------------------|
| `npm run dev`        | Playtest -- installs to test subreddit and streams logs |
| `npm run deploy`     | Upload app to the App Directory                         |
| `npm run launch`     | Publish the app                                         |
| `npm run type-check` | TypeScript type check                                   |

# Redis keys

| Key                       | Purpose                                                          |
|---------------------------|------------------------------------------------------------------|
| `google_api_key`          | Google API key (set via mod menu, not stored in settings)        |
| `video_registry`          | Hash of videoId → VideoRecord JSON (deduplication + status)      |
| `last_episode_guid`       | Video ID of last posted video (legacy, kept for compat)          |
| `last_episode_post_id`    | Reddit post ID of currently pinned post                          |
| `episode_checker_job_id`  | Scheduler job ID (used for clean re-install)                     |
| `force_repost`            | One-shot flag: skip registry check for newest video next run     |
| `check_triggered_by`      | Mod username — used to PM on failure after manual trigger        |
| `regenerate_triggered_by` | Mod username — used to PM on failure after regeneration trigger  |

# Learn more

- [Devvit documentation](https://developers.reddit.com/docs/)
- [Developer portal](https://developers.reddit.com/my/apps)
