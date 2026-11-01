import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env as testEnv } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildUrl } from "../../src/cloudflare";
import type { Env } from "../../src/env";
import worker from "../../src/index";

const env = testEnv as unknown as Env;
const TOKEN = env.CLOUDFLARE_API_TOKEN!;
const KEY = env.MCP_ACCESS_KEY!;
const ORIGIN = "https://gateway.test";
const realFetch = globalThis.fetch;

let nextIp = 1;
/** A fresh address per test, so the shared rate limiter does not leak between tests. */
function freshIp(): string {
  return `203.0.113.${nextIp++}`;
}

async function call(request: Request, overrideEnv: Env = env): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, overrideEnv, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

function rpc(body: object, token: string | null = KEY, ip = freshIp()): Request {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "CF-Connecting-IP": ip,
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return new Request(`${ORIGIN}/mcp`, { method: "POST", headers, body: JSON.stringify(body) });
}

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
};

async function callTool(name: string, args: object = {}, overrideEnv: Env = env) {
  const response = await call(rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }), overrideEnv);
  expect(response.status).toBe(200);
  const { result } = (await response.json()) as { result: { content: { text: string }[]; isError?: boolean } };
  return { text: result.content[0].text, isError: Boolean(result.isError) };
}

/** Replaces Cloudflare with a handler, passing every other request through. */
function mockUpstream(handler: (url: URL, init: RequestInit) => Response) {
  const stub = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.hostname === "api.cloudflare.com") return handler(url, init);
    return realFetch(input, init);
  });
  vi.stubGlobal("fetch", stub);
  return stub;
}

afterEach(() => vi.unstubAllGlobals());

describe("access control", () => {
  it("rejects requests without a key, and points clients at OAuth", async () => {
    const response = await call(rpc(INITIALIZE, null));
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toContain("Bearer");
  });

  it("rejects a wrong key", async () => {
    expect((await call(rpc(INITIALIZE, "wrong-key"))).status).toBe(401);
  });

  it("accepts the access key", async () => {
    const response = await call(rpc(INITIALIZE));
    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).toContain("cf-gateway-mcp");
  });

  it("blocks an address after too many failures", async () => {
    const ip = freshIp();
    const statuses: number[] = [];
    for (let i = 0; i < 25; i++) statuses.push((await call(rpc(INITIALIZE, "wrong-key", ip))).status);
    expect(statuses[0]).toBe(401);
    expect(statuses).toContain(429);
  });

  it("fails closed when secrets are missing or the key is too short", async () => {
    expect((await call(rpc(INITIALIZE), { ...env, MCP_ACCESS_KEY: undefined })).status).toBe(503);
    expect((await call(rpc(INITIALIZE, "short"), { ...env, MCP_ACCESS_KEY: "short" })).status).toBe(503);
    expect((await call(rpc(INITIALIZE), { ...env, CLOUDFLARE_API_TOKEN: undefined })).status).toBe(503);
  });

  it("does not offer streaming on GET", async () => {
    const request = new Request(`${ORIGIN}/mcp`, { headers: { Authorization: `Bearer ${KEY}` } });
    expect((await call(request)).status).toBe(405);
  });
});

describe("path checks", () => {
  const base = "https://api.cloudflare.com/client/v4";

  it("allows normal API paths", () => {
    expect(buildUrl(base, "/zones", { per_page: 5 }).href).toBe(`${base}/zones?per_page=5`);
    expect(buildUrl(base, "/zones?name=a.com").href).toBe(`${base}/zones?name=a.com`);
    expect(buildUrl(base, "/accounts/a/storage/kv/namespaces/b/values/x%2Fy").pathname).toContain("x%2Fy");
  });

  it.each([
    "zones",
    "https://evil.example/x",
    "//evil.example/x",
    "/../../evil",
    "/zones/../../../evil",
    "/%2e%2e/%2e%2e/evil",
    "/.%2E/evil",
    "/x\\y",
    "/@evil.example",
    "/zones#fragment",
    "/zones\nHost: evil",
  ])("refuses %s", (path) => {
    expect(() => buildUrl(base, path)).toThrow();
  });

  it("returns refused paths as tool errors without calling upstream", async () => {
    const stub = mockUpstream(() => new Response("{}"));
    const { text, isError } = await callTool("cloudflare_request", { method: "GET", path: "https://evil.example/" });
    expect(isError).toBe(true);
    expect(text).toContain("path must start");
    expect(stub).not.toHaveBeenCalled();
  });
});

describe("cloudflare_request", () => {
  it("sends the token to Cloudflare and returns the body", async () => {
    let seen: { url: URL; auth: string | null; method?: string; body?: unknown; type: string | null } | undefined;
    mockUpstream((url, init) => {
      const headers = new Headers(init.headers);
      seen = { url, auth: headers.get("Authorization"), method: init.method, body: init.body, type: headers.get("Content-Type") };
      return Response.json({ success: true, result: ["例子"] });
    });
    const { text, isError } = await callTool("cloudflare_request", {
      method: "POST",
      path: "/zones/abc/dns_records",
      query: { page: 2 },
      body: { type: "A", name: "中文" },
    });
    expect(isError).toBe(false);
    expect(text).toContain("例子");
    expect(seen?.url.href).toBe("https://api.cloudflare.com/client/v4/zones/abc/dns_records?page=2");
    expect(seen?.auth).toBe(`Bearer ${TOKEN}`);
    expect(seen?.method).toBe("POST");
    expect(seen?.type).toBe("application/json");
    expect(seen?.body).toBe('{"type":"A","name":"中文"}');
  });

  it("never follows redirects", async () => {
    let redirect: string | undefined;
    mockUpstream((_url, init) => {
      redirect = init.redirect;
      return new Response("{}");
    });
    await callTool("cloudflare_request", { method: "GET", path: "/zones" });
    expect(redirect).toBe("manual");
  });

  it("removes secrets from responses", async () => {
    mockUpstream(() => Response.json({ echoed: TOKEN, key: KEY }));
    const { text } = await callTool("cloudflare_request", { method: "GET", path: "/zones" });
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(KEY);
    expect(text).toContain("[REDACTED]");
  });

  it("removes secrets from error messages", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error(`connection failed for ${TOKEN}`);
    });
    const { text, isError } = await callTool("cloudflare_request", { method: "GET", path: "/zones" });
    expect(isError).toBe(true);
    expect(text).not.toContain(TOKEN);
  });

  it("explains 401 and 403 from Cloudflare", async () => {
    mockUpstream(() => Response.json({ success: false, errors: [{ message: "Authentication error" }] }, { status: 403 }));
    const forbidden = await callTool("cloudflare_request", { method: "GET", path: "/zones" });
    expect(forbidden.isError).toBe(true);
    expect(forbidden.text).toContain("HTTP 403");
    expect(forbidden.text).toContain("lacks this permission");

    mockUpstream(() => Response.json({ success: false }, { status: 401 }));
    const unauthorized = await callTool("cloudflare_request", { method: "GET", path: "/zones" });
    expect(unauthorized.isError).toBe(true);
    expect(unauthorized.text).toContain("HTTP 401");
  });

  it("truncates huge responses", async () => {
    mockUpstream(() => new Response("x".repeat(300_000)));
    const { text } = await callTool("cloudflare_request", { method: "GET", path: "/zones" });
    expect(text.length).toBeLessThan(201_000);
    expect(text).toContain("[truncated");
  });
});

describe("cloudflare_status", () => {
  it("reports an active token and its only account as the default", async () => {
    mockUpstream((url) => {
      if (url.pathname.endsWith("/accounts")) return Response.json({ result: [{ id: "acc1", name: "Mine", extra: "x" }] });
      return Response.json({ success: true });
    });
    const status = JSON.parse((await callTool("cloudflare_status")).text);
    expect(status).toEqual({ token: "active", default_account_id: "acc1", accounts: [{ id: "acc1", name: "Mine" }] });
  });

  it("verifies account-owned tokens on the account route", async () => {
    mockUpstream((url) => {
      if (url.pathname.endsWith("/user/tokens/verify")) return Response.json({ success: false }, { status: 401 });
      if (url.pathname.endsWith("/accounts/acc9/tokens/verify")) return Response.json({ success: true });
      return Response.json({ success: false }, { status: 403 });
    });
    const { text } = await callTool("cloudflare_status", {}, { ...env, CLOUDFLARE_ACCOUNT_ID: "acc9" });
    expect(JSON.parse(text).token).toBe("active");
  });

  it("flags an invalid token", async () => {
    mockUpstream(() => Response.json({ success: false }, { status: 401 }));
    const { text, isError } = await callTool("cloudflare_status");
    expect(isError).toBe(true);
    expect(JSON.parse(text).token).toBe("invalid");
  });
});

describe("cloudflare_deploy_worker", () => {
  const worker = {
    name: "my-app",
    main_module: "index.js",
    modules: [{ name: "index.js", content: "export default {}" }],
    compatibility_date: "2026-10-20",
  };

  it("uploads modules as multipart to the default account", async () => {
    let path = "";
    let form: FormData | undefined;
    mockUpstream((url, init) => {
      if (url.pathname.endsWith("/accounts")) return Response.json({ result: [{ id: "acc1", name: "Mine" }] });
      path = url.pathname;
      form = init.body as FormData;
      return Response.json({ success: true });
    });
    const { isError } = await callTool("cloudflare_deploy_worker", { ...worker, keep_bindings: ["secret_text"] });
    expect(isError).toBe(false);
    expect(path).toBe("/client/v4/accounts/acc1/workers/scripts/my-app");
    const metadata = JSON.parse(form?.get("metadata") as string);
    expect(metadata.main_module).toBe("index.js");
    expect(metadata.keep_bindings).toEqual(["secret_text"]);
    expect((form?.get("index.js") as File).type).toBe("application/javascript+module");
  });

  it("refuses an unsupported module type and a missing main module", async () => {
    mockUpstream(() => Response.json({ result: [{ id: "acc1", name: "Mine" }] }));
    const binary = await callTool("cloudflare_deploy_worker", { ...worker, main_module: "a.wasm", modules: [{ name: "a.wasm", content: "x" }] });
    expect(binary.text).toContain("Unsupported module type");
    const missing = await callTool("cloudflare_deploy_worker", { ...worker, main_module: "other.js" });
    expect(missing.text).toContain("is not in modules");
  });

  it("asks for an account when several are available", async () => {
    mockUpstream(() => Response.json({ result: [{ id: "a", name: "A" }, { id: "b", name: "B" }] }));
    const { text, isError } = await callTool("cloudflare_deploy_worker", worker);
    expect(isError).toBe(true);
    expect(text).toContain("No default account");
  });
});

describe("OAuth", () => {
  async function pkce() {
    const verifier = btoa(crypto.getRandomValues(new Uint8Array(32)).join("")).replace(/[^a-zA-Z0-9]/g, "").slice(0, 64);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    const challenge = btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return { verifier, challenge };
  }

  async function startAuthorization(ip: string) {
    const redirectUri = "https://client.example/callback";
    const registered = await call(
      new Request(`${ORIGIN}/oauth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
        body: JSON.stringify({ redirect_uris: [redirectUri], client_name: "<b>Evil</b> Client", token_endpoint_auth_method: "none" }),
      }),
    );
    expect(registered.status).toBe(201);
    const { client_id: clientId } = (await registered.json()) as { client_id: string };
    const { verifier, challenge } = await pkce();
    const params = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      state: "state123",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    return { clientId, redirectUri, verifier, authorizeUrl: `${ORIGIN}/authorize?${params}` };
  }

  function submitKey(authorizeUrl: string, key: string, ip: string) {
    return call(
      new Request(authorizeUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "CF-Connecting-IP": ip },
        body: new URLSearchParams({ access_key: key }),
        redirect: "manual",
      }),
    );
  }

  async function getAccessToken(ip: string) {
    const flow = await startAuthorization(ip);
    const approved = await submitKey(flow.authorizeUrl, KEY, ip);
    expect(approved.status).toBe(302);
    const location = new URL(approved.headers.get("Location")!);
    expect(location.origin + location.pathname).toBe(flow.redirectUri);
    expect(location.searchParams.get("state")).toBe("state123");
    const exchanged = await call(
      new Request(`${ORIGIN}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: location.searchParams.get("code")!,
          client_id: flow.clientId,
          redirect_uri: flow.redirectUri,
          code_verifier: flow.verifier,
        }),
      }),
    );
    expect(exchanged.status).toBe(200);
    return ((await exchanged.json()) as { access_token: string }).access_token;
  }

  it("publishes discovery metadata", async () => {
    const response = await call(new Request(`${ORIGIN}/.well-known/oauth-authorization-server`));
    const metadata = (await response.json()) as { authorization_endpoint: string };
    expect(metadata.authorization_endpoint).toBe(`${ORIGIN}/authorize`);
  });

  it("shows who is asking on the approval page, escaped, and cannot be framed", async () => {
    const { authorizeUrl } = await startAuthorization(freshIp());
    const response = await call(new Request(authorizeUrl));
    const html = await response.text();
    expect(html).toContain("client.example");
    expect(html).not.toContain("<b>Evil</b>");
    expect(html).not.toContain(KEY);
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
  });

  it("refuses a wrong key without issuing a code", async () => {
    const ip = freshIp();
    const { authorizeUrl } = await startAuthorization(ip);
    const response = await submitKey(authorizeUrl, "wrong", ip);
    expect(response.status).toBe(401);
    expect(response.headers.get("Location")).toBeNull();
  });

  it("refuses a redirect_uri the client did not register", async () => {
    const ip = freshIp();
    const { authorizeUrl } = await startAuthorization(ip);
    const tampered = authorizeUrl.replace(encodeURIComponent("https://client.example/callback"), encodeURIComponent("https://evil.example/cb"));
    const response = await submitKey(tampered, KEY, ip);
    expect(response.status).toBe(400);
  });

  it("rate limits guesses at the approval page", async () => {
    const ip = freshIp();
    const { authorizeUrl } = await startAuthorization(ip);
    const statuses: number[] = [];
    for (let i = 0; i < 25; i++) statuses.push((await submitKey(authorizeUrl, "wrong", ip)).status);
    expect(statuses).toContain(429);
  });

  it("issues a token that can use MCP", async () => {
    const accessToken = await getAccessToken(freshIp());
    expect(accessToken).not.toBe(KEY);
    const response = await call(rpc(INITIALIZE, accessToken));
    expect(response.status).toBe(200);
  });

  it("cuts off OAuth tokens when the access key is rotated", async () => {
    const accessToken = await getAccessToken(freshIp());
    const rotated = { ...env, MCP_ACCESS_KEY: "rotated-access-key-that-is-long-enough-111" };
    expect((await call(rpc(INITIALIZE, accessToken), rotated)).status).toBe(401);
  });
});
