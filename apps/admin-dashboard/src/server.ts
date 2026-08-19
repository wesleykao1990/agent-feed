import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import type { DashboardClock, DashboardSnapshotSource, DashboardSnapshotState } from "./contracts.ts";
import { readDashboardState } from "./snapshot.ts";
import { renderDashboardPage } from "./render.ts";

/**
 * Optional deployment-owned authorization for clients outside loopback.
 *
 * The dashboard never interprets credentials itself. A deployment that
 * deliberately exposes the reference server on a private network may inject
 * a guard that authenticates and authorizes the request from headers or an
 * external session. Returning anything other than true denies the request.
 */
export type DashboardAuthorizer = (request: IncomingMessage) => boolean | Promise<boolean>;

export interface AdminDashboardServerOptions {
  readonly source: DashboardSnapshotSource;
  readonly now?: DashboardClock;
  readonly authorize?: DashboardAuthorizer;
}

const CREDENTIAL_QUERY_KEY = /(?:^|[-_])(access[-_]?token|api[-_]?key|authorization|auth|client[-_]?secret|credential|jwt|password|secret|session(?:[-_]?id)?|signature|sig|token)(?:$|[-_])/iu;

/** Return true only for IPv4/IPv6 loopback addresses. Unknown values fail closed. */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  if (isIP(address) === 4) {
    const firstOctet = Number(address.split(".", 1)[0]);
    return firstOctet === 127;
  }
  if (isIP(address) !== 6) return false;
  const normalized = address.toLowerCase();
  if (normalized === "::1") return true;
  // Node may expose an IPv4-mapped loopback peer in either dotted or hex form.
  const mappedDotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/u.exec(normalized);
  if (mappedDotted) return isLoopbackAddress(mappedDotted[1]);
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(normalized);
  if (!mappedHex) return false;
  const first = Number.parseInt(mappedHex[1]!, 16);
  const second = Number.parseInt(mappedHex[2]!, 16);
  return (first >>> 8) === 127 && (first & 0xff) === 0 && (second >>> 8) === 0 && (second & 0xff) === 1;
}

/**
 * Query strings are not an authentication channel. Known credential-shaped
 * keys are rejected before routing or authorization, so a future authorizer
 * cannot accidentally accept a token copied into a URL.
 */
export function containsCredentialQuery(rawUrl: string | undefined): boolean {
  if (!rawUrl || !rawUrl.includes("?")) return false;
  try {
    const parsed = new URL(rawUrl, "http://localhost");
    for (const key of parsed.searchParams.keys()) {
      if (CREDENTIAL_QUERY_KEY.test(key)) return true;
    }
    return false;
  } catch {
    // A malformed URL is not a safe place to look for credentials.
    return true;
  }
}

async function requestIsAllowed(request: IncomingMessage, authorize?: DashboardAuthorizer): Promise<boolean> {
  if (containsCredentialQuery(request.url)) return false;
  if (isLoopbackAddress(request.socket?.remoteAddress)) return true;
  if (!authorize) return false;
  try {
    return (await authorize(request)) === true;
  } catch {
    // Authorization failures are deliberately indistinguishable from a
    // missing guard to callers and are never returned in the response.
    return false;
  }
}

function denyAccess(response: ServerResponse): void {
  // Use a generic not-found response to avoid disclosing that this process is
  // an Agent Feed dashboard or whether an authorization guard exists.
  response.statusCode = 404;
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-length", "0");
  response.end();
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(body);
}

function stateToApi(state: DashboardSnapshotState): { status: number; body: unknown } {
  if (state.kind === "ready") {
    return { status: 200, body: { status: "ready", stale: state.stale, ageSeconds: state.ageSeconds, snapshot: state.snapshot } };
  }
  if (state.kind === "empty") return { status: 200, body: { status: "empty" } };
  return {
    status: state.error === "snapshot_unavailable" ? 503 : 502,
    body: { status: "error", error: state.error },
  };
}

function route(request: IncomingMessage): string {
  const raw = request.url ?? "/";
  try {
    return new URL(raw, "http://localhost").pathname;
  } catch {
    return "";
  }
}

export function createAdminDashboardServer(options: AdminDashboardServerOptions): Server {
  return createServer(async (request, response) => {
    if (!(await requestIsAllowed(request, options.authorize))) {
      denyAccess(response);
      return;
    }
    if (request.method !== "GET") {
      response.statusCode = 405;
      response.setHeader("allow", "GET");
      response.end("method_not_allowed");
      return;
    }
    const path = route(request);
    if (path !== "/" && path !== "/api/snapshot") {
      response.statusCode = 404;
      response.end("not_found");
      return;
    }
    const state = await readDashboardState(options.source, options.now);
    if (path === "/api/snapshot") {
      const api = stateToApi(state);
      writeJson(response, api.status, api.body);
      return;
    }
    response.statusCode = state.kind === "error" ? (state.error === "snapshot_unavailable" ? 503 : 502) : 200;
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    response.setHeader("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'");
    response.end(renderDashboardPage(state));
  });
}

export { stateToApi };
