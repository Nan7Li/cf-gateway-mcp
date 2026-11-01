import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { parse } from "jsonc-parser";
import { registerAgents } from "../../scripts/lib/agents.mjs";

const URL_A = "https://a.workers.dev/mcp";
let home;

const register = (key = "key-one") => registerAgents({ home, url: URL_A, key, useClaudeCli: false });
const statusOf = (results, agent) => results.find((result) => result.agent === agent);
const read = (...path) => readFileSync(join(home, ...path), "utf8");

function seed(path, text) {
  mkdirSync(join(home, path, ".."), { recursive: true });
  writeFileSync(join(home, path), text);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cfgw-agents-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

test("skips agents that are not installed and creates nothing for them", () => {
  const results = register();
  assert.ok(results.every(({ status }) => status === "skipped"));
  for (const path of [".codex", ".gemini", ".config", ".claude.json"]) assert.equal(existsSync(join(home, path)), false);
});

test("Claude Code: adds the entry and keeps other settings", () => {
  seed(".claude.json", JSON.stringify({ theme: "dark", mcpServers: { other: { type: "stdio" } } }));
  assert.equal(statusOf(register(), "Claude Code").status, "ok");
  const config = JSON.parse(read(".claude.json"));
  assert.equal(config.theme, "dark");
  assert.deepEqual(config.mcpServers.other, { type: "stdio" });
  assert.deepEqual(config.mcpServers["cf-gateway"], { type: "http", url: URL_A, headers: { Authorization: "Bearer key-one" } });
});

test("Codex: appends a table, keeps the rest, and replaces itself on rerun", () => {
  const existing = 'model = "gpt"\n\n[mcp_servers.other]\nurl = "https://x/中文"\n';
  seed(".codex/config.toml", existing);
  register("key-one");
  register("key-two");
  const text = read(".codex", "config.toml");
  assert.ok(text.startsWith(existing));
  assert.equal(text.match(/\[mcp_servers\.cf-gateway\]/g).length, 1);
  assert.ok(text.includes('http_headers = { "Authorization" = "Bearer key-two" }'));
  assert.ok(!text.includes("key-one"));
  assert.ok(text.includes(`url = "${URL_A}"`));
});

test("Codex: does not overwrite an entry written by hand", () => {
  seed(".codex/config.toml", '[mcp_servers.cf-gateway]\nurl = "https://mine"\n');
  const result = statusOf(register(), "Codex");
  assert.equal(result.status, "failed");
  assert.equal(read(".codex", "config.toml"), '[mcp_servers.cf-gateway]\nurl = "https://mine"\n');
});

test("Gemini CLI: uses httpUrl", () => {
  seed(".gemini/settings.json", '{"selectedAuthType":"x"}');
  register();
  const config = JSON.parse(read(".gemini", "settings.json"));
  assert.equal(config.selectedAuthType, "x");
  assert.deepEqual(config.mcpServers["cf-gateway"], { httpUrl: URL_A, headers: { Authorization: "Bearer key-one" } });
});

test("opencode: edits the existing jsonc in place and keeps comments", () => {
  seed(".config/opencode/opencode.jsonc", '{\n  // my comment 中文\n  "theme": "x",\n}\n');
  assert.equal(statusOf(register(), "opencode").status, "ok");
  const text = read(".config", "opencode", "opencode.jsonc");
  assert.ok(text.includes("// my comment 中文"));
  const entry = parse(text, [], { allowTrailingComma: true }).mcp["cf-gateway"];
  assert.equal(entry.type, "remote");
  assert.equal(entry.url, URL_A);
  assert.equal(entry.oauth, false);
  assert.equal(entry.headers.Authorization, "Bearer key-one");
  assert.equal(existsSync(join(home, ".config", "opencode", "opencode.json")), false);
});

test("leaves invalid JSON untouched and reports it without the key", () => {
  seed(".gemini/settings.json", "{ not json");
  const result = statusOf(register("secret-key"), "Gemini CLI");
  assert.equal(result.status, "failed");
  assert.ok(!result.detail.includes("secret-key"));
  assert.equal(read(".gemini", "settings.json"), "{ not json");
});

test("backs up the file before changing it", () => {
  seed(".gemini/settings.json", '{"before":true}');
  register();
  assert.equal(read(".gemini", "settings.json.cf-gateway.bak"), '{"before":true}');
});

test("rerunning with a new key replaces the old one everywhere", () => {
  seed(".claude.json", "{}");
  seed(".gemini/settings.json", "{}");
  seed(".config/opencode/opencode.json", "{}");
  register("key-one");
  register("key-two");
  for (const path of [[".claude.json"], [".gemini", "settings.json"], [".config", "opencode", "opencode.json"]]) {
    const text = read(...path);
    assert.ok(text.includes("key-two"), path.join("/"));
    assert.ok(!text.includes("key-one"), path.join("/"));
  }
});
