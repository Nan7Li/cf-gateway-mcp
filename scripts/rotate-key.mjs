// Replaces the access key, updates local agents, and cuts off every existing OAuth grant.
import { homedir } from "node:os";
import { registerAgents } from "./lib/agents.mjs";
import { generateKey, printAgentResults, putSecrets, readState, updateRequestsRepoKey, waitForServer } from "./lib/common.mjs";

async function main() {
  const state = readState();
  if (!state) throw new Error("no .setup-state.json found. Run npm run setup first, in this folder.");

  const key = generateKey();
  await putSecrets({ MCP_ACCESS_KEY: key }, state.accountId);
  console.log("Waiting for the new key to take effect...");
  await waitForServer(state.url, key);

  console.log("Updating your agents:");
  printAgentResults(registerAgents({ home: homedir(), url: state.url, key }));
  updateRequestsRepoKey(key);
  console.log(`
Done. Restart any agent that is already open. Web clients must authorize again.

New access key: ${key}

It is shown only here. Keep it in a password manager.`);
}

main().catch((error) => {
  console.error(`\nRotation failed: ${error.message}`);
  process.exit(1);
});
