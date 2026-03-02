# youtube-gemini-post

A Devvit app that monitors a YouTube playlist for new videos, generates a Reddit post using the Google Gemini API, and manages pin rotation on the subreddit. Both APIs are free-tier, making this a zero-cost automation for any community.

## What it does

- **Monitors a YouTube playlist** every 30 minutes via a scheduled job
- **Detects new videos** using Redis to track the last-seen video ID
- **Calls Gemini** with video metadata and a mod-supplied system prompt to generate a discussion post
- **Submits the post** to the subreddit with optional flair
- **Rotates the pin** -- stickies the new post and unstickies the previous one
- **Mop tool** -- bulk comment removal for moderators (comment and post context menus)

A moderator menu item ("Check for new videos") lets mods trigger an immediate check at any time.

## Settings

All settings are configured per subreddit in the app's installation settings.

| Name | Type | Secret | Default | Description |
|------|------|--------|---------|-------------|
| `googleApiKey` | string | Yes | -- | Google API key (YouTube Data API + Gemini) |
| `youtubePlaylistId` | string | No | -- | YouTube playlist ID to monitor |
| `geminiModel` | string | No | `gemini-2.0-flash` | Gemini model for post generation |
| `systemPrompt` | paragraph | No | -- | Full system prompt for Gemini (controls voice, structure, rules) |
| `flairName` | string | No | *(empty)* | Post flair to apply (exact name match, optional) |

## Project structure

```
src/
  main.ts              -- Entry point: settings, scheduler, triggers, menu actions
  episodeChecker.ts    -- YouTube Data API: fetch latest video from playlist
  claudeClient.ts      -- Gemini API: generate post with mod-supplied prompt
  postManager.ts       -- Reddit post creation, flair, pin management
  types.ts             -- Shared TypeScript types (EpisodeData, GeneratedPost)
  nuke.ts              -- Comment moderation tool (Mop)
```

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Start a playtest session

```bash
npm run dev
```

This installs the app to your test subreddit and streams logs.

### 3. Configure settings

In your subreddit's app settings page, configure:

- **Google API Key** -- Get a free key from the [Google Cloud Console](https://console.cloud.google.com/). Enable both the **YouTube Data API v3** and the **Generative Language API (Gemini)** for your project.
- **YouTube Playlist ID** -- The ID of the playlist to monitor (the part after `list=` in the URL).
- **System Prompt** -- Instructions for Gemini that control the voice and format of generated posts. See `SystemPrompt.example.md` for a sample.
- **Post Flair** (optional) -- The exact name of a post flair template on your subreddit.
- **Gemini Model** (optional) -- Defaults to `gemini-2.0-flash` (free tier).

### 4. HTTP domains

Both `youtube.googleapis.com` and `generativelanguage.googleapis.com` are on the Devvit global allowlist. No additional domain approval is needed.

## Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Playtest -- installs to test subreddit and streams logs |
| `npm run deploy` | Upload app to the App Directory |
| `npm run launch` | Publish the app |
| `npm run type-check` | TypeScript type check |

## Redis keys

| Key | Purpose |
|-----|---------|
| `last_episode_guid` | Video ID of last processed video (deduplication) |
| `last_episode_post_id` | Reddit post ID of currently pinned post |
| `episode_checker_job_id` | Scheduler job ID (used for clean re-install) |

## Learn more

- [Devvit documentation](https://developers.reddit.com/docs/)
- [Developer portal](https://developers.reddit.com/my/apps)
