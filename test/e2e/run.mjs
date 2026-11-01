// Runs the real Worker under `wrangler dev` against a fake Cloudflare API and connects with the MCP SDK client.
import assert from "node:assert/strict";
import { execSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ROOT } from "../../scripts/lib/common.mjs";

const TOKEN = "e2e-fake-cloudflare-token";
const KEY = "e2e-fake-access-key-long-enough-0000000";
const UPSTREAM_PORT = 18798;
const WORKER_PORT = 18799;
const BASE = `http://127.0.0.1:${WORKER_PORT}`;

const seen = [];
const upstream = createServer((request, response) => {
  seen.push({ url: request.url, auth: request.headers.authorization });
  response.setHeader("Content-Type", "application/json");
  if (request.headers.authorization !== `Bearer ${TOKEN}`) {
    response.statusCode = 401;
    return response.end('{"success":false}');
  }
  if (request.url.startsWith("/accounts")) return response.end('{"result":[{"id":"acc1","name":"E2E"}]}');
  if (request.url === "/zones") return response.end('{"result":[{"name":"例子.com"}]}');
  return response.end('{"success":true}');
});
await new Promise((resolve) => upstream.listen(UPSTREAM_PORT, "127.0.0.1", resolve));

// A throwaway secrets file outside the project, holding only fake values.
const folder = mkdtempSync(join(tmpdir(), "cfgw-e2e-"));
const envFile = join(folder, "dev.vars");
writeFileSync(envFile, `CLOUDFLARE_API_TOKEN=${TOKEN}\nMCP_ACCESS_KEY=${KEY}\nCF_API_BASE=http://127.0.0.1:${UPSTREAM_PORT}\n`);

const worker = spawn(process.execPath, [join(ROOT, "node_modules/wrangler/bin/wrangler.js"), "dev", "--port", String(WORKER_PORT), "--ip", "127.0.0.1", "--env-file", envFile], {
  cwd: ROOT,
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
});
let workerLog = "";
worker.stdout.on("data", (chunk) => (workerLog += chunk));
worker.stderr.on("data", (chunk) => (workerLog += chunk));

function stopWorker() {
  if (process.platform === "win32") {
    try {
      execSync(`taskkill /pid ${worker.pid} /T /F`, { stdio: "ignore" });
    } catch {}
  } else {
    worker.kill();
  }
}

async function waitForWorker() {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      if ((await fetch(`${BASE}/`)).status === 200) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`wrangler dev did not start:\n${workerLog}`);
}

async function connect(bearer) {
  const client = new Client({ name: "e2e", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${bearer}` } } }));
  return client;
}

async function exerciseTools(client) {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ["cloudflare_deploy_worker", "cloudflare_request", "cloudflare_status"]);

  const status = JSON.parse((await client.callTool({ name: "cloudflare_status", arguments: {} })).content[0].text);
  assert.equal(status.token, "active");
  assert.equal(status.default_account_id, "acc1");

  const zones = await client.callTool({ name: "cloudflare_request", arguments: { method: "GET", path: "/zones" } });
  assert.ok(zones.content[0].text.includes("例子.com"));
  assert.ok(!JSON.stringify(zones).includes(TOKEN));

  const refused = await client.callTool({ name: "cloudflare_request", arguments: { method: "GET", path: "https://evil.example/" } });
  assert.equal(refused.isError, true);
}

async function oauthAccessToken() {
  // Follow the discovery chain a real client uses, starting from the 401.
  const challenge = await fetch(`${BASE}/mcp`, { method: "POST" });
  assert.equal(challenge.status, 401);
  const metadataUrl = /resource_metadata="([^"]+)"/.exec(challenge.headers.get("WWW-Authenticate"))?.[1];
  assert.ok(metadataUrl, "401 must point to resource metadata");
  const resource = await (await fetch(metadataUrl)).json();
  assert.equal(resource.resource, `${BASE}/mcp`);
  const server = await (await fetch(`${resource.authorization_servers[0]}/.well-known/oauth-authorization-server`)).json();

  const redirectUri = "http://127.0.0.1:9/callback";
  const client = await (
    await fetch(server.registration_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: [redirectUri], client_name: "E2E", token_endpoint_auth_method: "none" }),
    })
  ).json();

  const verifier = randomBytes(32).toString("base64url");
  const authorize = new URL(server.authorization_endpoint);
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: redirectUri,
    state: "s1",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    resource: resource.resource,
  }).toString();

  assert.equal((await fetch(authorize)).status, 200);
  const wrong = await fetch(authorize, { method: "POST", body: new URLSearchParams({ access_key: "wrong" }), redirect: "manual" });
  assert.equal(wrong.status, 401);
  const approved = await fetch(authorize, { method: "POST", body: new URLSearchParams({ access_key: KEY }), redirect: "manual" });
  assert.equal(approved.status, 302);
  const code = new URL(approved.headers.get("Location")).searchParams.get("code");

  const tokens = await (
    await fetch(server.token_endpoint, {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: client.client_id,
        redirect_uri: redirectUri,
        code_verifier: verifier,
        resource: resource.resource,
      }),
    })
  ).json();
  assert.ok(tokens.access_token, "token response must have an access token");
  return tokens.access_token;
}

let failed = false;
try {
  await waitForWorker();

  assert.equal((await fetch(`${BASE}/mcp`, { method: "POST" })).status, 401);
  console.log("PASS  no key is rejected");

  const keyClient = await connect(KEY);
  await exerciseTools(keyClient);
  await keyClient.close();
  console.log("PASS  access key: SDK client lists and calls all tools");

  const accessToken = await oauthAccessToken();
  console.log("PASS  OAuth: discovery, registration, approval and token exchange");

  const oauthClient = await connect(accessToken);
  await exerciseTools(oauthClient);
  await oauthClient.close();
  console.log("PASS  OAuth token: SDK client lists and calls all tools");

  assert.ok(seen.length > 0 && seen.every(({ auth }) => auth === `Bearer ${TOKEN}`));
  console.log("PASS  upstream only ever received the Cloudflare token");
  assert.ok(!workerLog.includes(TOKEN) && !workerLog.includes(KEY));
  console.log("PASS  secrets never appeared in the Worker log");
} catch (error) {
  failed = true;
  console.error(`FAIL  ${error.stack}`);
  console.error(workerLog.slice(-1500).replaceAll(TOKEN, "[TOKEN]").replaceAll(KEY, "[KEY]"));
} finally {
  stopWorker();
  upstream.close();
  rmSync(folder, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
