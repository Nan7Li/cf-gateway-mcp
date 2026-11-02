import assert from "node:assert/strict";
import { test } from "node:test";
import { isReadOnly, parseRequest, run } from "../../templates/requests-repo/.github/gateway/handle.mjs";

const KEY = "fake-access-key-for-gateway-tests-000000";
const MCP_URL = "https://gateway.test/mcp";
const ENV = { MCP_URL, MCP_ACCESS_KEY: KEY, GITHUB_TOKEN: "fake-github-token" };

function makeEvent(body, overrides = {}) {
  return {
    action: "opened",
    sender: { login: "owner", type: "User" },
    repository: { private: true, full_name: "owner/requests", owner: { login: "owner" } },
    issue: { number: 7, body },
    ...overrides,
  };
}

/** A fake GitHub and MCP Worker that records every call. */
function fakeWorld({ labels = [], events = [], toolResult = { content: [{ text: '{"ok":true}' }] }, mcpStatus = 200 } = {}) {
  const world = { comments: [], added: [], removed: [], closed: false, mcpCalls: [] };
  world.fetchImpl = async (url, init = {}) => {
    const { pathname } = new URL(url);
    if (String(url) === MCP_URL) {
      world.mcpCalls.push({ auth: new Headers(init.headers).get("Authorization"), params: JSON.parse(init.body).params });
      if (mcpStatus !== 200) return new Response("no", { status: mcpStatus });
      return Response.json({ result: toolResult });
    }
    if (init.method === "GET" && pathname.endsWith("/events")) return Response.json(events);
    if (init.method === "GET") return Response.json({ labels: labels.map((name) => ({ name })) });
    if (pathname.endsWith("/comments")) {
      world.comments.push(JSON.parse(init.body).body);
      return Response.json({});
    }
    if (init.method === "POST" && pathname.endsWith("/labels")) {
      world.added.push(...JSON.parse(init.body).labels);
      return Response.json([]);
    }
    if (init.method === "DELETE") {
      world.removed.push(decodeURIComponent(pathname.split("/").pop()));
      return Response.json([]);
    }
    if (init.method === "PATCH") {
      world.closed = JSON.parse(init.body).state === "closed";
      return Response.json({});
    }
    throw new Error(`unexpected request ${init.method} ${url}`);
  };
  return world;
}

const WRITE = '{"method":"DELETE","path":"/zones/abc"}';
const ownerLabel = { event: "labeled", label: { name: "approved" }, actor: { login: "owner" }, performed_via_github_app: null };
const labeledEvent = (overrides = {}) => makeEvent(WRITE, { action: "labeled", label: { name: "approved" }, ...overrides });

test("parses fenced and bare requests", () => {
  assert.equal(parseRequest('{"path":"/zones"}').arguments.method, "GET");
  assert.equal(parseRequest('Please:\n```json\n{"method":"post","path":"/x"}\n```').arguments.method, "POST");
  assert.deepEqual(parseRequest('{"tool":"cloudflare_status"}'), { tool: "cloudflare_status", arguments: {} });
});

test("rejects bad requests", () => {
  assert.throws(() => parseRequest("hello"), /must be JSON/);
  assert.throws(() => parseRequest('{"method":"GET"}'), /needs a "path"/);
  assert.throws(() => parseRequest('{"tool":"something_else"}'), /Unknown tool/);
  assert.throws(() => parseRequest("null"), /JSON object/);
});

test("only status and GET count as read-only", () => {
  assert.equal(isReadOnly(parseRequest('{"tool":"cloudflare_status"}')), true);
  assert.equal(isReadOnly(parseRequest('{"path":"/zones"}')), true);
  assert.equal(isReadOnly(parseRequest(WRITE)), false);
  assert.equal(isReadOnly(parseRequest('{"tool":"cloudflare_request","arguments":{"method":"POST","path":"/x"}}')), false);
  assert.equal(isReadOnly(parseRequest('{"tool":"cloudflare_deploy_worker","arguments":{}}')), false);
});

test("refuses to do anything in a public repository", async () => {
  const world = fakeWorld();
  const event = makeEvent('{"path":"/zones"}', { repository: { private: false, full_name: "owner/requests", owner: { login: "owner" } } });
  assert.match(await run({ event, env: ENV, fetchImpl: world.fetchImpl }), /not private/);
  assert.equal(world.mcpCalls.length, 0);
  assert.equal(world.comments.length, 0);
});

test("runs a read right away, posts the result and closes", async () => {
  const world = fakeWorld({ toolResult: { content: [{ text: '{"result":["例子"]}' }] } });
  assert.equal(await run({ event: makeEvent('{"path":"/zones"}'), env: ENV, fetchImpl: world.fetchImpl }), "done");
  assert.equal(world.mcpCalls[0].auth, `Bearer ${KEY}`);
  assert.equal(world.mcpCalls[0].params.name, "cloudflare_request");
  assert.equal(world.mcpCalls[0].params.arguments.path, "/zones");
  assert.ok(world.comments[0].includes("例子"));
  assert.deepEqual(world.added, ["done"]);
  assert.equal(world.closed, true);
});

test("holds a write until approved, without calling Cloudflare", async () => {
  const world = fakeWorld();
  assert.equal(await run({ event: makeEvent(WRITE), env: ENV, fetchImpl: world.fetchImpl }), "waiting for approval");
  assert.equal(world.mcpCalls.length, 0);
  assert.deepEqual(world.added, ["needs-approval"]);
  assert.equal(world.closed, false);
});

test("runs a write when the owner adds the label directly", async () => {
  const world = fakeWorld({ labels: ["needs-approval", "approved"], events: [ownerLabel] });
  assert.equal(await run({ event: labeledEvent(), env: ENV, fetchImpl: world.fetchImpl }), "done");
  assert.equal(world.mcpCalls.length, 1);
  assert.deepEqual(world.removed, ["needs-approval"]);
});

test("an agent's GitHub App cannot approve its own request", async () => {
  const world = fakeWorld({ events: [{ ...ownerLabel, performed_via_github_app: { slug: "some-connector" } }] });
  assert.match(await run({ event: labeledEvent(), env: ENV, fetchImpl: world.fetchImpl }), /not approved/);
  assert.equal(world.mcpCalls.length, 0);
  assert.deepEqual(world.removed, ["approved"]);
});

test("a label from a bot or another user does not approve", async () => {
  for (const sender of [{ login: "some-bot[bot]", type: "Bot" }, { login: "someone", type: "User" }]) {
    const world = fakeWorld({ events: [ownerLabel] });
    assert.match(await run({ event: labeledEvent({ sender }), env: ENV, fetchImpl: world.fetchImpl }), /not approved/);
    assert.equal(world.mcpCalls.length, 0);
  }
});

test("a finished request never runs twice", async () => {
  for (const label of ["done", "failed"]) {
    const world = fakeWorld({ labels: [label], events: [ownerLabel] });
    assert.match(await run({ event: labeledEvent(), env: ENV, fetchImpl: world.fetchImpl }), /already handled/);
    assert.equal(world.mcpCalls.length, 0);
  }
});

test("REQUIRE_APPROVAL=false runs writes on open, once", async () => {
  const env = { ...ENV, REQUIRE_APPROVAL: "false" };
  const opened = fakeWorld();
  assert.equal(await run({ event: makeEvent(WRITE), env, fetchImpl: opened.fetchImpl }), "done");
  assert.equal(opened.mcpCalls.length, 1);
  const labeled = fakeWorld();
  assert.match(await run({ event: labeledEvent(), env, fetchImpl: labeled.fetchImpl }), /no approval needed/);
  assert.equal(labeled.mcpCalls.length, 0);
});

test("adding the label to a read does not run it again", async () => {
  const world = fakeWorld();
  const event = makeEvent('{"path":"/zones"}', { action: "labeled", label: { name: "approved" } });
  assert.match(await run({ event, env: ENV, fetchImpl: world.fetchImpl }), /no approval needed/);
  assert.equal(world.mcpCalls.length, 0);
});

test("reports bad JSON and failures on the issue", async () => {
  const bad = fakeWorld();
  assert.equal(await run({ event: makeEvent("not json"), env: ENV, fetchImpl: bad.fetchImpl }), "failed");
  assert.ok(bad.comments[0].includes("must be JSON"));
  assert.equal(bad.mcpCalls.length, 0);

  const toolError = fakeWorld({ toolResult: { isError: true, content: [{ text: "HTTP 403" }] } });
  assert.equal(await run({ event: makeEvent('{"path":"/zones"}'), env: ENV, fetchImpl: toolError.fetchImpl }), "failed");
  assert.deepEqual(toolError.added, ["failed"]);

  const rejected = fakeWorld({ mcpStatus: 401 });
  assert.equal(await run({ event: makeEvent('{"path":"/zones"}'), env: ENV, fetchImpl: rejected.fetchImpl }), "failed");
  assert.ok(rejected.comments[0].includes("connect-github"));

  const missing = fakeWorld();
  assert.equal(await run({ event: makeEvent('{"path":"/zones"}'), env: { GITHUB_TOKEN: "x" }, fetchImpl: missing.fetchImpl }), "failed");
  assert.equal(missing.mcpCalls.length, 0);
});

test("never posts the access key, and survives backticks and huge results", async () => {
  const world = fakeWorld({ toolResult: { content: [{ text: `key=${KEY} \`\`\`\` ${"x".repeat(70_000)}` }] } });
  await run({ event: makeEvent('{"path":"/zones"}'), env: ENV, fetchImpl: world.fetchImpl });
  const comment = world.comments[0];
  assert.ok(!comment.includes(KEY));
  assert.ok(comment.includes("[truncated"));
  assert.ok(comment.length < 65_536);
  assert.ok(comment.includes("`````"));
});
