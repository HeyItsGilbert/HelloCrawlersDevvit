# YouTube + Gemini Post Devvit App

A Devvit app that monitors a YouTube playlist for new videos, generates a Reddit post using the Google Gemini API, and manages pin rotation on the subreddit. Both APIs are free-tier, making this a zero-cost automation for any community.

Demo: https://www.youtube.com/watch?v=Xdm_pJxI6Yo

## What it does

- **Monitors a YouTube playlist** every 30 minutes via a scheduled job
- **Detects new videos** using Redis to track the last-seen video ID
- **Calls Gemini** with video metadata and a mod-supplied system prompt to generate a discussion post
- **Submits the post** to the subreddit with optional flair
- **Rotates the pin** -- stickies the new post and unstickies the previous one

A moderator menu item ("Check for new videos") lets mods trigger an immediate check at any time.

## API Key

1. Navigate to your subreddit.
2. Open the **Mod Tools** menu and select **Set Google API Key**.
3. Paste your key into the masked input and click **Save**.

The key is stored in the subreddit's Redis store. To get a key, visit the visit the [AI Studio](https://aistudio.google.com/), create a project and API key. Then go to [Google Cloud Console](https://console.cloud.google.com/), switch to the new project, and enable both the **YouTube Data API v3**.

## Settings

All settings are configured per subreddit in the app's installation settings.

| Name | Type | Secret | Default | Description |
|------|------|--------|---------|-------------|
| `youtubePlaylistId` | string | No | -- | YouTube playlist ID to monitor |
| `geminiModel` | string | No | `gemini-2.0-flash` | Gemini model for post generation |
| `systemPrompt` | paragraph | No | -- | Full system prompt for Gemini (controls voice, structure, rules). The user message will include: **Title**, **Published**, **Link**, and **Description**. |
| `botFlairEmoji` | string | No | *(empty)* | Emoji for the bot's author flair on this subreddit, e.g. `🎙️` |
| `botFlairText` | string | No | *(empty)* | Text for the bot's author flair, e.g. `Podcast Bot`. Combined with emoji if both are set. |
| `videoLinkLabel` | string | No | *(empty)* | If set, inserts a markdown link to the video between the body and append text, e.g. `Watch on YouTube` → `[Watch on YouTube](url)` |
| `prependText` | paragraph | No | *(empty)* | Text prepended to every generated post body (e.g. recurring links, disclaimers) |
| `appendText` | paragraph | No | *(empty)* | Text appended to every generated post body (e.g. footers, recurring links) |
| `flairName` | string | No | *(empty)* | Post flair to apply (exact name match, optional) |

## Project structure

```
src/
  main.ts              -- Entry point: settings, scheduler, triggers, menu actions
  episodeChecker.ts    -- YouTube Data API: fetch latest video from playlist
  llmClient.ts         -- Gemini API: generate post with mod-supplied prompt
  postManager.ts       -- Reddit post creation, flair, pin management
  types.ts             -- Shared TypeScript types (EpisodeData, GeneratedPost)
```

## Developer Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Start a playtest session

```bash
npm run dev
```

This installs the app to your test subreddit and streams logs.

### 3. Set the Google API Key

Each subreddit stores its own Google API key via a mod menu action.

1. Navigate to your subreddit.
2. Open the **Mod Tools** menu and select **Set Google API Key**.
3. Paste your key into the masked input and click **Save**.

The key is stored in the subreddit's Redis store. To get a key, visit the visit the [AI Studio](https://aistudio.google.com/), create a project and API key. Then go to [Google Cloud Console](https://console.cloud.google.com/), switch to the new project, and enable both the **YouTube Data API v3**.

### 4. Configure installation settings

In your subreddit's app settings page (Mod Tools > Installed Apps), configure:

- **YouTube Playlist ID** -- The ID of the playlist to monitor (the part after `list=` in the URL).
- **System Prompt** -- Instructions for Gemini that control the voice and format of generated posts. The user message will include: **Title**, **Published**, **Link**, and **Description** — reference these in your prompt. See `SystemPrompt.example.md` for a sample.
- **Video Link Label** (optional) -- A label for an auto-inserted link to the YouTube video, placed after the generated body. E.g. `Watch on YouTube` produces `[Watch on YouTube](url)`. Leave blank to omit.
- **Prepend Text** (optional) -- Text added to the top of every post body (e.g. a recurring link or disclaimer).
- **Append Text** (optional) -- Text added to the bottom of every post body (e.g. a footer or recurring links).
- **Post Flair** (optional) -- The exact name of a post flair template on your subreddit.
- **Gemini Model** (optional) -- Defaults to `gemini-2.0-flash` (free tier).

### 5. HTTP domains

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
