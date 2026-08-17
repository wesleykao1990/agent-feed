import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import type { DnsResolver, EndpointPolicyOptions, ResolvedAddress, ValidatedEndpoint } from "./types.ts";
import { WebhookTransportError } from "./types.ts";

export class NodeDnsResolver implements DnsResolver {
  async resolve(hostname: string): Promise<readonly ResolvedAddress[]> {
    if (isIP(hostname) === 4) return [{ address: hostname, family: 4 }];
    if (isIP(hostname) === 6) return [{ address: hostname, family: 6 }];
    const rows = await lookup(hostname, { all: true, verbatim: true });
    return rows.map((row) => ({ address: row.address, family: row.family as 4 | 6 }));
  }
}

const DEFAULT_POLICY: Required<Pick<EndpointPolicyOptions, "allowHttpForTesting" | "allowIpLiterals" | "allowQueryString">> = {
  allowHttpForTesting: false,
  allowIpLiterals: false,
  allowQueryString: false,
};

function invalidEndpoint(code: ConstructorParameters<typeof WebhookTransportError>[0]["code"], message: string): never {
  throw new WebhookTransportError({
    code,
    message,
    retryable: false,
    status: null,
    retryAfterSeconds: null,
  });
}

function ipv4Bytes(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const bytes = parts.map((part) => {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(part)) return -1;
    const value = Number(part);
    return Number.isInteger(value) && value >= 0 && value <= 255 ? value : -1;
  });
  return bytes.some((value) => value < 0) ? null : bytes;
}

function ipv4FromBytes(bytes: readonly number[], offset: number): string | null {
  if (offset < 0 || offset + 4 > bytes.length) return null;
  const octets = bytes.slice(offset, offset + 4);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return null;
  return octets.join(".");
}

function ipv6Bytes(address: string): number[] | null {
  let value = address.toLowerCase();
  const zone = value.indexOf("%");
  if (zone >= 0) value = value.slice(0, zone);
  if (value.includes(".")) {
    const lastColon = value.lastIndexOf(":");
    if (lastColon < 0) return null;
    const tail = ipv4Bytes(value.slice(lastColon + 1));
    if (!tail) return null;
    value = `${value.slice(0, lastColon)}:${((tail[0]! << 8) | tail[1]!).toString(16)}:${((tail[2]! << 8) | tail[3]!).toString(16)}`;
  }
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] === "" ? [] : halves[0]!.split(":");
  const rightPart = halves.length === 2 ? (halves[1] ?? "") : "";
  const right = rightPart === "" ? [] : rightPart.split(":");
  if (left.some((part) => !/^[0-9a-f]{1,4}$/u.test(part)) || right.some((part) => !/^[0-9a-f]{1,4}$/u.test(part))) return null;
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const words = [...left, ...Array.from({ length: missing }, () => "0"), ...right].map((part) => Number.parseInt(part, 16));
  if (words.length !== 8 || words.some((word) => !Number.isInteger(word))) return null;
  const bytes: number[] = [];
  for (const word of words) bytes.push((word >>> 8) & 0xff, word & 0xff);
  return bytes;
}

function isBlockedIpv4(address: string): boolean {
  const bytes = ipv4Bytes(address);
  if (!bytes) return true;
  const a = bytes[0]!;
  const b = bytes[1]!;
  const c = bytes[2]!;
  const d = bytes[3]!;
  if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254)) return true;
  if (a === 100 && b! >= 64 && b! <= 127) return true;
  if (a === 172 && b! >= 16 && b! <= 31) return true;
  if (a === 192 && (b === 0 || b === 2 || b === 168)) return true;
  if (a === 198 && (b === 18 || b === 19 || b === 51)) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  return a === 255 && b === 255 && c === 255 && d === 255;
}

function isBlockedIpv6(address: string): boolean {
  const bytes = ipv6Bytes(address);
  if (!bytes) return true;
  const allZero = bytes.every((byte) => byte === 0);
  const loopback = bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15]! === 1;
  const uniqueLocal = (bytes[0]! & 0xfe) === 0xfc;
  const linkLocal = bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80;
  const siteLocal = bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0xc0;
  const multicast = bytes[0] === 0xff;
  const documentation = bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8;
  const mappedIpv4 = bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  const mappedAddress = mappedIpv4 ? ipv4FromBytes(bytes, 12) : null;

  // IPv4-compatible addresses (::w.x.y.z) are deprecated, but a resolver can
  // still return them. Treat a private embedded IPv4 as private rather than
  // allowing the IPv6 spelling to bypass the IPv4 policy.
  const compatibleIpv4 = bytes.slice(0, 12).every((byte) => byte === 0) && !mappedIpv4
    ? ipv4FromBytes(bytes, 12)
    : null;

  // 6to4 embeds an IPv4 address in bytes 2..5. NAT64's well-known prefix
  // embeds it in the final four bytes. These deterministic forms must inherit
  // the same private/documentation/link-local restrictions as IPv4.
  const sixToFourIpv4 = bytes[0] === 0x20 && bytes[1] === 0x02 ? ipv4FromBytes(bytes, 2) : null;
  const nat64WellKnown = bytes[0] === 0x00
    && bytes[1] === 0x64
    && bytes[2] === 0xff
    && bytes[3] === 0x9b
    && bytes.slice(4, 12).every((byte) => byte === 0);
  const nat64Ipv4 = nat64WellKnown ? ipv4FromBytes(bytes, 12) : null;

  return allZero
    || loopback
    || uniqueLocal
    || linkLocal
    || siteLocal
    || multicast
    || documentation
    || (mappedAddress !== null && isBlockedIpv4(mappedAddress))
    || (compatibleIpv4 !== null && isBlockedIpv4(compatibleIpv4))
    || (sixToFourIpv4 !== null && isBlockedIpv4(sixToFourIpv4))
    || (nat64Ipv4 !== null && isBlockedIpv4(nat64Ipv4));
}

export function isPublicAddress(address: string, family: 4 | 6): boolean {
  return family === 4 ? !isBlockedIpv4(address) : !isBlockedIpv6(address);
}

function normalizedHostAllowlist(values: readonly string[] | undefined): Set<string> | null {
  if (values === undefined || values.length === 0) return null;
  const normalized = new Set<string>();
  for (const value of values) {
    if (!value || value.trim() !== value || value.includes("/") || isIP(value) !== 0) {
      invalidEndpoint("endpoint_host_not_allowed", "endpoint host allowlist is invalid");
    }
    normalized.add(value.toLowerCase());
  }
  return normalized;
}

/** Resolve and validate all addresses before a request is opened. */
export async function resolveSafeEndpoint(
  rawUrl: string,
  resolver: DnsResolver,
  policy: EndpointPolicyOptions = {},
): Promise<ValidatedEndpoint> {
  const settings = { ...DEFAULT_POLICY, ...policy };
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    invalidEndpoint("endpoint_invalid", "endpoint URL is invalid");
  }
  const schemeAllowed = url.protocol === "https:" || (settings.allowHttpForTesting && url.protocol === "http:");
  if (!schemeAllowed) invalidEndpoint("endpoint_scheme_not_allowed", "endpoint scheme is not allowed");
  if (url.username || url.password) invalidEndpoint("endpoint_credentials_not_allowed", "endpoint credentials are not allowed");
  if (url.hash) invalidEndpoint("endpoint_invalid", "endpoint fragments are not allowed");
  if (url.search && !settings.allowQueryString) invalidEndpoint("endpoint_query_not_allowed", "endpoint query strings are not allowed");
  const host = url.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (!host) invalidEndpoint("endpoint_invalid", "endpoint host is required");
  const hostAllowlist = normalizedHostAllowlist(policy.allowedHosts);
  if (hostAllowlist !== null && !hostAllowlist.has(host)) invalidEndpoint("endpoint_host_not_allowed", "endpoint host is not allowed");
  if (!settings.allowIpLiterals && isIP(host) !== 0) invalidEndpoint("endpoint_ip_literal_not_allowed", "endpoint IP literals are not allowed");
  const effectivePort = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
  const allowedPorts = policy.allowedPorts === undefined
    ? new Set([url.protocol === "https:" ? 443 : 80])
    : new Set(policy.allowedPorts);
  if (!Number.isInteger(effectivePort) || !allowedPorts.has(effectivePort)) invalidEndpoint("endpoint_port_not_allowed", "endpoint port is not allowed");

  let addresses: readonly ResolvedAddress[];
  try {
    addresses = isIP(host) !== 0
      ? [{ address: host, family: isIP(host) as 4 | 6 }]
      : await resolver.resolve(host);
  } catch {
    throw new WebhookTransportError({
      code: "dns_resolution_failed",
      message: "endpoint DNS resolution failed",
      retryable: true,
      status: null,
      retryAfterSeconds: null,
    });
  }
  if (addresses.length === 0) {
    throw new WebhookTransportError({
      code: "dns_no_addresses",
      message: "endpoint DNS returned no addresses",
      retryable: false,
      status: null,
      retryAfterSeconds: null,
    });
  }
  if (addresses.some((address) => (address.family !== 4 && address.family !== 6) || !isPublicAddress(address.address, address.family))) {
    throw new WebhookTransportError({
      code: "private_address_rejected",
      message: "endpoint resolved to a non-public address",
      retryable: false,
      status: null,
      retryAfterSeconds: null,
    });
  }
  return { url, addresses };
}
