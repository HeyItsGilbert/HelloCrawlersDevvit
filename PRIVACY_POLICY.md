# Privacy Policy

**Last updated:** March 1, 2026

## 1. Overview

This Privacy Policy describes how the youtube-gemini-post Devvit application ("the App") handles information when it operates within the installing subreddit on Reddit. We are committed to being transparent about the limited data the App processes.

## 2. Information We Collect

The App does not collect or store personal information about Reddit users. The following data is processed during normal operation:

### 2.1 Video Metadata (Stored in Redis)

- The ID of the most recently detected YouTube video from the configured playlist
- This is used solely to detect new videos and avoid duplicate posts

### 2.2 Reddit Post Data

- The post ID of the most recently pinned video discussion post
- This is used to manage pin rotation (unpin the old post, pin the new one)

### 2.3 Subreddit Settings

- The Google Gemini API key, supplied per-installation by the subreddit's moderators, stored as a Devvit setting (encrypted, never logged or exposed)

All data above is stored within the Devvit/Reddit platform's own infrastructure and is scoped exclusively to the installing subreddit's installation.

## 3. Information We Do Not Collect

The App does **not**:

- Collect, store, or process any Reddit user's personal information (usernames, messages, account data, etc.)
- Track user behavior or browsing activity
- Use cookies or equivalent tracking technologies
- Share any data with third parties beyond what is described in Section 4

## 4. Third-Party Data Sharing

To function, the App sends data to the following third parties:

### 4.1 Google Gemini API

When a new video is detected, the App sends the following to Google's Gemini API using the mod-supplied API key:

- Video title, description, and publication date from the YouTube Data API
- A system prompt defining the post's tone and format

No personal user data is included in these requests. Google's handling of API data is governed by [Google's Privacy Policy](https://policies.google.com/privacy).

### 4.2 YouTube Data API

The App fetches public YouTube playlist data via the YouTube Data API on a scheduled basis. Only standard API requests are made to retrieve video metadata. Google's handling of this data is governed by [Google's Privacy Policy](https://policies.google.com/privacy).

### 4.3 Reddit / Devvit Platform

All App actions (post creation, pinning, Redis reads/writes) occur through the Devvit platform and are subject to [Reddit's Privacy Policy](https://www.reddit.com/policies/privacy-policy).

## 5. Data Retention

- **Video ID:** Overwritten each time a new video is detected. Only the most recent ID is stored.
- **Post ID:** Overwritten each time a new video post is created.
- **Google Gemini API key:** Managed as a per-installation Devvit setting. Deleted if the App is uninstalled from the subreddit.

No historical logs of video data, API responses, or user interactions are retained by the App.

## 6. Security

The App relies on the Devvit platform's security infrastructure for data storage and secret management. The Google Gemini API key is stored as an encrypted Devvit setting and is never exposed in logs or source code.

## 7. Children's Privacy

The App does not knowingly collect any information from individuals under the age of 13. Access to the App is governed by Reddit's own age requirements and policies.

## 8. Changes to This Policy

We may update this Privacy Policy from time to time. The "Last updated" date at the top of this document will reflect the most recent revision. Continued use of the App after changes are posted constitutes acceptance of the revised Policy.

## 9. Contact

For questions or concerns about this Privacy Policy, please contact the subreddit moderation team via Reddit modmail.
