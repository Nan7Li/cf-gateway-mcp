// Registers the MCP server in each agent installed on this machine.
// Each file is backed up first, and only our own entry is touched.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { applyEdits, modify, parse } from "jsonc-parser";

export const SERVER_NAME = "cf-gateway";
const CODEX_START = "# >>> cf-gateway-mcp (managed by npm run setup)";
const CODEX_END = "# <<< cf-gateway-mcp";

function writeWithBackup(file, text) {
  if (existsSync(file)) copyFileSync(file, `${file}.cf-gateway.bak`);
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.cf-gateway.tmp`;
  writeFileSync(temporary, text);
  renameSync(temporary, file);
}

function setJsoncValue(file, path, value) {
  const original = existsSync(file) ? readFileSync(file, "utf8") : "";
  const text = original.trim() ? original : "{}\n";
  const errors = [];
  parse(text, errors, { allowTrailingComma: true });
  if (errors.length > 0) throw new Error(`${file} is not valid JSON, left unchanged`);
  const edits = modify(text, path, value, {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
    getInsertionIndex: () => 0,
  });
  writeWithBackup(file, applyEdits(text, edits));
}

function registerClaude(home, url, key, useCli) {
  const entry = { type: "http", url, headers: { Authorization: `Bearer ${key}` } };
  if (useCli) {
    // No shell, so the key is never parsed or logged by one.
    spawnSync("claude", ["mcp", "remove", SERVER_NAME, "-s", "user"], { stdio: "ignore" });
    const added = spawnSync("claude", ["mcp", "add-json", SERVER_NAME, JSON.stringify(entry), "-s", "user"], { stdio: "ignore" });
    if (added.status === 0) return;
  }
  setJsoncValue(join(home, ".claude.json"), ["mcpServers", SERVER_NAME], entry);
}

function registerCodex(home, url, key) {
  const file = join(home, ".codex", "config.toml");
  const original = existsSync(file) ? readFileSync(file, "utf8") : "";
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const start = original.indexOf(CODEX_START);
  const end = original.indexOf(CODEX_END);
  let rest = original;
  if (start !== -1 && end > start) {
    rest = original.slice(0, start) + original.slice(end + CODEX_END.length).replace(/^\r?\n/, "");
  } else if (new RegExp(`^\\[mcp_servers\\.${SERVER_NAME}\\]`, "m").test(original)) {
    throw new Error(`${file} already has [mcp_servers.${SERVER_NAME}] written by hand, left unchanged`);
  }
  // Appended last: it is a TOML table, so anything after it would become part of it.
  // JSON strings are valid TOML basic strings.
  const block = [
    CODEX_START,
    `[mcp_servers.${SERVER_NAME}]`,
    `url = ${JSON.stringify(url)}`,
    `http_headers = { "Authorization" = ${JSON.stringify(`Bearer ${key}`)} }`,
    CODEX_END,
    "",
  ].join(eol);
  const prefix = rest.trimEnd() ? `${rest.trimEnd()}${eol}${eol}` : "";
  writeWithBackup(file, prefix + block);
}

function registerGemini(home, url, key) {
  setJsoncValue(join(home, ".gemini", "settings.json"), ["mcpServers", SERVER_NAME], {
    httpUrl: url,
    headers: { Authorization: `Bearer ${key}` },
  });
}

function registerOpencode(home, url, key) {
  const folder = join(home, ".config", "opencode");
  const file = [join(folder, "opencode.jsonc"), join(folder, "opencode.json")].find(existsSync) ?? join(folder, "opencode.json");
  setJsoncValue(file, ["mcp", SERVER_NAME], {
    type: "remote",
    url,
    enabled: true,
    oauth: false,
    headers: { Authorization: `Bearer ${key}` },
  });
}

/** Returns one { agent, status, detail } per agent. Messages never contain the key. */
export function registerAgents({ home, url, key, useClaudeCli = true }) {
  const agents = [
    { agent: "Claude Code", installed: [".claude", ".claude.json"], register: () => registerClaude(home, url, key, useClaudeCli) },
    { agent: "Codex", installed: [".codex"], register: () => registerCodex(home, url, key) },
    { agent: "Gemini CLI", installed: [".gemini"], register: () => registerGemini(home, url, key) },
    { agent: "opencode", installed: [join(".config", "opencode")], register: () => registerOpencode(home, url, key) },
  ];
  return agents.map(({ agent, installed, register }) => {
    if (!installed.some((path) => existsSync(join(home, path)))) return { agent, status: "skipped", detail: "not installed" };
    try {
      register();
      return { agent, status: "ok" };
    } catch (error) {
      return { agent, status: "failed", detail: error.message };
    }
  });
}
