/**
 * Bounded in-memory login throttling.
 *
 * Two independent windows, because they answer different questions:
 *
 *   - by client address: how much login work one caller may cause at all.
 *   - by account name: how many failed guesses one account may accumulate,
 *     regardless of how many addresses they come from.
 *
 * Scope, stated rather than implied: this is per-process state. A restart clears
 * every counter, and two API replicas would each enforce the limit separately.
 * VPS-00 accepted that for a single API process and requires a shared limiter
 * before scaling out; there is no hidden claim of distributed rate limiting here.
 *
 * Memory is bounded by `maxKeys`. When the table is full, expired windows are
 * dropped first and then the oldest remaining one, so a caller cycling through
 * addresses cannot grow the table without limit — it can only evict its own
 * earlier entries.
 *
 * `@fastify/rate-limit` is deliberately not used for this: its key is computed in
 * `onRequest`, before the body is parsed, so it cannot key on the account name a
 * login request is attempting.
 */

export interface ThrottleDecision {
  allowed: boolean;
  /** Seconds until the window resets. Only meaningful when `allowed` is false. */
  retryAfterSeconds: number;
}

export interface Throttle {
  /** Count an attempt and report whether it may proceed. */
  consume(key: string): ThrottleDecision;
  /** Check without counting, so a blocked caller does not extend its own window. */
  peek(key: string): ThrottleDecision;
  /** Forget a key, used to clear failures after a successful login. */
  reset(key: string): void;
  size(): number;
}

export interface ThrottleOptions {
  limit: number;
  windowMs: number;
  maxKeys?: number;
  now?: () => number;
}

interface Window { count: number; resetAt: number }

export function createThrottle(options: ThrottleOptions): Throttle {
  const now = options.now ?? (() => Date.now());
  const maxKeys = options.maxKeys ?? 4096;
  // Insertion-ordered, so the first key is the oldest and eviction needs no sort.
  const windows = new Map<string, Window>();

  const decisionFor = (window: Window | undefined): ThrottleDecision => {
    if (!window || window.count <= options.limit) return { allowed: true, retryAfterSeconds: 0 };
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((window.resetAt - now()) / 1000)),
    };
  };

  function prune(): void {
    const at = now();
    for (const [key, window] of windows) {
      if (window.resetAt <= at) windows.delete(key);
    }
    while (windows.size >= maxKeys) {
      const oldest = windows.keys().next();
      if (oldest.done) break;
      windows.delete(oldest.value);
    }
  }

  function live(key: string): Window | undefined {
    const window = windows.get(key);
    if (window && window.resetAt <= now()) {
      windows.delete(key);
      return undefined;
    }
    return window;
  }

  return {
    consume(key) {
      const existing = live(key);
      if (existing) {
        existing.count += 1;
        return decisionFor(existing);
      }
      if (windows.size >= maxKeys) prune();
      const window: Window = { count: 1, resetAt: now() + options.windowMs };
      windows.set(key, window);
      return decisionFor(window);
    },
    peek: (key) => decisionFor(live(key)),
    reset(key) { windows.delete(key); },
    size: () => windows.size,
  };
}

/**
 * VPS-00 defaults. Address attempts are counted whether or not they succeed, so a
 * flood cannot be laundered through valid logins; account failures are counted
 * only on failure and cleared on success, so a user who eventually types the
 * right password is not locked out by their own typos.
 */
export const DEFAULT_ADDRESS_THROTTLE = { limit: 20, windowMs: 15 * 60 * 1000 } as const;
export const DEFAULT_ACCOUNT_THROTTLE = { limit: 5, windowMs: 15 * 60 * 1000 } as const;
