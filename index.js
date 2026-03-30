/**
 * MegaMem Pro — OpenClaw plugin (compatible with OpenClaw 2026.3.11+)
 *
 * Bridges remote MCP servers (StreamableHTTP with SSE fallback) into OpenClaw
 * as native agent tools. Each server gets two registered tools:
 *
 *   megamem_{name}_list  — list available tools on that server
 *   megamem_{name}_call  — call a specific tool by name
 *
 * Server discovery (env wins as base, config can override or disable):
 *   1. Env vars:  MEGAMEM_<NAME>_URL + MEGAMEM_<NAME>_TOKEN
 *   2. Plugin config: plugins.entries.megamem-pro.config.servers
 *
 * NOTE: Uses absolute paths to MCP SDK since it lives in /sandbox/node_modules,
 * not in the running OpenClaw's own node_modules.
 */

// Use absolute CJS paths — jiti (the plugin loader) runs in CJS interop mode,
// and the absolute paths ensure resolution works regardless of which node_modules
// tree the running OpenClaw process sees.
import { createRequire } from "node:module";
const _require = createRequire(import.meta.url);
const { Client } = _require("/sandbox/node_modules/@modelcontextprotocol/sdk/dist/cjs/client/index.js");
const { StreamableHTTPClientTransport } = _require("/sandbox/node_modules/@modelcontextprotocol/sdk/dist/cjs/client/streamableHttp.js");
const { SSEClientTransport } = _require("/sandbox/node_modules/@modelcontextprotocol/sdk/dist/cjs/client/sse.js");
const { Type } = _require("/sandbox/node_modules/@sinclair/typebox/build/cjs/index.js");

// ---------------------------------------------------------------------------
// Shared live-client registry: serverName → connected MCP Client
// Populated by the service on start(), read by tool handlers.
// ---------------------------------------------------------------------------
/** @type {Map<string, Client>} */
const clientRegistry = new Map();

// ---------------------------------------------------------------------------
// Server resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the full set of servers to connect to, merging env discovery and
 * explicit plugin config. Config entries win for matching names.
 *
 * @param {Record<string, unknown>} pluginConfig
 * @returns {Map<string, { url: string, token: string | undefined }>}
 */
function resolveServers(pluginConfig) {
  /** @type {Map<string, { url: string, token: string | undefined }>} */
  const servers = new Map();

  // 1. Discover from env vars: MEGAMEM_<NAME>_URL + MEGAMEM_<NAME>_TOKEN
  for (const [key, value] of Object.entries(process.env)) {
    const match = key.match(/^MEGAMEM_(.+)_URL$/);
    if (!match || !value) continue;
    const name = match[1].toLowerCase();
    const token = process.env[`MEGAMEM_${match[1]}_TOKEN`];
    servers.set(name, { url: value, token });
  }

  // 2. Merge explicit config (config wins; disabled entries are removed)
  const configServers = pluginConfig?.servers;
  if (configServers && typeof configServers === "object") {
    for (const [name, entry] of Object.entries(configServers)) {
      if (!entry || typeof entry !== "object") continue;
      if (entry.disabled === true) {
        servers.delete(name);
        continue;
      }
      if (!entry.url) continue;
      // Resolve token: inline > tokenEnv > keep env-discovered token
      const token =
        entry.token ??
        (entry.tokenEnv ? process.env[entry.tokenEnv] : undefined) ??
        servers.get(name)?.token;
      servers.set(name, { url: entry.url, token });
    }
  }

  return servers;
}

// ---------------------------------------------------------------------------
// MCP connection with StreamableHTTP → SSE fallback
// ---------------------------------------------------------------------------

/**
 * @param {string | undefined} token
 * @returns {Record<string, string> | undefined}
 */
function buildHeaders(token) {
  return token ? { Authorization: `Bearer ${token}` } : undefined;
}

/**
 * Connect to a single MCP server, trying StreamableHTTP first then SSE.
 *
 * @param {string} name
 * @param {{ url: string, token: string | undefined }} config
 * @param {{ info: Function, warn: Function, error: Function }} logger
 * @returns {Promise<Client>}
 */
async function connectServer(name, config, logger) {
  const { url, token } = config;
  const headers = buildHeaders(token);

  // --- Try StreamableHTTP first ---
  try {
    const client = new Client(
      { name: `openclaw-megamem-pro:${name}`, version: "0.1.0" },
      { capabilities: {} }
    );
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: headers ? { headers } : undefined,
    });
    await client.connect(transport);
    logger.info(`megamem-pro: [${name}] connected via StreamableHTTP (${url})`);
    return client;
  } catch (err) {
    logger.warn(
      `megamem-pro: [${name}] StreamableHTTP failed (${err?.message ?? err}), trying SSE...`
    );
  }

  // --- SSE fallback (new Client instance — connect() is one-shot) ---
  const clientSse = new Client(
    { name: `openclaw-megamem-pro:${name}:sse`, version: "0.1.0" },
    { capabilities: {} }
  );
  const sseTransport = new SSEClientTransport(new URL(url), {
    requestInit: headers ? { headers } : undefined,
  });
  await clientSse.connect(sseTransport);
  logger.info(`megamem-pro: [${name}] connected via SSE (${url})`);
  return clientSse;
}

// ---------------------------------------------------------------------------
// Service — manages connection lifecycle
// ---------------------------------------------------------------------------

/**
 * @param {Map<string, { url: string, token: string | undefined }>} servers
 */
function createMegaMemService(servers) {
  return {
    id: "megamem-pro",

    async start(ctx) {
      if (servers.size === 0) {
        ctx.logger.info(
          "megamem-pro: no servers configured. " +
          "Set MEGAMEM_<NAME>_URL + MEGAMEM_<NAME>_TOKEN env vars, or add " +
          "plugins.entries.megamem-pro.config.servers to your config."
        );
        return;
      }

      // Connect to all servers concurrently
      const results = await Promise.allSettled(
        Array.from(servers.entries()).map(async ([name, config]) => {
          const client = await connectServer(name, config, ctx.logger);
          clientRegistry.set(name, client);
        })
      );

      const failed = results.filter((r) => r.status === "rejected");
      for (const r of failed) {
        ctx.logger.error(
          `megamem-pro: connection failure — ${r.reason?.message ?? r.reason}`
        );
      }

      ctx.logger.info(
        `megamem-pro: ${clientRegistry.size}/${servers.size} server(s) connected.`
      );
    },

    async stop() {
      for (const [name, client] of clientRegistry.entries()) {
        try {
          await client.close();
        } catch {
          // ignore close errors on shutdown
        }
        clientRegistry.delete(name);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Tool result helpers
// ---------------------------------------------------------------------------

function errorResult(message) {
  return { content: [{ type: "text", text: message }] };
}

function jsonResult(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

// ---------------------------------------------------------------------------
// Plugin — plain export object (compatible with OpenClaw 2026.3.11)
// No definePluginEntry wrapper needed; OpenClaw calls .register(api) directly.
// ---------------------------------------------------------------------------

const plugin = {
  id: "megamem-pro",
  name: "MegaMem Pro",
  description:
    "Connects to remote MegaMem MCP servers over StreamableHTTP/SSE. " +
    "Servers discovered from MEGAMEM_<NAME>_URL + MEGAMEM_<NAME>_TOKEN env vars.",

  register(api) {
    const servers = resolveServers(api.pluginConfig);

    if (servers.size === 0) {
      api.logger.info(
        "megamem-pro: no servers found at registration time. " +
        "Set MEGAMEM_<NAME>_URL + MEGAMEM_<NAME>_TOKEN and restart the gateway."
      );
    }

    // Start the connection service
    api.registerService(createMegaMemService(servers));

    // Register two tools per discovered server
    for (const [name] of servers) {
      // Sanitise name for use as a tool name identifier
      const safeName = name.replace(/[^a-z0-9_]/gi, "_");

      // ── megamem_{name}_list ──────────────────────────────────────────────
      api.registerTool({
        name: `megamem_${safeName}_list`,
        description:
          `List all available tools on the MegaMem '${name}' server. ` +
          `Returns tool names, descriptions, and input schemas. ` +
          `Call this before megamem_${safeName}_call to discover what tools are available.`,
        parameters: Type.Object({}),

        async execute(_id, _params) {
          const client = clientRegistry.get(name);
          if (!client) {
            return errorResult(
              `MegaMem server '${name}' is not connected. ` +
              `Check MEGAMEM_${name.toUpperCase()}_URL and MEGAMEM_${name.toUpperCase()}_TOKEN env vars.`
            );
          }
          try {
            const page = await client.listTools();
            const tools = page.tools.map((t) => ({
              name: t.name,
              description: t.description ?? "",
              inputSchema: t.inputSchema,
            }));
            return jsonResult(tools);
          } catch (err) {
            return errorResult(
              `Failed to list tools on '${name}': ${err?.message ?? String(err)}`
            );
          }
        },
      });

      // ── megamem_{name}_call ──────────────────────────────────────────────
      api.registerTool({
        name: `megamem_${safeName}_call`,
        description:
          `Call a specific tool on the MegaMem '${name}' server. ` +
          `Use megamem_${safeName}_list first to discover available tools and their argument schemas.`,
        parameters: Type.Object({
          tool: Type.String({
            description: "Name of the tool to call (from the list)",
          }),
          arguments: Type.Optional(
            Type.Record(Type.String(), Type.Unknown(), {
              description:
                "Arguments to pass to the tool (must match the tool's input schema)",
            })
          ),
        }),

        async execute(_id, params) {
          const client = clientRegistry.get(name);
          if (!client) {
            return errorResult(
              `MegaMem server '${name}' is not connected. ` +
              `Check MEGAMEM_${name.toUpperCase()}_URL and MEGAMEM_${name.toUpperCase()}_TOKEN env vars.`
            );
          }
          try {
            const result = await client.callTool({
              name: params.tool,
              arguments: params.arguments ?? {},
            });
            // Pass MCP result content through directly
            if (result.content && Array.isArray(result.content)) {
              return { content: result.content, isError: result.isError };
            }
            return jsonResult(result);
          } catch (err) {
            return errorResult(
              `Failed to call '${params.tool}' on '${name}': ${err?.message ?? String(err)}`
            );
          }
        },
      });

      api.logger.info(`megamem-pro: registered tools for server '${name}'`);
    }
  },
};

export default plugin;
