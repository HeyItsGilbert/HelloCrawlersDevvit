import { Devvit } from '@devvit/public-api';

// ----- Types ----------------------------------------------------------------

type RedditClient = Devvit.Context['reddit'];
type RedisClient = Devvit.Context['redis'];

// ----- Post creation --------------------------------------------------------

/**
 * Submit a link post pointing to the episode URL with generated body text.
 * The `text` field is undocumented on link posts but accepted by the API.
 */
export async function createEpisodePost(
  reddit: RedditClient,
  subredditName: string,
  title: string,
  url: string,
  body: string
) {
  const post = await reddit.submitPost({
    title,
    subredditName,
    url,
    text: body,
  });
  return post;
}

// ----- Bot identity ---------------------------------------------------------

/**
 * Set the bot's author flair on the subreddit so each community can give it
 * a unique display name and emoji icon.
 */
export async function applyBotFlair(
  reddit: RedditClient,
  subredditName: string,
  emoji: string,
  text: string
): Promise<void> {
  const flairText = [emoji, text].filter(Boolean).join(' ');
  if (!flairText) return;

  try {
    const botUser = await reddit.getAppUser();
    await reddit.setUserFlair({
      subredditName,
      username: botUser.username,
      text: flairText,
    });
    console.log(`[postManager] Set bot flair to "${flairText}" for u/${botUser.username}`);
  } catch (err) {
    console.error(`[postManager] Failed to set bot flair: ${err}`);
  }
}

// ----- Post editing ---------------------------------------------------------

/**
 * Edit the body text of an existing post.
 */
export async function updateEpisodePost(
  reddit: RedditClient,
  postId: string,
  body: string
): Promise<void> {
  const post = await reddit.getPostById(postId);
  await post.edit({ text: body });
}

// ----- Flair ----------------------------------------------------------------

/**
 * Apply a flair to a post by matching the flair template name.
 * If flairName is empty or not found, the post remains unflaired.
 */
export async function applyFlair(
  reddit: RedditClient,
  subredditName: string,
  postId: string,
  flairName: string
): Promise<void> {
  if (!flairName) return;

  try {
    const flairs = await reddit.getPostFlairTemplates(subredditName);
    const match = flairs.find(
      (f) => (f.text ?? '').toLowerCase().trim() === flairName.toLowerCase().trim()
    );

    if (!match) {
      console.error(
        `[postManager] Flair "${flairName}" not found on subreddit. ` +
        'Post will remain unflaired.'
      );
      return;
    }

    await reddit.setPostFlair({
      subredditName,
      postId,
      flairTemplateId: match.id,
    });

    console.log(`[postManager] Applied flair "${match.text}" to ${postId}`);
  } catch (err) {
    console.error(`[postManager] Failed to apply flair: ${err}`);
  }
}

// ----- Pin management -------------------------------------------------------

/**
 * Unpin the previous post (if any) and pin the new one.
 *
 * Reddit allows a maximum of 2 sticky posts. This bot uses slot 1.
 * The previous post ID is read from Redis key `last_episode_post_id`.
 */
export async function managePins(
  reddit: RedditClient,
  redis: RedisClient,
  newPostId: string
): Promise<void> {
  // Unpin the previous post
  const previousPostId = await redis.get('last_episode_post_id');
  if (previousPostId && previousPostId !== newPostId) {
    try {
      const prevPost = await reddit.getPostById(previousPostId);
      await prevPost.unsticky();
      console.log(`[postManager] Unpinned previous post: ${previousPostId}`);
    } catch (err) {
      // The post may have been deleted or already unstickied — non-fatal
      console.error(
        `[postManager] Could not unpin previous post ${previousPostId}: ${err}`
      );
    }
  }

  // Pin the new post to sticky slot 1
  try {
    const newPost = await reddit.getPostById(newPostId);
    await newPost.sticky(1);
    console.log(`[postManager] Pinned new post: ${newPostId}`);
  } catch (err) {
    console.error(`[postManager] Failed to pin new post ${newPostId}: ${err}`);
    throw err; // rethrow — caller should know pinning failed
  }
}
