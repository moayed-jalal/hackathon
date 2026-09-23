import { isIP } from "node:net";
import dns from "node:dns/promises";

/**
 * SSRF guard for merchant-configured webhook URLs. FinBridge makes outbound
 * HTTP requests to a URL a user supplied — the classic SSRF shape — so a
 * hostname is never trusted merely because it *looks* public: we resolve it
 * ourselves and validate the resolved IP, not the string.
 *
 * This closes the DNS-rebinding TOCTOU window (a "safe" hostname at
 * config-save time later resolving to a private IP at delivery time) by
 * pinning delivery to the exact IP validated here — see
 * `pinnedDispatcher` in modules/merchant-webhooks/service.ts, which forces
 * undici's connector to use this validated IP directly instead of letting it
 * re-resolve DNS itself at connect time.
 */
export class UnsafeWebhookUrlError extends Error {}

const LOCALHOST_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function ipv4ToLong(ip: string): number {
  return ip
    .split(".")
    .reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
}

function isIPv4InCidr(ip: string, cidr: string): boolean {
  const [range, bitsStr] = cidr.split("/") as [string, string];
  const bits = Number(bitsStr);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4ToLong(ip) & mask) === (ipv4ToLong(range) & mask);
}

// RFC 1918 private ranges, loopback, link-local (incl. 169.254.169.254 cloud
// metadata), carrier-grade NAT, documentation/test, and multicast/reserved.
const BLOCKED_IPV4_CIDRS = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
];

function isBlockedIPv4(ip: string): boolean {
  return BLOCKED_IPV4_CIDRS.some((cidr) => isIPv4InCidr(ip, cidr));
}

/**
 * Expands a (possibly `::`-compressed) IPv6 address into its 8 hextets.
 * Node's URL parser can rewrite an address into a different valid form than
 * what a user typed (e.g. `::ffff:10.0.0.5` becomes `::ffff:a00:5` — the
 * IPv4 suffix re-encoded as two hex hextets), so range checks below work
 * against this canonical, fully-expanded form rather than pattern-matching
 * the original string.
 */
function expandIPv6(ip: string): string[] {
  const [head, tail] = ip.includes("::") ? ip.split("::") : [ip, ""];
  const headParts = head ? head.split(":") : [];
  const tailParts = tail ? tail.split(":") : [];
  const missing = Math.max(8 - headParts.length - tailParts.length, 0);
  return [...headParts, ...new Array(missing).fill("0"), ...tailParts];
}

function isBlockedIPv6(ip: string): boolean {
  const hextets = expandIPv6(ip.toLowerCase()).map((h) => parseInt(h || "0", 16) || 0);
  if (hextets.length !== 8) return true; // malformed — refuse rather than risk a false negative

  const isLoopback = hextets.slice(0, 7).every((h) => h === 0) && hextets[7] === 1;
  const isUnspecified = hextets.every((h) => h === 0);
  if (isLoopback || isUnspecified) return true;

  // IPv4-mapped (::ffff:0:0/96) — validate the embedded IPv4 address too.
  if (hextets.slice(0, 5).every((h) => h === 0) && hextets[5] === 0xffff) {
    const a = hextets[6]!;
    const b = hextets[7]!;
    const ipv4 = `${(a >> 8) & 0xff}.${a & 0xff}.${(b >> 8) & 0xff}.${b & 0xff}`;
    return isBlockedIPv4(ipv4);
  }

  const first = hextets[0]!;
  // fc00::/7 (unique local) and fe80::/10 (link-local) both fall out of the
  // first hextet's range: fc00-fdff and fe80-febf.
  if (first >= 0xfc00 && first <= 0xfdff) return true;
  if (first >= 0xfe80 && first <= 0xfebf) return true;
  return false;
}

function isBlockedIp(ip: string): boolean {
  return isIP(ip) === 6 ? isBlockedIPv6(ip) : isBlockedIPv4(ip);
}

export interface ValidatedWebhookUrl {
  url: URL;
  /** The exact IP validated here — pin delivery's connection to this IP, not a fresh lookup. */
  validatedIp: string;
}

/**
 * Validates a merchant-supplied webhook URL: https required (http allowed
 * only for localhost, and only when `allowLocalhostHttp` is set — i.e.
 * outside production), then resolves the hostname and rejects any private,
 * loopback, link-local, or reserved destination address. Does not consider
 * redirects — callers must not follow them (see `redirect: "manual"` at the
 * fetch call site) since a redirect target needs this same validation
 * before it could ever be trusted.
 */
export async function assertPublicWebhookUrl(
  rawUrl: string,
  opts: { allowLocalhostHttp: boolean },
): Promise<ValidatedWebhookUrl> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UnsafeWebhookUrlError("Webhook URL must be a valid absolute URL");
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const isLocalhostHost = LOCALHOST_HOSTNAMES.has(hostname) || LOCALHOST_HOSTNAMES.has(url.hostname);

  if (url.protocol === "https:") {
    // always fine
  } else if (url.protocol === "http:" && opts.allowLocalhostHttp && isLocalhostHost) {
    // dev/demo-only exception, and only for localhost itself
  } else if (url.protocol === "http:" && isLocalhostHost) {
    throw new UnsafeWebhookUrlError("Localhost webhook URLs over http are only allowed outside production");
  } else {
    throw new UnsafeWebhookUrlError("Webhook URL must use https");
  }

  let ip: string;
  if (isIP(hostname)) {
    ip = hostname;
  } else {
    try {
      const resolved = await dns.lookup(hostname);
      ip = resolved.address;
    } catch {
      throw new UnsafeWebhookUrlError(`Webhook URL hostname does not resolve: ${hostname}`);
    }
  }

  if (isLocalhostHost) {
    if (!opts.allowLocalhostHttp) {
      throw new UnsafeWebhookUrlError("Localhost webhook URLs are only allowed outside production");
    }
  } else if (isBlockedIp(ip)) {
    throw new UnsafeWebhookUrlError(
      "Webhook URL resolves to a private, loopback, link-local, or reserved address",
    );
  }

  return { url, validatedIp: ip };
}
