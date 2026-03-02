const RSS_URL = 'https://anchor.fm/s/103dbb9d4/podcast/rss';
/**
 * Fetch the raw RSS feed XML string.
 */
export async function fetchRssFeed() {
    const response = await fetch(RSS_URL, {
        headers: { 'Accept': 'application/rss+xml, application/xml, text/xml, */*' },
    });
    if (!response.ok) {
        throw new Error(`RSS fetch failed with status ${response.status}`);
    }
    return response.text();
}
/**
 * Parse the latest (first) episode from RSS XML.
 * Returns null if no <item> is found.
 */
export function parseLatestEpisode(xml) {
    const itemMatch = xml.match(/<item>([\s\S]*?)<\/item>/);
    if (!itemMatch)
        return null;
    const item = itemMatch[1];
    function extract(tag) {
        // CDATA: <tag><![CDATA[...]]></tag>
        const cdataRe = new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, 'i');
        const cdataMatch = item.match(cdataRe);
        if (cdataMatch)
            return cdataMatch[1].trim();
        // Plain text: <tag ...>content</tag>
        const plainRe = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
        const plainMatch = item.match(plainRe);
        if (plainMatch)
            return plainMatch[1].trim();
        // Self-closing attribute (e.g. <guid isPermaLink="false">url</guid> already
        // handled above, but catch bare <link> which may be value-only in some feeds)
        return '';
    }
    // <link> in RSS 2.0 can appear as plain text between tags OR as an ATOM-style
    // attribute href. Try both.
    function extractLink() {
        const direct = extract('link');
        if (direct)
            return direct;
        const attrMatch = item.match(/<link[^>]+href="([^"]+)"/i);
        return attrMatch ? attrMatch[1] : '';
    }
    const guid = extract('guid');
    const title = extract('title');
    const rawDescription = extract('description') || extract('content:encoded');
    const pubDate = extract('pubDate');
    const link = extractLink();
    const episodeNumber = extract('itunes:episode') || undefined;
    if (!guid && !title)
        return null;
    return {
        guid: guid || link || title, // fallback chain so we always have a unique key
        title,
        description: cleanHtml(rawDescription),
        pubDate,
        link,
        episodeNumber,
    };
}
/**
 * Strip HTML tags, decode common entities, and collapse whitespace.
 */
export function cleanHtml(html) {
    if (!html)
        return '';
    let text = html;
    // Decode HTML entities
    text = text
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&apos;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/&#(\d+);/g, (_match, num) => String.fromCharCode(Number(num)))
        .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => String.fromCharCode(parseInt(hex, 16)));
    // Replace block-level tags with newlines before stripping
    text = text.replace(/<\/(p|div|br|li|h\d|blockquote)>/gi, '\n');
    text = text.replace(/<br\s*\/?>/gi, '\n');
    // Strip all remaining HTML tags
    text = text.replace(/<[^>]+>/g, '');
    // Collapse excessive whitespace
    text = text.replace(/[ \t]+/g, ' ');
    text = text.replace(/\n{3,}/g, '\n\n');
    text = text.trim();
    return text;
}
/**
 * Check whether the given episode is newer than the last one we processed.
 * Uses Redis key `last_episode_guid` for comparison.
 */
export async function isNewEpisode(redis, episode) {
    const lastGuid = await redis.get('last_episode_guid');
    return lastGuid !== episode.guid;
}
