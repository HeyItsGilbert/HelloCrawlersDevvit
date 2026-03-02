# Hello Crawlers — Automated Episode Discussion Bot: Implementation Plan

## Overview

Extend the existing `hellocrawlers` Devvit mod tool to automatically detect new podcast episodes from the Hello Crawlers RSS feed, generate an in-character discussion post via the Claude API, publish it to r/hellocrawlers with appropriate flair, and manage pin rotation.

---

## Architecture

```
src/
  main.ts              ← Existing entry point; add scheduler registration + menu trigger
  nuke.ts              ← Existing mod tool (unchanged)
  episodeChecker.ts    ← NEW: RSS fetch, parse, new-episode detection
  claudeClient.ts      ← NEW: Claude API call with system prompt
  postManager.ts       ← NEW: Reddit post creation, flair, pin/unpin logic
  systemPrompt.ts      ← NEW: Exports the system prompt string (from SystemPrompt.md)
  types.ts             ← NEW: Shared types (EpisodeData, etc.)
```

---

## Phase 0 — Configuration & Secrets

### 0.1 Enable required Devvit capabilities

In `src/main.ts`, update the `Devvit.configure()` block:

```typescript
Devvit.configure({
  redditAPI: true,
  redis: true,
  http: {
    domains: [
      'anchor.fm',           // RSS feed host
      'api.anthropic.com',   // Claude API
    ],
  },
});
```

> **Domain allow-listing:** Both `anchor.fm` and `api.anthropic.com` will be submitted for review on upload/playtest. `api.anthropic.com` is not on the global allowlist, so it must be explicitly requested. If Anchor redirects to another domain (e.g., `rss.art19.com`, `cdn.simplecast.com`), that domain must also be listed — test the RSS URL with `curl -Lv` to confirm the final domain.

### 0.2 Register app-level secret for Claude API key

Add in `src/main.ts` (before the scheduler job):

```typescript
import { Devvit, SettingScope } from '@devvit/public-api';

Devvit.addSettings([
  {
    type: 'string',
    name: 'claudeApiKey',
    label: 'Anthropic Claude API Key',
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
```

After first playtest, set the secret:

```bash
npx devvit settings set claudeApiKey
```

---

## Phase 1 — RSS Feed Parsing (`episodeChecker.ts`)

### 1.1 Fetch the RSS feed

```
RSS URL: https://anchor.fm/s/103dbb9d4/podcast/rss
```

Use the global `fetch` available in Devvit server-side code:

```typescript
const RSS_URL = 'https://anchor.fm/s/103dbb9d4/podcast/rss';

export async function fetchRssFeed(): Promise<string> {
  const response = await fetch(RSS_URL);
  if (!response.ok) {
    throw new Error(`RSS fetch failed: ${response.status}`);
  }
  return response.text();
}
```

### 1.2 Parse the XML (no external libraries)

Devvit runs in a restricted environment — we cannot install arbitrary npm packages. We must parse the RSS XML with string/regex operations or a basic XML-to-object approach using the built-in DOMParser-like APIs if available, or simple regex extraction.

**Strategy:** Extract the first `<item>` block (most recent episode) and pull out:

| Field | XML Tag | Purpose |
|-------|---------|---------|
| `guid` | `<guid>` | Unique ID to detect new episodes |
| `title` | `<title>` | Episode title |
| `description` | `<description>` | Episode description/show notes (HTML-encoded) |
| `pubDate` | `<pubDate>` | Publish date |
| `link` | `<link>` | Episode URL |
| `enclosure.url` | `<enclosure url="...">` | Audio file URL (optional) |
| `itunes:episode` | `<itunes:episode>` | Episode number (optional) |

```typescript
export interface EpisodeData {
  guid: string;
  title: string;
  description: string;  // cleaned/decoded HTML
  pubDate: string;
  link: string;
  episodeNumber?: string;
}

export function parseLatestEpisode(xml: string): EpisodeData | null {
  // Extract first <item>...</item>
  const itemMatch = xml.match(/<item>([\s\S]*?)<\/item>/);
  if (!itemMatch) return null;
  const item = itemMatch[1];

  const extract = (tag: string): string => {
    // Handle CDATA: <tag><![CDATA[...]]></tag>
    const cdataMatch = item.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`));
    if (cdataMatch) return cdataMatch[1].trim();
    // Handle plain text: <tag>...</tag>
    const plainMatch = item.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
    return plainMatch ? plainMatch[1].trim() : '';
  };

  return {
    guid: extract('guid'),
    title: extract('title'),
    description: cleanHtml(extract('description')),
    pubDate: extract('pubDate'),
    link: extract('link'),
    episodeNumber: extract('itunes:episode') || undefined,
  };
}
```

### 1.3 HTML entity decoding & stripping

The `<description>` field often contains HTML. Write a `cleanHtml()` helper to:

- Decode `&amp;`, `&lt;`, `&gt;`, `&quot;`, `&#39;`, `&nbsp;`
- Strip HTML tags (keep text content)
- Collapse whitespace

This cleaned description is what gets sent to Claude as context.

### 1.4 New-episode detection via Redis

**Redis keys used:**

| Key | Type | Purpose |
|-----|------|---------|
| `last_episode_guid` | string | GUID of most recent processed episode |
| `last_episode_post_id` | string | Reddit post ID (`t3_xxx`) of the current pinned episode post |

```typescript
export async function isNewEpisode(
  redis: RedisClient,
  episode: EpisodeData
): Promise<boolean> {
  const lastGuid = await redis.get('last_episode_guid');
  return lastGuid !== episode.guid;
}
```

---

## Phase 2 — Claude API Integration (`claudeClient.ts`)

### 2.1 System prompt

Export the system prompt from `SystemPrompt.md` as a TypeScript string constant in `src/systemPrompt.ts`. This keeps it maintainable:

```typescript
export const SYSTEM_PROMPT = `You are the System AI from the Dungeon Crawler Carl universe...`;
// (full content of SystemPrompt.md)
```

### 2.2 Claude API call

```typescript
import { SYSTEM_PROMPT } from './systemPrompt.js';

const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL = 'claude-sonnet-4-20250514';

export interface ClaudeResponse {
  title: string;   // first line of response
  body: string;    // rest of the response
}

export async function generateEpisodePost(
  apiKey: string,
  episode: EpisodeData
): Promise<ClaudeResponse> {
  const userMessage = buildUserMessage(episode);

  const response = await fetch(CLAUDE_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [
        { role: 'user', content: userMessage },
      ],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Claude API error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const fullText: string = data.content[0].text;

  // Split title from body (first line is title per system prompt instructions)
  const [titleLine, ...bodyLines] = fullText.split('\n');
  const title = titleLine
    .replace(/^\[Episode Discussion\]\s*/i, '')
    .trim();

  return {
    title: `[Episode Discussion] ${title || episode.title}`,
    body: bodyLines.join('\n').trim(),
  };
}
```

### 2.3 User message construction

```typescript
function buildUserMessage(episode: EpisodeData): string {
  return [
    `New episode released:`,
    ``,
    `**Episode Title:** ${episode.title}`,
    episode.episodeNumber ? `**Episode Number:** ${episode.episodeNumber}` : '',
    `**Published:** ${episode.pubDate}`,
    `**Link:** ${episode.link}`,
    ``,
    `**Episode Description (cleaned):**`,
    episode.description,
    ``,
    `Please generate the full discussion post (title + body) following the post structure in your instructions.`,
  ].filter(Boolean).join('\n');
}
```

---

## Phase 3 — Reddit Post Management (`postManager.ts`)

### 3.1 Submit the post

```typescript
export async function createEpisodePost(
  reddit: RedditAPIClient,
  subredditName: string,
  title: string,
  body: string,
): Promise<Post> {
  const post = await reddit.submitPost({
    title,
    subredditName,
    text: body,            // selftext/markdown body
    sendreplies: true,
  });
  return post;
}
```

### 3.2 Apply "Episode Discussion" flair

The flair must already exist on the subreddit. Apply it by flair text:

```typescript
export async function applyFlair(
  reddit: RedditAPIClient,
  subredditName: string,
  postId: string,
): Promise<void> {
  // Get available flairs
  const flairs = await reddit.getPostFlairTemplates(subredditName);
  const episodeFlair = flairs.find(
    (f) => f.text?.toLowerCase() === 'episode discussion'
  );

  if (episodeFlair) {
    await reddit.setPostFlair({
      subredditName,
      postId,
      flairTemplateId: episodeFlair.id,
    });
  } else {
    console.warn('⚠ "Episode Discussion" flair template not found on subreddit');
  }
}
```

> **Pre-requisite:** Create an "Episode Discussion" post flair in subreddit settings before running the bot.

### 3.3 Pin new post & unpin previous

Reddit allows a maximum of **2 sticky posts**. We use sticky slot 1 for episode discussions.

```typescript
export async function managePins(
  reddit: RedditAPIClient,
  redis: RedisClient,
  newPostId: string,
): Promise<void> {
  // Unpin the previous episode post
  const previousPostId = await redis.get('last_episode_post_id');
  if (previousPostId) {
    try {
      const prevPost = await reddit.getPostById(previousPostId);
      await prevPost.unsticky();
      console.log(`Unpinned previous post: ${previousPostId}`);
    } catch (e) {
      console.warn(`Could not unpin previous post ${previousPostId}: ${e}`);
    }
  }

  // Pin the new post
  const newPost = await reddit.getPostById(newPostId);
  await newPost.sticky();
  console.log(`Pinned new post: ${newPostId}`);
}
```

---

## Phase 4 — Scheduler Job (in `main.ts`)

### 4.1 Register the scheduler job

```typescript
Devvit.addSchedulerJob({
  name: 'check_new_episodes',
  onRun: async (_event, context) => {
    const { redis, reddit, settings } = context;

    try {
      // 1. Fetch & parse RSS
      const xml = await fetchRssFeed();
      const episode = parseLatestEpisode(xml);
      if (!episode) {
        console.log('No episodes found in RSS feed');
        return;
      }

      // 2. Check if this is a new episode
      if (!(await isNewEpisode(redis, episode))) {
        console.log(`No new episode. Current: ${episode.guid}`);
        return;
      }

      console.log(`🆕 New episode detected: ${episode.title}`);

      // 3. Get Claude API key
      const claudeApiKey = await settings.get<string>('claudeApiKey');
      if (!claudeApiKey) {
        console.error('Claude API key not configured');
        return;
      }

      // 4. Generate post content via Claude
      const { title, body } = await generateEpisodePost(claudeApiKey, episode);

      // 5. Get subreddit name
      const subredditName =
        (await settings.get<string>('subredditName')) || 'hellocrawlers';

      // 6. Create the Reddit post
      const post = await createEpisodePost(reddit, subredditName, title, body);
      console.log(`📝 Created post: ${post.id}`);

      // 7. Apply flair
      await applyFlair(reddit, subredditName, post.id);

      // 8. Pin new / unpin old
      await managePins(reddit, redis, post.id);

      // 9. Persist state
      await redis.set('last_episode_guid', episode.guid);
      await redis.set('last_episode_post_id', post.id);

      console.log(`✅ Episode post complete: "${title}"`);
    } catch (error) {
      console.error('Episode checker failed:', error);
    }
  },
});
```

### 4.2 Schedule the recurring job (on app install)

Use a trigger to start the cron when the app is installed on a subreddit:

```typescript
import { Devvit, type OnTriggerEvent } from '@devvit/public-api';

Devvit.addTrigger({
  event: 'AppInstall',
  onEvent: async (_event: OnTriggerEvent, context) => {
    const jobId = await context.scheduler.runJob({
      name: 'check_new_episodes',
      cron: '*/30 * * * *',  // Every 30 minutes
    });
    await context.redis.set('episode_checker_job_id', jobId);
    console.log(`Scheduled episode checker: job ${jobId}`);
  },
});
```

### 4.3 Manual trigger (menu action)

Add a mod menu action to force-check immediately (useful for testing):

```typescript
Devvit.addMenuItem({
  label: 'Check for new episodes',
  description: 'Manually check the Hello Crawlers RSS feed for new episodes',
  location: 'subreddit',
  forUserType: 'moderator',
  onPress: async (_event, context) => {
    context.ui.showToast('Checking for new episodes...');

    // Schedule a one-off job that runs immediately
    await context.scheduler.runJob({
      name: 'check_new_episodes',
      runAt: new Date(),
    });

    context.ui.showToast('Episode check triggered. Watch logs for results.');
  },
});
```

---

## Phase 5 — Error Handling & Edge Cases

| Scenario | Handling |
|----------|----------|
| RSS feed down / timeout | Catch error, log, retry on next cron cycle |
| Claude API rate-limited or down | Catch error, log, retry on next cycle |
| Claude returns malformed output | Fall back to using the episode title directly and a minimal template body |
| "Episode Discussion" flair missing | Log warning; post is still created without flair |
| No previous pinned post (first run) | Skip unpin step; only pin the new post |
| Duplicate detection race condition | Redis `last_episode_guid` acts as idempotency key; checked before API calls |
| RSS returns same episode GUID | Early return — no action taken |
| HTTP fetch 30s timeout (Devvit limit) | Ensure both RSS + Claude calls complete within budget; Claude's `max_tokens: 1024` keeps response fast |
| Post created but flair/pin fails | Post still exists; log error. Next cycle won't reprocess (GUID already saved). Mod can manually fix via menu action. |

**Recommendation:** Save `last_episode_guid` *after* successful post creation to avoid losing the post if something fails mid-flow. If flair or pin fails, the post is still published — these are recoverable by a moderator.

---

## Phase 6 — Testing Strategy

### 6.1 Local playtest

```bash
npm run dev
```

This starts a playtest session on the test subreddit. Use the manual "Check for new episodes" menu action to trigger immediately.

### 6.2 Test with logs

```bash
npx devvit logs <test-subreddit> --since=1h --verbose
```

### 6.3 Test checklist

- [ ] RSS feed fetches successfully
- [ ] XML parsing extracts correct episode data
- [ ] New episode detection works (first run + subsequent runs)
- [ ] Claude API call succeeds with valid response
- [ ] Post is created with correct title and body
- [ ] "Episode Discussion" flair is applied
- [ ] New post is pinned
- [ ] Previous post is unpinned
- [ ] Redis state is persisted correctly
- [ ] Cron job runs on schedule
- [ ] Manual trigger works from subreddit menu
- [ ] Error cases are logged cleanly (RSS down, API key missing, etc.)

### 6.4 Dry-run mode (optional enhancement)

Consider adding an installation setting `dryRun` (boolean) that, when enabled, logs the would-be post content without actually creating it. Useful for validating Claude's output before going live.

---

## Domain Allowlist Summary

| Domain | Purpose | Global Allowlist? |
|--------|---------|-------------------|
| `anchor.fm` | RSS feed | **No** — must request |
| `api.anthropic.com` | Claude API | **No** — must request |

> Test the RSS URL to confirm the final resolved domain. If it redirects (e.g., to `podcasters.spotify.com`), list that domain too.

---

## Redis Key Reference

| Key | Value | Purpose |
|-----|-------|---------|
| `last_episode_guid` | string (GUID) | Deduplication — tracks most recent processed episode |
| `last_episode_post_id` | string (`t3_xxx`) | Post ID of the currently pinned episode discussion |
| `episode_checker_job_id` | string (job ID) | Scheduler job ID for potential cancellation |

---

## Settings Reference

| Name | Scope | Type | Secret | Purpose |
|------|-------|------|--------|---------|
| `claudeApiKey` | App (global) | string | **Yes** | Anthropic API key |
| `subredditName` | Installation | string | No | Target subreddit (default: `hellocrawlers`) |

---

## File-by-File Implementation Order

| # | File | Action | Depends On |
|---|------|--------|------------|
| 1 | `src/types.ts` | Create shared types (`EpisodeData`, etc.) | — |
| 2 | `src/systemPrompt.ts` | Export system prompt as string constant | `SystemPrompt.md` |
| 3 | `src/episodeChecker.ts` | RSS fetch, XML parse, `cleanHtml`, `isNewEpisode` | types.ts |
| 4 | `src/claudeClient.ts` | Claude API call, response parsing | types.ts, systemPrompt.ts |
| 5 | `src/postManager.ts` | `createEpisodePost`, `applyFlair`, `managePins` | types.ts |
| 6 | `src/main.ts` | Wire everything: `Devvit.configure`, settings, scheduler job, trigger, menu action | All above |
| 7 | `SystemPrompt.md` | No changes needed | — |
| 8 | `src/nuke.ts` | No changes needed | — |

---

## Deployment Checklist

1. **Create flair:** Ensure "Episode Discussion" post flair exists on r/hellocrawlers
2. **Set API key:** `npx devvit settings set claudeApiKey` (after first playtest)
3. **Verify domains:** Confirm `anchor.fm` and `api.anthropic.com` are approved in Developer Settings
4. **Test manually:** Use the "Check for new episodes" menu action on the test subreddit
5. **Review logs:** `npx devvit logs <subreddit> --since=1h`
6. **Deploy:** `npm run deploy` (upload) → `npm run launch` (publish)

---

## Future Enhancements (Optional)

- **Dry-run mode** — Installation setting to preview posts without publishing
- **Configurable cron** — Let mods adjust check frequency via settings
- **Episode history** — Store all processed episode GUIDs in a Redis sorted set for audit
- **Notification** — Send modmail when a new episode post is created
- **Retry queue** — If Claude fails, queue the episode GUID for retry on next cycle
- **Multiple podcast support** — Generalize to support multiple RSS feed URLs
