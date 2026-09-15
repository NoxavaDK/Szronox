/**
 * The authentication service.
 *
 * One object owns every decision about who a request is from. It answers three
 * questions and nothing else:
 *
 *   login(request, credentials) → a new session, or a generic refusal
 *   authenticate(request)       → the VerifiedActor behind this request, or 401
 *   logout(request)             → this session revoked, truthfully reported
 *
 * `authenticate` is the seam core routes consume. It resolves identity from the
 * session cookie alone: there is no actor field in a request body and no bearer
 * token, so a client cannot state who it is. On an unsafe method it additionally
 * requires the exact configured Origin and the session-bound CSRF token, which is
 * why a single call site gets both identity and CSRF protection and neither can be
 * forgotten separately.
 *
 * Failure reporting is deliberately coarse. An unknown account, a wrong password
 * and an account with no credential are all one 401 with one message, and an
 * unknown account still pays for a password verification, so neither the body nor
 * the timing distinguishes "no such user" from "wrong password".
 */

import type { AuthSessionResponse } from '@szronox/contracts';
import type { FastifyRequest } from 'fastify';

import { CoreError } from '../core/errors.js';
import type { Database } from '../db/client.js';
import type { AuthConfig } from './config.js';
import { MAX_PASSWORD_BYTES } from './config.js';
import { clearedSessionCookie, readSessionCookie, serializeSessionCookie } from './cookies.js';
import { checkOrigin, clientKey, isJsonRequest, isSafeMethod } from './origin.js';
import { PasswordInputError, type PasswordHasher, assertUsablePassword } from './passwords.js';
import { createSessionStore, csrfTokenHash, digestsMatch, type SessionStore } from './sessions.js';
import { findUserByName, userPair } from './users.js';
import { createThrottle, DEFAULT_ACCOUNT_THROTTLE, DEFAULT_ADDRESS_THROTTLE, type Throttle } from './throttle.js';

export interface VerifiedActor {
  id: string;
  name: 'NOXAVA' | 'SZRON';
}

export const CSRF_HEADER = 'x-csrf-token';

/** One message for every credential failure, so the response discloses nothing. */
const GENERIC_LOGIN_FAILURE = 'Invalid account or password';

const unauthenticatedError = (message = 'Authentication required') =>
  new CoreError({ status: 401, code: 'UNAUTHENTICATED', message });

const forbiddenError = (message: string) =>
  new CoreError({ status: 403, code: 'FORBIDDEN', message });

export const rateLimited = (retryAfterSeconds: number) =>
  new CoreError({
    status: 429,
    code: 'RATE_LIMITED',
    message: 'Too many attempts',
    retryable: true,
    details: { retryAfterSeconds },
  });

/** Carries the Retry-After value a route must set as a header. */
export function retryAfterOf(error: unknown): number | null {
  if (error instanceof CoreError && error.code === 'RATE_LIMITED') {
    const value = error.details?.retryAfterSeconds;
    return typeof value === 'number' ? value : null;
  }
  return null;
}

export interface LoginOutcome {
  response: AuthSessionResponse;
  /** Complete Set-Cookie header value. */
  setCookie: string;
}

export interface AuthService {
  login(request: FastifyRequest, body: unknown): Promise<LoginOutcome>;
  /** Re-derive the session state for a bootstrapping browser. */
  bootstrap(request: FastifyRequest): Promise<AuthSessionResponse>;
  /** Revoke the presented session. Throws rather than reporting a revocation that did not happen. */
  logout(request: FastifyRequest): Promise<void>;
  authenticate(request: FastifyRequest): Promise<VerifiedActor>;
  clearedCookie(): string;
  readonly config: AuthConfig;
}

export interface AuthServiceOptions {
  db: Database;
  config: AuthConfig;
  hasher: PasswordHasher;
  sessions?: SessionStore;
  addressThrottle?: Throttle;
  accountThrottle?: Throttle;
  now?: () => number;
}

function parseLoginBody(body: unknown): { name: 'NOXAVA' | 'SZRON'; password: string } {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new CoreError({ status: 422, code: 'VALIDATION_ERROR', message: 'A JSON object body is required' });
  }
  const source = body as Record<string, unknown>;
  // The name is checked against the two known values rather than passed through:
  // there is no third account to look up, so an unknown name never reaches a query.
  if (source.name !== 'NOXAVA' && source.name !== 'SZRON') {
    throw unauthenticatedError(GENERIC_LOGIN_FAILURE);
  }
  try {
    return { name: source.name, password: assertUsablePassword(source.password) };
  } catch (error) {
    if (error instanceof PasswordInputError) {
      // Length is a request-shape problem, reported as such: refusing to hash a
      // megabyte is not the same statement as "that password is wrong".
      throw new CoreError({
        status: 422,
        code: 'VALIDATION_ERROR',
        message: `password must be a non-empty string of at most ${MAX_PASSWORD_BYTES} bytes`,
      });
    }
    throw error;
  }
}

export function createAuthService(options: AuthServiceOptions): AuthService {
  const now = options.now ?? (() => Date.now());
  const sessions = options.sessions ?? createSessionStore(options.db, now);
  const byAddress = options.addressThrottle ?? createThrottle({ ...DEFAULT_ADDRESS_THROTTLE, now });
  const byAccount = options.accountThrottle ?? createThrottle({ ...DEFAULT_ACCOUNT_THROTTLE, now });
  const { config } = options;

  /**
   * Resolve the cookie to a live session. Every failure reason collapses to the
   * same 401: the browser's only useful reaction is to show the login surface, and
   * distinguishing "revoked" from "expired" for an unauthenticated caller would
   * only confirm that a session once existed.
   */
  async function resolveSession(request: FastifyRequest) {
    const secret = readSessionCookie(request, config.cookieName);
    const lookup = await sessions.resolve(secret, config.csrfSecret);
    if (!lookup.ok) throw unauthenticatedError();
    return { secret: secret as string, ...lookup };
  }

  /**
   * Unsafe-method gate. Origin is checked before CSRF so a cross-site request is
   * refused without the server comparing any session-derived value.
   */
  function assertUnsafeRequestIsAllowed(request: FastifyRequest, storedCsrfHash: string): void {
    const origin = checkOrigin(request, config.allowedOrigins);
    if (!origin.ok) throw forbiddenError('Request origin is not allowed');
    const presented = request.headers[CSRF_HEADER];
    if (typeof presented !== 'string' || presented === '') {
      throw forbiddenError('A CSRF token is required for this request');
    }
    if (!digestsMatch(storedCsrfHash, csrfTokenHash(presented))) {
      throw forbiddenError('The CSRF token does not match this session');
    }
  }

  return {
    config,

    clearedCookie: () => clearedSessionCookie(config.cookieName),

    async login(request, body) {
      // Login has no prior session, so Origin and content type are the only
      // request-shape defences and both fail closed.
      const origin = checkOrigin(request, config.allowedOrigins);
      if (!origin.ok) throw forbiddenError('Request origin is not allowed');
      if (!isJsonRequest(request)) {
        throw new CoreError({
          status: 415,
          code: 'VALIDATION_ERROR',
          message: 'Content-Type must be application/json',
        });
      }

      // Counted before any password work, so a blocked caller causes no hashing.
      const address = byAddress.consume(clientKey(request));
      if (!address.allowed) throw rateLimited(address.retryAfterSeconds);

      const credentials = parseLoginBody(body);

      const accountState = byAccount.peek(`account:${credentials.name}`);
      if (!accountState.allowed) throw rateLimited(accountState.retryAfterSeconds);

      const account = await findUserByName(options.db, credentials.name);
      if (account === null || account.passwordHash === null) {
        // Not provisioned, or provisioned without a credential. The same work is
        // still done, so this path is not faster than a wrong password.
        await options.hasher.verifyDummy(credentials.password);
        byAccount.consume(`account:${credentials.name}`);
        throw unauthenticatedError(GENERIC_LOGIN_FAILURE);
      }

      const matches = await options.hasher.verify(account.passwordHash, credentials.password);
      if (!matches) {
        const failed = byAccount.consume(`account:${credentials.name}`);
        if (!failed.allowed) throw rateLimited(failed.retryAfterSeconds);
        throw unauthenticatedError(GENERIC_LOGIN_FAILURE);
      }
      byAccount.reset(`account:${credentials.name}`);

      // A valid old session on this browser is invalidated rather than left live,
      // so logging in again does not accumulate usable cookies.
      const presented = readSessionCookie(request, config.cookieName);
      if (presented !== undefined) await sessions.revoke(presented);

      const created = await sessions.create({
        userId: account.id,
        csrfSecret: config.csrfSecret,
        lifetimeMs: config.sessionLifetimeMs,
      });
      const pair = await userPair(options.db, account.id);

      return {
        response: {
          user: pair.user,
          peer: pair.peer,
          expiresAt: created.expiresAt.toISOString(),
          csrfToken: created.csrfToken,
        },
        // Max-Age is derived from the server's own expiry, so the cookie cannot
        // outlive the session record it points at.
        setCookie: serializeSessionCookie(
          created.secret,
          Math.max(1, Math.floor((created.expiresAt.getTime() - now()) / 1000)),
          config.cookieName,
        ),
      };
    },

    async bootstrap(request) {
      const resolved = await resolveSession(request);
      const pair = await userPair(options.db, resolved.session.userId);
      return {
        user: pair.user,
        peer: pair.peer,
        expiresAt: resolved.session.expiresAt.toISOString(),
        // Recomputed, never stored in a retrievable form.
        csrfToken: resolved.csrfToken,
      };
    },

    async logout(request) {
      // Session validity first: with no live session there is nothing to revoke,
      // and checking CSRF against a session that does not exist is meaningless.
      const resolved = await resolveSession(request);
      assertUnsafeRequestIsAllowed(request, resolved.session.csrfTokenHash);
      const revoked = await sessions.revoke(resolved.secret);
      if (!revoked) {
        // The session was live a moment ago and is not now. Something else revoked
        // it concurrently; reporting success would claim this call ended it.
        throw unauthenticatedError();
      }
    },

    async authenticate(request) {
      const resolved = await resolveSession(request);
      if (!isSafeMethod(request.method)) {
        assertUnsafeRequestIsAllowed(request, resolved.session.csrfTokenHash);
      }
      return { id: resolved.session.userId, name: resolved.session.userName };
    },
  };
}

/** The request-authentication seam core routes depend on. */
export type RequestAuthenticator = (request: FastifyRequest) => Promise<VerifiedActor>;

export function requestAuthenticator(service: AuthService): RequestAuthenticator {
  return (request) => service.authenticate(request);
}
