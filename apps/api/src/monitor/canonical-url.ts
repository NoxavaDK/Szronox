export type CanonicalUrlFailure = 'comment' | 'not_a_post';
export type CanonicalUrlResult = { ok: true; url: string } | { ok: false; reason: CanonicalUrlFailure };

const FACEBOOK_HOSTS = new Set(['facebook.com', 'www.facebook.com', 'm.facebook.com', 'web.facebook.com']);
const X_HOSTS = new Set([
  'x.com', 'www.x.com', 'mobile.x.com',
  'twitter.com', 'www.twitter.com', 'mobile.twitter.com',
]);
const FACEBOOK_POST_PATH = /\/(?:posts|videos|reel)\/[a-z0-9._-]+(?:\/|$)/i;
const X_STATUS_PATH = /^\/([a-z0-9_]+)\/status\/(\d+)(?:\/.*)?$/i;

/**
 * T00 MONITOR-01 canonical URL rules. The collector applies the same rules, but the API
 * always re-canonicalises and rejects comments or non-post links before they enter storage.
 */
export function canonicalPostUrl(value: unknown, platform: 'facebook' | 'x'): CanonicalUrlResult {
  if (typeof value !== 'string' || value.length > 2048) return { ok: false, reason: 'not_a_post' };
  let parsed: URL;
  try { parsed = new URL(value); } catch { return { ok: false, reason: 'not_a_post' }; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { ok: false, reason: 'not_a_post' };
  if (parsed.username || parsed.password) return { ok: false, reason: 'not_a_post' };

  const host = parsed.hostname.toLowerCase();
  const path = (parsed.pathname.replace(/\/+$/, '') || '/');
  if (platform === 'facebook') {
    if (!FACEBOOK_HOSTS.has(host)) return { ok: false, reason: 'not_a_post' };
    if (parsed.searchParams.has('comment_id') || parsed.searchParams.has('reply_comment_id')) {
      return { ok: false, reason: 'comment' };
    }
    let canonicalPath = path;
    let query = '';
    if (/\/(?:permalink|story)\.php$/i.test(path)) {
      const story = parsed.searchParams.get('story_fbid');
      const id = parsed.searchParams.get('id');
      if (!story && !id) return { ok: false, reason: 'not_a_post' };
      const kept = new URLSearchParams();
      if (story) kept.set('story_fbid', story);
      if (id) kept.set('id', id);
      query = kept.toString();
    } else if (/^\/photo(?:\.php)?$/i.test(path)) {
      const fbid = parsed.searchParams.get('fbid');
      if (!fbid) return { ok: false, reason: 'not_a_post' };
      const kept = new URLSearchParams();
      kept.set('fbid', fbid);
      query = kept.toString();
    } else if (/^\/watch$/i.test(path)) {
      const video = parsed.searchParams.get('v');
      if (!video) return { ok: false, reason: 'not_a_post' };
      const kept = new URLSearchParams();
      kept.set('v', video);
      query = kept.toString();
    } else if (!FACEBOOK_POST_PATH.test(`${path}/`)) {
      return { ok: false, reason: 'not_a_post' };
    }
    const suffix = query ? `?${query}` : '';
    return { ok: true, url: `https://www.facebook.com${canonicalPath}${suffix}` };
  }

  if (!X_HOSTS.has(host)) return { ok: false, reason: 'not_a_post' };
  const match = X_STATUS_PATH.exec(path);
  if (!match) return { ok: false, reason: 'not_a_post' };
  return { ok: true, url: `https://x.com/${match[1]}/status/${match[2]}` };
}
