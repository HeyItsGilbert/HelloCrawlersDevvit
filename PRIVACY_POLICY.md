# Privacy Policy

**Last updated:** March 1, 2026

## 1. Overview

This Privacy Policy describes how the hellocrawlers Devvit application ("the App") handles information when it operates within the r/hellocrawlers subreddit on Reddit. We are committed to being transparent about the limited data the App processes.

## 2. Information We Collect

The App does not collect or store personal information about Reddit users. The following data is processed during normal operation:

### 2.1 Episode Metadata (Stored in Redis)
- The GUID of the most recently detected Hello Crawlers podcast episode
- This is used solely to detect new episodes and avoid duplicate posts

### 2.2 Reddit Post Data
- The post ID and URL of the most recently pinned episode discussion post
- This is used to manage pin rotation (unpin the old post, pin the new one)

### 2.3 Subreddit Settings
- The Claude API key stored as a Devvit secret (encrypted, never logged or exposed)

All data above is stored within the Devvit/Reddit platform's own infrastructure and is scoped exclusively to the r/hellocrawlers subreddit installation.

## 3. Information We Do Not Collect

The App does **not**:
- Collect, store, or process any Reddit user's personal information (usernames, messages, account data, etc.)
- Track user behavior or browsing activity
- Use cookies or equivalent tracking technologies
- Share any data with third parties beyond what is described in Section 4

## 4. Third-Party Data Sharing

To function, the App sends data to the following third parties:

### 4.1 Anthropic Claude API
When a new episode is detected, the App sends the following to Anthropic's API:
- Episode title, description, and publication date from the public RSS feed
- A system prompt defining the post's tone and format

No personal user data is included in these requests. Anthropic's handling of API data is governed by [Anthropic's Privacy Policy](https://www.anthropic.com/legal/privacy).

### 4.2 Hello Crawlers RSS Feed
The App fetches the publicly available RSS feed at `https://anchor.fm/s/103dbb9d4/podcast/rss` on a scheduled basis. No data is sent to this endpoint beyond a standard HTTP GET request.

### 4.3 Reddit / Devvit Platform
All App actions (post creation, pinning, Redis reads/writes) occur through the Devvit platform and are subject to [Reddit's Privacy Policy](https://www.reddit.com/policies/privacy-policy).

## 5. Data Retention

- **Episode GUID:** Overwritten each time a new episode is detected. Only the most recent GUID is stored.
- **Post ID / URL:** Overwritten each time a new episode post is created.
- **Claude API key:** Managed as a Devvit secret. Deleted if the App is uninstalled from the subreddit.

No historical logs of episode data, API responses, or user interactions are retained by the App.

## 6. Security

The App relies on the Devvit platform's security infrastructure for data storage and secret management. The Claude API key is stored as an encrypted Devvit secret and is never exposed in logs or source code.

## 7. Children's Privacy

The App does not knowingly collect any information from individuals under the age of 13. Access to the App is governed by Reddit's own age requirements and policies.

## 8. Changes to This Policy

We may update this Privacy Policy from time to time. The "Last updated" date at the top of this document will reflect the most recent revision. Continued use of the App after changes are posted constitutes acceptance of the revised Policy.

## 9. Contact

For questions or concerns about this Privacy Policy, please contact the r/hellocrawlers moderation team via [Reddit modmail](https://www.reddit.com/message/compose?to=r/hellocrawlers).
