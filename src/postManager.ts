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
 * Apply the "Episode Discussion" flair to a post.
 * Looks up the flair template by text match; logs a warning if not found.
 */
export async function applyEpisodeFlair(
  reddit: RedditClient,
  subredditName: string,
  postId: string
): Promise<void> {
  try {
    const flairs = await reddit.getPostFlairTemplates(subredditName);
    const episodeFlair = flairs.find(
      (f) => (f.text ?? '').toLowerCase().trim() === 'episode discussion'
    );

    if (!episodeFlair) {
      console.warn(
        '[postManager] "Episode Discussion" flair template not found on subreddit. ' +
        'Please create it in subreddit settings. Post will remain unflaired.'
      );
      return;
    }

    await reddit.setPostFlair({
      subredditName,
      postId,
      flairTemplateId: episodeFlair.id,
    });

    console.log(`[postManager] Applied flair "${episodeFlair.text}" to ${postId}`);
  } catch (err) {
    console.error('[postManager] Failed to apply flair:', err);
  }
}

// ----- Pin management -------------------------------------------------------

/**
 * Unpin the previous episode post (if any) and pin the new one.
 *
 * Reddit allows a maximum of 2 sticky posts. Episode discussions occupy slot 1.
 * The previous post ID is read from Redis key `last_episode_post_id`.
 */
export async function managePins(
  reddit: RedditClient,
  redis: RedisClient,
  newPostId: string
): Promise<void> {
  // Unpin the previous episode post
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
