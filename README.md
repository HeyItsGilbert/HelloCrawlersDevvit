# YouTube + Gemini Post Devvit App

A Devvit app that monitors a YouTube playlist for new videos, generates a Reddit post using the Google Gemini API, and manages pin rotation on the subreddit. Both APIs are free-tier, making this a zero-cost automation for any community.

Demo: <https://www.youtube.com/watch?v=Xdm_pJxI6Yo>

## What it does

- **Monitors a YouTube playlist** every 30 minutes via a scheduled job
- **Detects new videos** using a per-video Redis registry to track every seen video
- **Calls Gemini** with video metadata and a mod-supplied system prompt to generate a discussion post
- **Submits a link post** to the subreddit — the post links directly to the YouTube video, with the generated text as the post body
- **Rotates the pin** — pins the new post and unpins the previous one
- **Notifies the triggering mod by PM** if a manually triggered action fails

Moderator menu items let mods trigger an immediate check ("Check for new videos"), force a re-post of the latest video bypassing deduplication ("Force post latest video (testing)"), or regenerate the body of the latest post ("Regenerate latest post"). If any manual action fails, the triggering mod receives a Reddit PM with the error details. Scheduled (cron) runs are self-healing — state is only persisted on success, so the next 30-minute tick retries automatically.

## API Key

1. Navigate to your subreddit.
2. Open the **Mod Tools** menu and select **Set Google API Key**.
3. Paste your key into the masked input and click **Save**.

The key is stored in the subreddit's Redis store. To get a key, visit the visit the [AI Studio](https://aistudio.google.com/), create a project and API key. Then go to [Google Cloud Console](https://console.cloud.google.com/), switch to the new project, and enable both the **YouTube Data API v3**.

## Settings

All settings are configured per subreddit in the app's installation settings.

| Name                | Type      | Secret | Default            | Description                                                                                                                                               |
|---------------------|-----------|--------|--------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------|
| `youtubePlaylistId` | string    | No     | --                 | YouTube playlist ID to monitor                                                                                                                            |
| `geminiModel`       | string    | No     | `gemini-2.0-flash` | Gemini model for post generation                                                                                                                          |
| `systemPrompt`      | paragraph | No     | --                 | Full system prompt for Gemini (controls voice, structure, rules). The user message will include: **Title**, **Published**, **Link**, and **Description**. |
| `botFlairEmoji`     | string    | No     | *(empty)*          | Emoji for the bot's author flair on this subreddit, e.g. `🎙️`                                                                                            |
| `botFlairText`      | string    | No     | *(empty)*          | Text for the bot's author flair, e.g. `Podcast Bot`. Combined with emoji if both are set.                                                                 |
| `videoLinkLabel`    | string    | No     | *(empty)*          | If set, inserts a markdown link to the video between the body and append text, e.g. `Watch on YouTube` → `[Watch on YouTube](url)`                        |
| `prependText`       | paragraph | No     | *(empty)*          | Text prepended to every generated post body (e.g. recurring links, disclaimers)                                                                           |
| `appendText`        | paragraph | No     | *(empty)*          | Text appended to every generated post body (e.g. footers, recurring links)                                                                                |
| `flairName`         | string    | No     | *(empty)*          | Post flair to apply (exact name match, optional)                                                                                                          |

## Developers

See the [Developer](https://github.com/HeyItsGilbert/YouTubeGeminiPostDevvit/blob/main/DEVELOP.md) docs on the GitHub.
