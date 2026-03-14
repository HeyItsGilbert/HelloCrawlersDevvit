# AGENTS.md — youtube-gemini-post

Guidance for AI agents and contributors working on this codebase.

---

## What this app does

A [Devvit](https://developers.reddit.com/docs/) app that monitors a YouTube playlist for new videos, calls the Gemini API to generate a Reddit discussion post, submits that post to the subreddit, and rotates the subreddit pin. Both APIs are free-tier. Every configuration value is mod-supplied per-subreddit — no developer secrets are shared.

---

## Repository map

```
src/
  main.ts           Entry point. Registers settings, menu items, scheduler jobs,
                    and the AppInstall trigger. Owns the top-level orchestration loop.
  episodeChecker.ts YouTube Data API v3 client. Fetches playlists and individual
                    videos. Contains the exclusion-keyword filter.
  llmClient.ts      Gemini API client (via OpenAI-compatible endpoint). Parses
                    structured title/body from the model's raw text output.
  postManager.ts    Reddit operations: post submission (link post), flair application,
                    bot author flair, post editing, and pin rotation.
  videoRegistry.ts  Redis hash-backed registry of every video the bot has seen.
                    Stores status (posted/excluded/skipped) and postId per video ID.
  types.ts          Shared interfaces: EpisodeData, GeneratedPost, VideoRecord.

devvit.json         App manifest. Declares entry point and allowed HTTP domains.
package.json        Build scripts and dependencies.
tsconfig.json       TypeScript config (module:ESNext, moduleResolution:Bundler).
SystemPrompt.example.md
                    Sample mod-facing system prompt for Gemini — copy and adapt.
```

---

## Architecture and data flow

### Normal run (every 30 minutes via cron, or manual mod trigger)

```
AppInstall trigger
  └─► scheduler.runJob('check_new_episodes', cron='*/30 * * * *')

check_new_episodes job (src/main.ts)
  │
  ├─ 1. Read all settings from Devvit settings + Google API key from Redis
  ├─ 2. Validate: googleApiKey, youtubePlaylistId, systemPrompt required
  │
  ├─ 3. fetchPlaylistVideos(apiKey, playlistId)                 episodeChecker.ts
  │       UC... channel ID is auto-converted to UU... uploads playlist
  │       GET playlistItems (maxResults=50) → sort by publishedAt (desc)
  │       → return EpisodeData[]
  │
  ├─ 4. For each video newest-first:                            videoRegistry.ts
  │       a. Check force_repost flag — if set, skip registry for first video only
  │       b. getVideoRecord(redis, video.guid) → skip if already registered
  │       c. matchesExclusionFilter(title, excludeKeywords)     episodeChecker.ts
  │            → if matched: setVideoRecord(..., 'excluded'), continue
  │       d. First unregistered non-excluded video = episodeToPost
  │          Remaining unregistered videos → setVideoRecord(..., 'skipped')
  │
  ├─ 5. generateEpisodePost(apiKey, episode, systemPrompt, model)  llmClient.ts
  │       POST OpenAI-compat endpoint → parse first line = title, rest = body
  │
  ├─ 6. Assemble final body:
  │       [prependText, rawBody, videoLink?, appendText].filter(Boolean).join('\n\n')
  │
  ├─ 7. createEpisodePost(reddit, subredditName, title, url, body)  postManager.ts
  │       Submits a link post: url = episode.link, text = assembled body
  ├─ 8. applyFlair(...)           (if flairName set)            postManager.ts
  ├─ 9. applyBotFlair(...)        (if emoji or text set)        postManager.ts
  ├─ 10. managePins(reddit, redis, post.id)                     postManager.ts
  │       Unpin previous (Redis `last_episode_post_id`), pin new post → slot 1
  │
  └─ 11. Persist: setVideoRecord(redis, episode.guid, { status: 'posted', postId })
                  redis.set('last_episode_guid', episode.guid)   ← legacy compat
                  redis.set('last_episode_post_id', post.id)
```

### Regeneration flow (mod menu → "Regenerate latest post")

Re-runs Gemini for the already-processed video and calls `updateEpisodePost` to edit the existing post body text. Does **not** re-submit, re-flair, or re-pin. Uses `fetchYouTubeVideoById` (looks up by video ID directly) rather than the playlist.

---

## Module reference

### `src/types.ts`

Defines the two shared shapes used across all modules.

```typescript
interface EpisodeData {
  guid: string;        // YouTube video ID — primary deduplication key
  title: string;       // Raw video title from YouTube
  description: string; // Raw video description from YouTube
  pubDate: string;     // ISO 8601 publish date
  link: string;        // https://www.youtube.com/watch?v=<videoId>
  episodeNumber?: string; // Not populated by the YouTube APIs; reserved for future use
}

interface GeneratedPost {
  title: string; // First non-empty line of Gemini output
  body: string;  // Everything after the title line
}
```

---

### `src/episodeChecker.ts`

**Exported functions:**

| Function | Signature | Purpose |
|---|---|---|
| `fetchPlaylistVideos` | `(apiKey, playlistId) → Promise<EpisodeData[]>` | Fetches up to 50 items from a playlist, sorts by `publishedAt` descending, returns all as an array. Silently converts `UC...` channel IDs to `UU...` uploads playlist IDs. |
| `fetchYouTubeVideoById` | `(apiKey, videoId) → Promise<EpisodeData \| null>` | Used by the regeneration flow when the video ID is already known |
| `matchesExclusionFilter` | `(title, keywords) → boolean` | Returns true if the title contains any comma-separated keyword (case-insensitive) |

**Key detail:** The playlist endpoint returns up to 50 items in API order, which is not necessarily chronological. The module sorts them by `publishedAt` before returning — do not remove this sort. The Uploads playlist (`UU...`) is always newest-first from the API, making the sort a no-op, but it is kept for correctness when a non-uploads playlist is used.

---

### `src/llmClient.ts`

**Exported function:** `generateEpisodePost(apiKey, episode, systemPrompt, geminiModel) → Promise<GeneratedPost>`

**API endpoint used:**

```
POST https://generativelanguage.googleapis.com/v1beta/openai/chat/completions
```

This is the **OpenAI-compatible** endpoint, not the native Gemini endpoint (`/v1beta/models/{model}:generateContent`). The native endpoint contains a colon in the path that Devvit's HTTP proxy misroutes as gRPC. **Do not change this endpoint.**

**Request format:**

```json
{
  "model": "<geminiModel>",
  "messages": [
    { "role": "system", "content": "<systemPrompt>" },
    { "role": "user",   "content": "Title: ...\nPublished: ...\nLink: ...\nDescription: ..." }
  ],
  "max_tokens": 4096
}
```

**Output parsing convention:** The model's raw text is split on newlines. The first non-empty line becomes the post title; all subsequent lines become the body. The mod's system prompt must instruct the model to output the title on the first line. If the model outputs an empty response, the function throws.

**`finish_reason` guard:** If `finish_reason === 'length'`, a warning is logged. The response is still used; no retry is attempted.

---

### `src/postManager.ts`

**Exported functions:**

| Function | Purpose |
|---|---|
| `createEpisodePost(reddit, subredditName, title, url, body)` | Submits a **link post** — `url` is the YouTube video link, `body` is the generated text. The `text` field is not in Devvit's `SubmitLinkOptions` type but is accepted by the Reddit API. |
| `updateEpisodePost(reddit, postId, body)` | Fetches post then calls `.edit({ text: body })` |
| `applyBotFlair(reddit, subredditName, emoji, text)` | Sets author flair on the app's own account; skips if both emoji and text are empty |
| `applyFlair(reddit, subredditName, postId, flairName)` | Case-insensitive flair template name match; logs error and continues if no match found |
| `managePins(reddit, redis, newPostId)` | Unstickies `last_episode_post_id` (non-fatal if already gone), stickies new post to slot 1 (fatal if it throws) |

**Pin slot:** Always uses sticky slot `1`. Reddit allows 2 sticky slots per subreddit. This bot does not manage slot 2.

---

### `src/main.ts`

**Responsibilities:**

- Registers `Devvit.configure` with `redditAPI`, `redis`, and the two HTTP domains
- Declares all installation-scoped settings (see Settings section below)
- Manages the Google API key: stored in Redis under `google_api_key` via a mod-triggered form (not a Devvit setting, because Devvit settings are readable by mods via the settings UI)
- Registers the `check_new_episodes` scheduler job (the core pipeline)
- Registers the `regenerate_latest_post` scheduler job
- Registers the `AppInstall` trigger (schedules the cron, cancels any previous job first for idempotency)
- Registers four mod menu items: "Set Google API Key", "Check for new videos", "Force post latest video (testing)", and "Regenerate latest post"
- Exports `default Devvit` (required by Devvit platform)

---

## Settings reference

All settings use `SettingScope.Installation`. Each subreddit configures its own values through Mod Tools → Installed Apps.

| Key | Type | Required | Default | Notes |
|---|---|---|---|---|
| `youtubePlaylistId` | string | Yes | — | Playlist ID (`PLxxx`) or channel ID (`UCxxx`) to monitor. Channel IDs are auto-converted to the corresponding Uploads playlist (`UUxxx`). |
| `excludeTitleKeywords` | string | No | `''` | Comma-separated keywords; videos whose titles match any are permanently skipped |
| `geminiModel` | string | No | `gemini-2.0-flash` | Any model ID supported by the OpenAI-compat endpoint |
| `systemPrompt` | paragraph | Yes | — | Full system prompt for Gemini. First line of model output = post title |
| `botFlairEmoji` | string | No | `''` | Emoji portion of the bot's author flair |
| `botFlairText` | string | No | `''` | Text portion of the bot's author flair |
| `videoLinkLabel` | string | No | `''` | If set, inserts `[label](videoUrl)` between rawBody and appendText in the post body |
| `prependText` | paragraph | No | `''` | Prepended to final post body |
| `appendText` | paragraph | No | `''` | Appended to final post body |
| `flairName` | string | No | `''` | Exact post flair template name (case-insensitive match) |

The Google API key (`google_api_key`) is **not** a Devvit setting. It is stored directly in Redis via the "Set Google API Key" mod menu form, keeping it out of the visible Devvit settings UI.

---

## Redis state

| Key | Type | Written by | Read by | Purpose |
|---|---|---|---|---|
| `google_api_key` | string | `apiKeyForm` handler | `check_new_episodes`, `regenerate_latest_post` | Google API key for both YouTube and Gemini |
| `video_registry` | hash | `check_new_episodes` (step 4, 11) | `check_new_episodes` (step 4) | Hash of videoId → `VideoRecord` JSON. Tracks every seen video with status `posted`, `excluded`, or `skipped`. |
| `last_episode_guid` | string | `check_new_episodes` (step 11) | `regenerate_latest_post` | Legacy: YouTube video ID of last posted video — kept for backwards compatibility |
| `last_episode_post_id` | string | `check_new_episodes` (step 11) | `managePins`, `regenerate_latest_post` | Reddit post ID of the currently pinned post |
| `episode_checker_job_id` | string | `AppInstall` trigger | `AppInstall` trigger | Scheduler job ID, used to cancel and re-create on reinstall |
| `force_repost` | string (`'1'`) | "Force post latest video" menu item | `check_new_episodes` (step 4a) | One-shot flag: skip registry check for the newest video on the next run. Deleted immediately when read. |
| `check_triggered_by` | string | "Check for new videos" / "Force post" menu items | `check_new_episodes` error handler | Username of the mod who manually triggered; used to send a PM on failure |
| `regenerate_triggered_by` | string | "Regenerate latest post" menu item | `regenerate_latest_post` error handler | Username of the mod who triggered regeneration; used to send a PM on failure |

**Resetting state:** To force a repost of the latest video, use the "Force post latest video (testing)" mod menu item. To manually clear a video from the registry, delete its field from the `video_registry` hash in Redis.

---

## Scheduler jobs

| Job name | Schedule | Trigger |
|---|---|---|
| `check_new_episodes` | `*/30 * * * *` (cron) | Scheduled at `AppInstall`. Also triggered immediately by "Check for new videos" mod menu item via `runAt: new Date()` |
| `regenerate_latest_post` | No fixed schedule | Only triggered by "Regenerate latest post" mod menu item via `runAt: new Date()` |

The `AppInstall` trigger cancels any existing job ID before scheduling a new one, making reinstalls idempotent.

---

## Devvit platform constraints to keep in mind

1. **HTTP domains must be pre-declared.** `youtube.googleapis.com` and `generativelanguage.googleapis.com` are registered in both `devvit.json` and `Devvit.configure`. Adding a new external API requires adding it to both locations.

2. **No colons in URL paths via the HTTP proxy.** The Gemini native endpoint (`/v1beta/models/{model}:generateContent`) contains a colon that the Devvit proxy misroutes. Always use the OpenAI-compatible endpoint at `/v1beta/openai/chat/completions`.

3. **`context.subredditName` is the source of truth for the subreddit name.** There is no `subredditName` setting. Do not add one.

4. **Scheduler jobs run in the Devvit cloud, not in the user's browser.** `context.ui` (toasts, forms) is not available inside scheduler job `onRun` handlers. Only mod menu `onPress` handlers can call `context.ui.*`.

5. **`SettingScope.Installation` is required** for all per-subreddit settings. `SettingScope.App` is for developer-owned secrets shared across all installs — deliberately not used here.

6. **`reddit.submitPost` creates a link post.** The `url` field is the YouTube video URL. The `text` field (post body) is not declared in Devvit's `SubmitLinkOptions` type but is accepted by the Reddit API — no type suppression is needed in practice.

---

## Logging conventions

All log lines are prefixed with a bracketed module tag so they're filterable in `devvit logs`:

| Prefix | Source |
|---|---|
| `[bot]` | `main.ts` scheduler job handlers |
| `[llmClient]` | `llmClient.ts` |
| `[postManager]` | `postManager.ts` |

Errors use `console.error`; informational output uses `console.log`; warnings use `console.warn`. Error paths inside `catch` blocks log the error and either return (non-fatal) or rethrow (fatal — e.g., pin failure in `managePins`).

---

## How to make common changes

### Add a new installation setting

1. Add the setting definition to `Devvit.addSettings([...])` in `src/main.ts`.
2. Read it in the `check_new_episodes` `onRun` handler alongside the other settings reads.
3. Pass it as a parameter to the relevant module function.
4. Update the Settings reference table in this file and in `README.md`.

### Change the Gemini model or request parameters

Edit `generateEpisodePost` in `src/llmClient.ts`. The `model` and `max_tokens` fields are in the JSON body. The `model` value comes from the `geminiModel` installation setting so mods can change it without a code deploy.

### Change the post body assembly order

The body is assembled in `check_new_episodes` in `src/main.ts`:

```typescript
const body = [prependText, rawBody, videoLink, appendText].filter(Boolean).join('\n\n');
```

Edit the array order or separator here.

### Add a new mod menu item

Use `Devvit.addMenuItem` in `src/main.ts`. For actions that take time, schedule a one-off job with `runAt: new Date()` and show a confirmation toast — do not run long operations directly inside `onPress`.

### Change the pin rotation behavior

`managePins` in `src/postManager.ts` always unstickies the stored `last_episode_post_id` and stickies the new post to slot 1. If you need slot 2 or conditional pinning, modify this function. Note that `managePins` does **not** write to Redis — the caller (`check_new_episodes`) writes `last_episode_post_id` after `managePins` returns.

### Support multiple playlists

Currently one playlist ID per subreddit installation. To fan out, the `check_new_episodes` job would need to accept a list of IDs and call `fetchLatestYouTubeEpisode` once per ID, with separate deduplication keys per playlist.

---

## TypeScript and build notes

- Module system: `"type": "module"` in `package.json`. All imports use `.js` extensions (even for `.ts` source files) per Node ESM + TypeScript bundler conventions.
- `tsconfig.json` uses `"moduleResolution": "Bundler"` (Devvit requirement).
- Compiled `.js` files are committed alongside `.ts` sources. When editing `.ts` files, run `npm run type-check` to verify, and ensure `.js` outputs are updated.
- The `devDependencies` include `dotenv-cli` to inject a `.env` file during `devvit playtest` (the `dev` script). Create a `.env` file if needed for local playtest overrides — it is gitignored.

---

## Commands

| Command | Effect |
|---|---|
| `npm run dev` | `devvit playtest` — installs to test subreddit, streams live logs |
| `npm run deploy` | `devvit upload` — uploads to App Directory (not yet published) |
| `npm run launch` | `devvit publish` — publishes the app publicly |
| `npm run type-check` | TypeScript type check only, no emit |

---

## What not to change without careful review

- **The Gemini HTTP endpoint URL** in `llmClient.ts` — the OpenAI-compatible path is required by the Devvit HTTP proxy.
- **The `*/30 * * * *` cron expression** — Devvit enforces a minimum polling interval for scheduled jobs; going below 30 minutes may be rejected.
- **The `AppInstall` trigger's cancel-before-reschedule pattern** — removing this causes duplicate jobs on reinstall.
- **The Redis key names** — changing them invalidates deduplication state for all existing installs mid-operation.
- **`export default Devvit`** in `main.ts` — required by the Devvit runtime entry point contract.

---

## All Devvit Capabilities

The full documentation can be found via <https://developers.reddit.com/docs/llms-full.txt>
