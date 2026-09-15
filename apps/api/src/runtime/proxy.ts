/**
 * Which proxy, if any, this process believes about the client's address.
 *
 * This decision only becomes visible behind a reverse proxy, which is why VPS-05 is where
 * it has to be made. Both wrong answers are bad in different ways:
 *
 *   - **Trust nothing** (the default until now). Behind Caddy, every request's
 *     `request.ip` is the proxy's own address, so the per-address login throttle collapses
 *     into one global counter: an attacker hammering the login endpoint locks out both
 *     real users, and NOXAVA's failed attempts count against SZRON's.
 *   - **Trust everything** (`trustProxy: true`). Any client can then send
 *     `X-Forwarded-For: 1.2.3.4` and pick its own limiter key, so the throttle can be
 *     bypassed entirely by varying a header.
 *
 * The only correct answer is an explicit list of addresses that are actually the proxy.
 * `APP_TRUSTED_PROXIES` holds it, and this module refuses the shapes that mean "everyone":
 * `true`, `*`, `0.0.0.0/0` and `::/0`.
 *
 * Absent configuration yields `false` — trust nothing. That is the safe failure: a shared
 * limiter is a bounded availability problem, while a spoofable limiter is an unbounded
 * security one. The startup summary says which applies, so a deployment behind a proxy
 * with this unset is visible rather than silent.
 *
 * `origin.ts` is the only consumer that matters: it reads `request.ip` and never a
 * forwarded header directly, so this setting is the single place proxy trust is decided.
 */

export class ProxyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProxyConfigError';
  }
}

export interface ProxyEnv {
  /** Comma-separated IPv4/IPv6 addresses or CIDR blocks that are the reverse proxy. */
  APP_TRUSTED_PROXIES?: string;
}

/** What Fastify accepts for `trustProxy`, narrowed to the two forms used here. */
export type TrustProxySetting = false | string[];

const DENIED = new Set(['true', 'false', '*', 'all', '0.0.0.0/0', '::/0', '0.0.0.0', '::']);

/**
 * Validate one entry.
 *
 * Parsing is done with `URL`'s host handling rather than a hand-written address regex:
 * bracketed IPv6, zone identifiers and malformed dotted quads are all easy to get wrong by
 * hand, and an over-permissive check here would widen who gets believed.
 */
function validateEntry(raw: string): string {
  const entry = raw.trim();
  if (entry === '') throw new ProxyConfigError('APP_TRUSTED_PROXIES contains an empty entry');
  if (DENIED.has(entry.toLowerCase())) {
    throw new ProxyConfigError(
      `APP_TRUSTED_PROXIES must name the actual proxy addresses; "${entry}" would trust every client`,
    );
  }

  const [address, prefix] = entry.includes('/') ? entry.split('/', 2) : [entry, null];
  const host = address.startsWith('[') && address.endsWith(']') ? address.slice(1, -1) : address;

  let parsed: URL;
  try {
    // `URL` accepts an IPv4 literal or a bracketed IPv6 literal as a host and rejects
    // nonsense; a hostname would also parse, which the next check rejects.
    parsed = new URL(`http://${address.includes(':') && !address.startsWith('[') ? `[${host}]` : host}`);
  } catch {
    throw new ProxyConfigError(`APP_TRUSTED_PROXIES entry is not a valid IP address or CIDR block: ${entry}`);
  }
  const isIpv6 = parsed.hostname.startsWith('[');
  const isIpv4 = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(parsed.hostname);
  if (!isIpv4 && !isIpv6) {
    // A hostname resolves at some unknown later moment, to whatever DNS says then. Proxy
    // trust must not be re-decidable by a DNS change.
    throw new ProxyConfigError(
      `APP_TRUSTED_PROXIES must contain literal addresses, not hostnames: ${entry}`,
    );
  }
  if (isIpv4) {
    for (const octet of parsed.hostname.split('.')) {
      if (Number(octet) > 255) throw new ProxyConfigError(`APP_TRUSTED_PROXIES entry has an invalid octet: ${entry}`);
    }
  }

  if (prefix !== null) {
    const bits = Number(prefix);
    const maximum = isIpv4 ? 32 : 128;
    if (!Number.isInteger(bits) || bits < 1 || bits > maximum) {
      throw new ProxyConfigError(`APP_TRUSTED_PROXIES prefix must be 1..${maximum}: ${entry}`);
    }
    // A /0 was already denied by name, but an equivalent written differently is the same
    // thing and must be refused too.
    if (bits === 0) throw new ProxyConfigError(`APP_TRUSTED_PROXIES entry would trust every client: ${entry}`);
  }

  return entry;
}

export function parseTrustedProxies(env: ProxyEnv): TrustProxySetting {
  const raw = env.APP_TRUSTED_PROXIES;
  if (raw === undefined || raw.trim() === '') return false;
  const entries = raw.split(',').map(validateEntry);
  if (entries.length === 0) return false;
  return entries;
}

/** Startup summary. Says which of the two failure modes is in effect. */
export function describeTrustedProxies(setting: TrustProxySetting) {
  return setting === false
    ? {
      trustProxy: 'none' as const,
      note: 'request.ip is the socket address. Behind a reverse proxy this makes the '
        + 'per-address login throttle a single shared counter; set APP_TRUSTED_PROXIES to the proxy address.',
    }
    : { trustProxy: 'configured' as const, proxies: setting };
}
