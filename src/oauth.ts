import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import { isRateLimited, keyFingerprint, keyMatches } from "./auth";
import type { Env, GrantProps } from "./env";

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function page(body: string, status = 200): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize cf-gateway-mcp</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 26rem; margin: 3rem auto; padding: 0 1rem; }
  input, button { font: inherit; width: 100%; padding: .6rem; margin-top: .5rem; box-sizing: border-box; }
  button { cursor: pointer; }
  code { overflow-wrap: anywhere; }
  .error { color: #c62828; }
</style>
</head>
<body>${body}</body>
</html>`;
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
    },
  });
}

function approvalPage(request: Request, auth: AuthRequest, clientName: string, error?: string, status = 200): Response {
  const redirectHost = new URL(auth.redirectUri).host;
  const formAction = new URL(request.url);
  return page(
    `<h1>Authorize access</h1>
<p><strong>${escapeHtml(clientName)}</strong> wants to use your Cloudflare token through this server.</p>
<p>It will be sent back to <code>${escapeHtml(redirectHost)}</code>. Approve only if you started this and recognise that site.</p>
${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
<form method="post" action="${escapeHtml(formAction.pathname + formAction.search)}">
  <label for="key">Access key</label>
  <input id="key" name="access_key" type="password" autocomplete="current-password" required autofocus>
  <button type="submit">Approve</button>
</form>`,
    status,
  );
}

async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  let auth: AuthRequest;
  let clientName: string;
  try {
    auth = await env.OAUTH_PROVIDER.parseAuthRequest(request);
    const client = await env.OAUTH_PROVIDER.lookupClient(auth.clientId);
    if (!client) throw new Error("unknown client");
    clientName = client.clientName ?? "An unnamed application";
  } catch {
    return page("<h1>Invalid authorization request</h1>", 400);
  }

  if (request.method === "GET") return approvalPage(request, auth, clientName);
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, POST" } });

  // Checked before comparing, so a blocked address learns nothing even from a correct guess.
  if (await isRateLimited(request, env)) {
    return approvalPage(request, auth, clientName, "Too many attempts. Wait a minute and try again.", 429);
  }
  const form = await request.formData();
  const candidate = form.get("access_key");
  if (typeof candidate !== "string" || !(await keyMatches(candidate, env))) {
    return approvalPage(request, auth, clientName, "Wrong access key.", 401);
  }

  const props: GrantProps = { keyFingerprint: await keyFingerprint(env) };
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: auth,
    userId: "owner",
    metadata: { clientName },
    scope: ["cloudflare"],
    props,
  });
  return new Response(null, { status: 302, headers: { Location: redirectTo } });
}

export const defaultHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/authorize") return handleAuthorize(request, env);
    if (pathname === "/") return new Response("cf-gateway-mcp is running. MCP endpoint: /mcp\n");
    return new Response("Not found", { status: 404 });
  },
};
