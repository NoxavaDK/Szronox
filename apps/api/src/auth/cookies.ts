/**
 * Session cookie emission and reading.
 *
 * Hand-written rather than delegated, for two reasons.
 *
 * `@fastify/cookie` is registered nowhere here: the composition root belongs to
 * the lead (VPS-04), so registering a plugin from inside the auth module risks a
 * duplicate-decorator collision with whatever startup does, and the module stays
 * usable on a bare Fastify instance with no registration order to get right. Its
 * exported `parse`/`serialize` are not an alternative — they are bound to a
 * registered instance and throw when called standalone, which a first attempt here
 * demonstrated. The dependency remains available for VPS-02/VPS-04.
 *
 * The attribute set is fixed, not configurable. `__Host-` is only honoured by a
 * browser when the cookie is Secure with Path=/ and no Domain, so making any of
 * those a setting would let a deployment emit a cookie the browser silently
 * refuses — or, worse, one a sibling host could overwrite.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

import { SESSION_COOKIE_NAME } from './config.js';

/**
 * Read one cookie out of a `Cookie` header.
 *
 * Only the named cookie is decoded, and only its first occurrence is used. A
 * duplicate name is what cookie-shadowing attempts look like, and taking the
 * first match is what browsers send from the most specific path — but because the
 * name carries the `__Host-` prefix, a shadowing cookie from another host or path
 * cannot exist in the first place.
 */
export function readSessionCookie(
  request: FastifyRequest,
  cookieName = SESSION_COOKIE_NAME,
): string | undefined {
  const header = request.headers.cookie;
  if (typeof header !== 'string' || header === '') return undefined;
  for (const pair of header.split(';')) {
    const separator = pair.indexOf('=');
    if (separator < 1) continue;
    if (pair.slice(0, separator).trim() !== cookieName) continue;
    const raw = pair.slice(separator + 1).trim();
    if (raw === '') return undefined;
    try {
      return decodeURIComponent(raw);
    } catch {
      // A malformed percent-escape cannot be a value this server issued.
      return undefined;
    }
  }
  return undefined;
}

function serialize(cookieName: string, value: string, maxAgeSeconds: number): string {
  // Attribute order is irrelevant to a browser; it is fixed here so the emitted
  // header is byte-identical between the set and clear paths, which is what makes
  // clearing actually replace the stored cookie.
  return [
    `${cookieName}=${encodeURIComponent(value)}`,
    'Path=/',
    `Max-Age=${maxAgeSeconds}`,
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
  ].join('; ');
}

export function serializeSessionCookie(
  value: string,
  maxAgeSeconds: number,
  cookieName = SESSION_COOKIE_NAME,
): string {
  if (!Number.isInteger(maxAgeSeconds) || maxAgeSeconds < 1) {
    throw new RangeError('session cookie Max-Age must be a positive integer number of seconds');
  }
  return serialize(cookieName, value, maxAgeSeconds);
}

/**
 * Clear the cookie. `Max-Age=0` with an empty value and the identical attribute
 * set is what a browser needs to actually drop it; a different Path or a missing
 * Secure would leave the old cookie in place.
 */
export function clearedSessionCookie(cookieName = SESSION_COOKIE_NAME): string {
  return serialize(cookieName, '', 0);
}

/** Every auth response is uncacheable, including the ones that fail. */
export function noStore(reply: FastifyReply): FastifyReply {
  return reply.header('cache-control', 'no-store').header('pragma', 'no-cache');
}
