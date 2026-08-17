import assert from "node:assert/strict";
import test from "node:test";
import {
  WebhookTransport,
  WebhookTransportError,
  classifyWebhookResult,
  isPublicAddress,
  resolveSafeEndpoint,
  type DnsResolver,
  type HttpClient,
  type HttpRequest,
  type HttpResponse,
  type ResolvedAddress,
} from "../src/index.ts";
import type {
  DeliveryEndpoint,
  DeliveryTransportRequest,
} from "@agent-feed/delivery-core";

const publicAddress: ResolvedAddress = { address: "93.184.216.34", family: 4 };

class FakeDns implements DnsResolver {
  readonly addresses: readonly ResolvedAddress[];
  pending = false;
  calls: string[] = [];

  constructor(addresses: readonly ResolvedAddress[] = [publicAddress]) {
    this.addresses = addresses;
  }

  async resolve(hostname: string): Promise<readonly ResolvedAddress[]> {
    this.calls.push(hostname);
    if (this.pending) return new Promise<readonly ResolvedAddress[]>(() => { /* timeout is the assertion */ });
    return this.addresses;
  }
}

class FakeHttp implements HttpClient {
  requests: HttpRequest[] = [];
  response: HttpResponse = { status: 204, body: new Uint8Array() };
  pending = false;

  async request(input: HttpRequest): Promise<HttpResponse> {
    this.requests.push(input);
    if (this.pending) return new Promise<HttpResponse>(() => { /* timeout is the assertion */ });
    return this.response;
  }
}

function endpoint(url = "https://example.test/webhook"): DeliveryEndpoint {
  return { endpointRef: url, signingKeyId: "key-a" };
}

function request(overrides: Partial<DeliveryTransportRequest> = {}): DeliveryTransportRequest {
  const body = "{\"attempt\":1,\"event_id\":\"evt_12345678\"}";
  const headers = {
    "content-type": "application/json",
    "x-agent-feed-event-id": "evt_12345678",
    "x-agent-feed-delivery-id": "del_12345678",
    "x-agent-feed-attempt": "1",
    "x-agent-feed-protocol-version": "0.1",
    "x-agent-feed-timestamp": "1760745600",
    "x-agent-feed-key-id": "key-a",
    "x-agent-feed-signature": "signature",
    "x-agent-feed-trace-id": "0123456789abcdef0123456789abcdef",
  };
  return {
    endpoint: endpoint(),
    eventId: "evt_12345678",
    deliveryId: "del_12345678",
    traceId: "trace-a",
    attempt: 1,
    replayGeneration: 0,
    body,
    signed: {
      eventId: "evt_12345678",
      deliveryId: "del_12345678",
      rawBody: body,
      signature: "signature",
      timestampSeconds: 1760745600,
      attempt: 1,
      replayGeneration: 0,
      traceId: "trace-a",
      keyId: "key-a",
      headers,
    },
    headers,
    ...overrides,
  };
}

test("sends the exact signed raw body and transport headers", async () => {
  const http = new FakeHttp();
  const transport = new WebhookTransport({ dnsResolver: new FakeDns(), httpClient: http });
  const input = request();

  const response = await transport.send(input);

  assert.equal(response.status, 204);
  assert.equal(http.requests.length, 1);
  assert.equal(http.requests[0]!.body, input.body);
  assert.equal(http.requests[0]!.headers["x-agent-feed-attempt"], "1");
  assert.equal(http.requests[0]!.headers["x-agent-feed-delivery-id"], "del_12345678");
  assert.equal(http.requests[0]!.headers["x-agent-feed-protocol-version"], "0.1");
  assert.equal(http.requests[0]!.redirect, "error");
  assert.equal(http.requests[0]!.resolvedAddresses[0]!.address, publicAddress.address);
});

test("rejects unsafe schemes, ports, credentials, queries, and IP literals", async () => {
  const resolver = new FakeDns();
  const unsafe = [
    ["http://example.test/webhook", "endpoint_scheme_not_allowed"],
    ["https://example.test:8443/webhook", "endpoint_port_not_allowed"],
    ["https://user:pass@example.test/webhook", "endpoint_credentials_not_allowed"],
    ["https://example.test/webhook?token=secret", "endpoint_query_not_allowed"],
    ["https://127.0.0.1/webhook", "endpoint_ip_literal_not_allowed"],
  ] as const;
  for (const [url, code] of unsafe) {
    await assert.rejects(
      () => resolveSafeEndpoint(url, resolver),
      (error: unknown) => error instanceof WebhookTransportError && error.code === code,
    );
  }
  assert.deepEqual(resolver.calls, []);
});

test("rejects loopback and mixed public/private DNS answers", async () => {
  await assert.rejects(
    () => resolveSafeEndpoint("https://internal.example.test/webhook", new FakeDns([{ address: "127.0.0.1", family: 4 }])),
    (error: unknown) => error instanceof WebhookTransportError && error.code === "private_address_rejected",
  );
  await assert.rejects(
    () => resolveSafeEndpoint("https://mixed.example.test/webhook", new FakeDns([publicAddress, { address: "10.0.0.4", family: 4 }])),
    (error: unknown) => error instanceof WebhookTransportError && error.code === "private_address_rejected",
  );
  await assert.rejects(
    () => resolveSafeEndpoint("https://link-local.example.test/webhook", new FakeDns([{ address: "fe80::1", family: 6 }])),
    (error: unknown) => error instanceof WebhookTransportError && error.code === "private_address_rejected",
  );
  await assert.rejects(
    () => resolveSafeEndpoint("https://mapped-private.example.test/webhook", new FakeDns([{ address: "::ffff:192.168.1.1", family: 6 }])),
    (error: unknown) => error instanceof WebhookTransportError && error.code === "private_address_rejected",
  );
  await assert.rejects(
    () => resolveSafeEndpoint("https://compatible-private.example.test/webhook", new FakeDns([{ address: "::192.168.1.1", family: 6 }])),
    (error: unknown) => error instanceof WebhookTransportError && error.code === "private_address_rejected",
  );
  await assert.rejects(
    () => resolveSafeEndpoint("https://six-to-four-private.example.test/webhook", new FakeDns([{ address: "2002:c0a8:0101::", family: 6 }])),
    (error: unknown) => error instanceof WebhookTransportError && error.code === "private_address_rejected",
  );
  await assert.rejects(
    () => resolveSafeEndpoint("https://nat64-private.example.test/webhook", new FakeDns([{ address: "64:ff9b::c0a8:0101", family: 6 }])),
    (error: unknown) => error instanceof WebhookTransportError && error.code === "private_address_rejected",
  );
  assert.equal(isPublicAddress("::192.168.1.1", 6), false);
  assert.equal(isPublicAddress("2002:c0a8:0101::", 6), false);
});

test("rejects oversized request bodies before endpoint and DNS resolution", async () => {
  const dns = new FakeDns();
  const http = new FakeHttp();
  await assert.rejects(
    () => new WebhookTransport({ dnsResolver: dns, httpClient: http, maxRequestBytes: 3 }).send(request({ body: "1234" })),
    (error: unknown) => error instanceof WebhookTransportError && error.code === "request_body_too_large",
  );
  assert.deepEqual(dns.calls, []);
  assert.equal(http.requests.length, 0);
});

test("denies redirects and bounds response bodies", async () => {
  const redirectHttp = new FakeHttp();
  redirectHttp.response = { status: 302, headers: { location: "https://other.example/" }, body: new Uint8Array() };
  await assert.rejects(
    () => new WebhookTransport({ dnsResolver: new FakeDns(), httpClient: redirectHttp }).send(request()),
    (error: unknown) => error instanceof WebhookTransportError && error.code === "redirect_denied" && error.status === 302,
  );

  const oversizedHttp = new FakeHttp();
  oversizedHttp.response = { status: 204, body: new Uint8Array([1, 2, 3, 4]) };
  await assert.rejects(
    () => new WebhookTransport({ dnsResolver: new FakeDns(), httpClient: oversizedHttp, maxResponseBytes: 3 }).send(request()),
    (error: unknown) => error instanceof WebhookTransportError && error.code === "response_body_too_large",
  );
});

test("times out injected HTTP clients without making real external calls", async () => {
  const http = new FakeHttp();
  http.pending = true;
  await assert.rejects(
    () => new WebhookTransport({ dnsResolver: new FakeDns(), httpClient: http, timeoutMs: 5 }).send(request()),
    (error: unknown) => error instanceof WebhookTransportError && error.code === "request_timeout" && error.retryable,
  );
});

test("applies the timeout to injected endpoint and DNS resolution too", async () => {
  const dns = new FakeDns();
  dns.pending = true;
  const http = new FakeHttp();
  await assert.rejects(
    () => new WebhookTransport({ dnsResolver: dns, httpClient: http, timeoutMs: 5 }).send(request()),
    (error: unknown) => error instanceof WebhookTransportError && error.code === "request_timeout",
  );
  assert.equal(http.requests.length, 0);
});

test("classifies HTTP and transport failures explicitly", () => {
  const now = new Date("2026-08-18T00:00:00.000Z");
  assert.deepEqual(classifyWebhookResult({ status: 204 }, now), { kind: "success", status: 204 });
  assert.equal(classifyWebhookResult({ status: 503 }, now).kind, "retry");
  assert.equal(classifyWebhookResult({ status: 400 }, now).kind, "permanent");
  const failure = new WebhookTransportError({
    code: "private_address_rejected",
    message: "endpoint resolved to a non-public address",
    retryable: false,
    status: null,
    retryAfterSeconds: null,
  });
  const decision = classifyWebhookResult(failure, now);
  assert.equal(decision.kind, "permanent");
  assert.equal(decision.code, "private_address_rejected");
});
