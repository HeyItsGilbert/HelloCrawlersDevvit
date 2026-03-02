# hellocrawlers

A Devvit mod tool for r/hellocrawlers that automatically detects new [Hello Crawlers podcast](https://www.hellocrawlers.com) episodes, generates an in-character episode discussion post via the Gemini API, and manages pin rotation on the subreddit.

## What it does

- **Polls the YouTube playlist** (`https://www.youtube.com/playlist?list=PL0WMaa8s_mXGb3089AMtiyvordHKAZKi9`) every 30 minutes via a scheduled job
- **Detects new episodes** using Redis to track the last-seen episode video ID
- **Calls Gemini** (gemini-2.0-flash — free tier) with the episode metadata and a custom system prompt to generate a discussion post written in the voice of the Dungeon Crawler Carl System AI
- **Submits the post** to r/hellocrawlers with the "Episode Discussion" flair applied
- **Rotates the pin** — stickies the new post and unstickies the previous episode post

A moderator menu item on the subreddit ("Check for new episodes") lets mods trigger an immediate check at any time.

## Project structure

```
src/
  main.ts              — Entry point: Devvit config, settings, scheduler job, AppInstall trigger, menu action
  episodeChecker.ts    — YouTube Data API v3 playlist fetch, new-episode detection
  claudeClient.ts      — Gemini API integration, post generation
  postManager.ts       — Reddit post creation, flair assignment, pin/unpin logic
  systemPrompt.ts      — Gemini system prompt (DCC System AI voice)
  types.ts             — Shared TypeScript types (EpisodeData, GeneratedPost)
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

This installs the app to your test subreddit and streams logs. At least one installation is required before you can set secrets.

### 3. Set the Google API key

```bash
npx devvit settings set googleApiKey
```

Get a free key from the [Google Cloud Console](https://console.cloud.google.com/). Enable both the **YouTube Data API v3** and the **Generative Language API (Gemini)** for your project. Both are free within their daily quotas (well within usage for a weekly podcast).

### 4. Approve HTTP domains

Both `youtube.googleapis.com` and `generativelanguage.googleapis.com` are already on the Devvit global allow-list — no additional domain approval is needed.

### 5. Create the "Episode Discussion" flair

In r/hellocrawlers subreddit settings, create a post flair with the text **Episode Discussion** (exact match, case-insensitive). The bot looks this up by name at runtime.

## Commands

| Command              | Description                                            |
|----------------------|--------------------------------------------------------|
| `npm run dev`        | Playtest — installs to test subreddit and streams logs |
| `npm run deploy`     | Upload app to the App Directory                        |
| `npm run launch`     | Publish the app                                        |
| `npm run type-check` | TypeScript type check                                  |

## Viewing logs

```bash
npx devvit logs <subreddit-name> --since=1h --verbose
```

## Redis keys

| Key                      | Purpose                                                     |
|--------------------------|-------------------------------------------------------------|
| `last_episode_guid`      | YouTube video ID of the most recently processed episode (deduplication) |
| `last_episode_post_id`   | Reddit post ID of the currently pinned episode discussion   |
| `episode_checker_job_id` | Scheduler job ID (used for clean re-install)                |

## Learn more

- [Devvit documentation](https://developers.reddit.com/docs/)
- [Developer portal](https://developers.reddit.com/my/apps)
- [Hello Crawlers podcast](https://www.hellocrawlers.com)
