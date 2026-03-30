/**
 * MegaMem Pro — OpenClaw plugin
 *
 * Bridges remote MCP servers (StreamableHTTP with SSE fallback) into OpenClaw
 * as native agent tools. Each server gets two registered tools:
 *
 *   megamem_{name}_list  — list available tools on that server
 *   megamem_{name}_call  — call a specific tool by name
 *
 * Server discovery (merged, config wins):
 *   1. Env vars: MEGAMEM_<NAME>_URL + MEGAMEM_<NAME>_TOKEN
 *   2. Plugin config: plugins.entries.megamem-pro.config.servers
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { Type } from "@sinclair/typebox";

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

  // 2. Merge explicit config (config wins, disabled entries are removed)
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
 * Build the Authorization header value (or undefined if no token).
 * @param {string | undefined} token
 * @returns {Record<string, string> | undefined}
 */
function buildHeaders(token) {
  return token ? { Authorization: `Bearer ${token}` } : undefined;
}

/**
 * Connect to a single MCP server, trying StreamableHTTP first then SSE.
 * Returns the connected Client, or throws on complete failure.
 *
 * @param {string} name
 * @param {{ url: string, token: string | undefined }} config
 * @param {{ info: Function, warn: Function, error: Function }} logger
 * @returns {Promise<Client>}
 */
async function connectServer(name, config, logger) {
  const { url, token } = config;
  const headers = buildHeaders(token);

  const client = new Client(
    { name: `openclaw-megamem-pro:${name}`, version: "0.1.0" },
    { capabilities: {} }
  );

  // --- Try StreamableHTTP first ---
  try {
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

  // --- SSE fallback ---
  // Reconstruct client (connect can only be called once per Client instance)
  const clientSse = new Client(
    { name: `openclaw-megamem-pro:${name}:sse`, version: "0.1.0" },
    { capabilities: {} }
  );
  const sseUrl = new URL(url);
  const sseTransport = new SSEClientTransport(sseUrl, {
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
 * @returns {import("openclaw/plugin-sdk/plugin-entry").PluginService}
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
      if (failed.length > 0) {
        for (const r of failed) {
          ctx.logger.error(`megamem-pro: connection failure — ${r.reason?.message ?? r.reason}`);
        }
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
          // ignore close errors
        }
        clientRegistry.delete(name);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Tool helpers
// ---------------------------------------------------------------------------

/**
 * Build a standard error tool result.
 * @param {string} message
 * @returns {{ content: Array<{ type: string, text: string }> }}
 */
function errorResult(message) {
  return { content: [{ type: "text", text: message }] };
}

/**
 * Build a JSON tool result.
 * @param {unknown} data
 * @returns {{ content: Array<{ type: string, text: string }> }}
 */
function jsonResult(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

export default definePluginEntry({
  id: "megamem-pro",
  name: "MegaMem Pro",
  description:
    "Connects to remote MegaMem MCP servers over StreamableHTTP/SSE. " +
    "Servers discovered from MEGAMEM_<NAME>_URL + MEGAMEM_<NAME>_TOKEN env vars.",

  register(api) {
    const servers = resolveServers(api.pluginConfig);

    if (servers.size === 0) {
      api.logger.info(
        "megamem-pro: no servers found during registration. " +
        "Tools will not be registered until env vars or config are set and gateway restarted."
      );
    }

    // Start the connection service
    api.registerService(createMegaMemService(servers));

    // Register two tools per discovered server
    for (const [name] of servers) {
      const safeName = name.replace(/[^a-z0-9_]/gi, "_");

      // --- megamem_{name}_list ---
      api.registerTool({
        name: `megamem_${safeName}_list`,
        description:
          `List all available tools on the MegaMem '${name}' server. ` +
          `Returns tool names, descriptions, and input schemas.`,
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

      // --- megamem_{name}_call ---
      api.registerTool({
        name: `megamem_${safeName}_call`,
        description:
          `Call a specific tool on the MegaMem '${name}' server. ` +
          `Use megamem_${safeName}_list first to discover available tools and their schemas.`,
        parameters: Type.Object({
          tool: Type.String({
            description: "Name of the tool to call (from the list)",
          }),
          arguments: Type.Optional(
            Type.Record(Type.String(), Type.Unknown(), {
              description: "Arguments to pass to the tool (must match the tool's input schema)",
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
            // Pass through the MCP result content directly
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
});
