// The plugin's MCP servers for pi. Agent Plugins puts them in mcp.json at the plugin root;
// pi reads neither that file nor plugin.json, so the extension registers them itself.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = fileURLToPath(new URL("../../../", import.meta.url));

type Server = { type?: string; [field: string]: unknown };

/**
 * Servers to register, with pi-only fields (`description`, `exposure`) merged from
 * `extensions["dev.pi"].mcpServers` in plugin.json, and the problems found. As the spec
 * asks of a client, a bad mcp.json disables only MCP and a bad entry only itself.
 * ponytail: streamable-http only; stdio needs PLUGIN_ROOT/PLUGIN_DATA expansion, add it with the first stdio server.
 */
export function pluginMcpServers(root = pluginRoot) {
  const servers: [string, Server][] = [];
  const problems: string[] = [];
  let manifest, config;
  try {
    manifest = JSON.parse(readFileSync(join(root, "plugin.json"), "utf8"));
    config = JSON.parse(readFileSync(join(root, "mcp.json"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") problems.push(`mcp.json: ${(error as Error).message}`);
    return { servers, problems };
  }
  const schema = String(manifest.$schema).replace("/plugin.schema.json", "/mcp.schema.json");
  const isObject = (value: unknown): value is Server => typeof value === "object" && value !== null && !Array.isArray(value);
  if (config.$schema !== schema || !isObject(config.mcpServers)) {
    problems.push(`mcp.json: needs $schema ${schema} and an mcpServers object`);
    return { servers, problems };
  }
  const extras = manifest.extensions?.["dev.pi"]?.mcpServers ?? {};
  for (const [name, server] of Object.entries(config.mcpServers)) {
    if (!isObject(server)) problems.push(`${name}: not a server object`);
    else if (server.type === "streamable-http") servers.push([name, { ...server, ...extras[name] }]);
    else problems.push(`${name}: transport ${server.type} is not supported`);
  }
  return { servers, problems };
}
