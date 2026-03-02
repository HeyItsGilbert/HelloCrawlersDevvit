import { Devvit } from '@devvit/public-api';

// ----- Types ----------------------------------------------------------------

type RedditClient = Devvit.Context['reddit'];
type RedisClient = Devvit.Context['redis'];

// ----- Post creation --------------------------------------------------------

/**
 * Submit a plain-text (self) post to the subreddit and return the new Post.
 */
export async function createEpisodePost(
  reddit: RedditClient,
  subredditName: string,
  title: string,
  body: string
) {
  const post = await reddit.submitPost({
    title,
    subredditName,
    text: body,
  });
  return post;
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
      console.warn(
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
    console.error('[postManager] Failed to apply flair:', err);
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
      console.warn(
        `[postManager] Could not unpin previous post ${previousPostId}:`,
        err
      );
    }
  }

  // Pin the new post to sticky slot 1
  try {
    const newPost = await reddit.getPostById(newPostId);
    await newPost.sticky(1);
    console.log(`[postManager] Pinned new post: ${newPostId}`);
  } catch (err) {
    console.error(`[postManager] Failed to pin new post ${newPostId}:`, err);
    throw err; // rethrow — caller should know pinning failed
  }
}
