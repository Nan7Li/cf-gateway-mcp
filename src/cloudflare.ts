import type { Env } from "./env";

const DEFAULT_API_BASE = "https://api.cloudflare.com/client/v4";
const MAX_RESPONSE_CHARS = 200_000;

export interface ApiResult {
  status: number;
  text: string;
}

export function apiBase(env: Env): string {
  if (env.CF_API_BASE && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(env.CF_API_BASE)) {
    return env.CF_API_BASE.replace(/\/$/, "");
  }
  return DEFAULT_API_BASE;
}

/** Builds the upstream URL, or throws if the path could leave the Cloudflare API. */
export function buildUrl(base: string, path: string, query?: Record<string, string | number | boolean>): URL {
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new Error("path must start with a single / and be relative to the Cloudflare API, e.g. /zones");
  }
  // eslint-disable-next-line no-control-regex
  if (/[\\@#\u0000-\u001f]/.test(path) || /(^|\/)(\.|%2e){2}(\/|\?|$)/i.test(path) || /%2e%2e|%5c|%00/i.test(path)) {
    throw new Error("path contains characters that are not allowed: .. \\ @ # or control characters");
  }
  const url = new URL(base + path);
  const baseUrl = new URL(base);
  if (url.origin !== baseUrl.origin || !url.pathname.startsWith(`${baseUrl.pathname.replace(/\/$/, "")}/`)) {
    throw new Error("path resolves outside the Cloudflare API");
  }
  for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, String(value));
  return url;
}

/** Removes our secrets from any text about to leave the Worker. */
export function scrub(text: string, env: Env): string {
  let clean = text;
  for (const secret of [env.CLOUDFLARE_API_TOKEN, env.MCP_ACCESS_KEY]) {
    if (secret) clean = clean.replaceAll(secret, "[REDACTED]");
  }
  return clean;
}

export async function callCloudflare(
  env: Env,
  method: string,
  path: string,
  options: {
    query?: Record<string, string | number | boolean>;
    body?: BodyInit;
    contentType?: string;
  } = {},
): Promise<ApiResult> {
  const token = env.CLOUDFLARE_API_TOKEN;
  if (!token) throw new Error("CLOUDFLARE_API_TOKEN is not set on this Worker");

  const headers = new Headers({ Authorization: `Bearer ${token}` });
  if (options.contentType) headers.set("Content-Type", options.contentType);
  const response = await fetch(buildUrl(apiBase(env), path, options.query), {
    method,
    headers,
    body: options.body,
    // Never follow a redirect: it could carry the Authorization header to another host.
    redirect: "manual",
  });
  return { status: response.status, text: await response.text() };
}

export function truncate(text: string): string {
  if (text.length <= MAX_RESPONSE_CHARS) return text;
  return `${text.slice(0, MAX_RESPONSE_CHARS)}\n[truncated: response is ${text.length} characters. Narrow the request with per_page or filters.]`;
}

interface Account {
  id: string;
  name: string;
}

export async function listAccounts(env: Env): Promise<Account[]> {
  const { status, text } = await callCloudflare(env, "GET", "/accounts", { query: { per_page: 50 } });
  if (status !== 200) return [];
  const result = (JSON.parse(text) as { result?: Account[] }).result ?? [];
  return result.map(({ id, name }) => ({ id, name }));
}

/** The account to use when a tool call does not name one, or null if that is ambiguous. */
export function defaultAccountId(env: Env, accounts: Account[]): string | null {
  if (env.CLOUDFLARE_ACCOUNT_ID) return env.CLOUDFLARE_ACCOUNT_ID;
  return accounts.length === 1 ? accounts[0].id : null;
}

/** Account-owned tokens only verify on the account route, user tokens only on the user route. */
export async function isTokenValid(env: Env, accountId: string | null): Promise<boolean> {
  if ((await callCloudflare(env, "GET", "/user/tokens/verify")).status === 200) return true;
  if (!accountId) return false;
  return (await callCloudflare(env, "GET", `/accounts/${encodeURIComponent(accountId)}/tokens/verify`)).status === 200;
}
