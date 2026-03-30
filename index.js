/**
 * MegaMem Pro — OpenClaw plugin
 *
 * Bridges remote MCP servers (StreamableHTTP with SSE fallback) into OpenClaw
 * as native agent tools. Each configured server gets two tools:
 *
 *   megamem_{name}_list  — list available tools on that server
 *   megamem_{name}_call  — call a specific tool by name
 *
 * Server discovery (env vars as base, plugin config can override or disable):
 *   MEGAMEM_<NAME>_URL   — MCP server base URL
 *   MEGAMEM_<NAME>_TOKEN — Bearer token for that server
 *
 * Example env vars (standard MegaMem tri-profile setup):
 *   MEGAMEM_AGENT_URL, MEGAMEM_AGENT_TOKEN   → megamem_agent_list / megamem_agent_call
 *   MEGAMEM_ME_URL, MEGAMEM_ME_TOKEN         → megamem_me_list / megamem_me_call
 *   MEGAMEM_COMPANY_URL, MEGAMEM_COMPANY_TOKEN → megamem_company_list / megamem_company_call
 */

// jiti (the OpenClaw plugin loader) runs in CJS interop mode.
// We use createRequire to load deps from this package's own node_modules,
// which is correct whether installed via npm or loaded from a local path.
import { createRequire } from "node:module";
const _require = createRequire(import.meta.url);

const { Client } = _require("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = _require("@modelcontextprotocol/sdk/client/streamableHttp.js");
const { SSEClientTransport } = _require("@modelcontextprotocol/sdk/client/sse.js");
const { Type } = _require("@sinclair/typebox");

// ---------------------------------------------------------------------------
// Shared live-client registry: serverName → connected MCP Client
// Populated by the service on start(), read by tool handlers.
// ---------------------------------------------------------------------------
/** @type {Map<string, import("@modelcontextprotocol/sdk/dist/cjs/client/index.js").Client>} */
const clientRegistry = new Map();

// ---------------------------------------------------------------------------
// Server resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the full set of servers from env vars + plugin config.
 * Config entries override env-discovered entries for matching names.
 *
 * @param {Record<string, unknown>} pluginConfig
 * @returns {Map<string, { url: string, token: string | undefined }>}
 */
function resolveServers(pluginConfig) {
  /** @type {Map<string, { url: string, token: string | undefined }>} */
  const servers = new Map();

  // 1. Discover from env: MEGAMEM_<NAME>_URL + MEGAMEM_<NAME>_TOKEN
  for (const [key, value] of Object.entries(process.env)) {
    const match = key.match(/^MEGAMEM_(.+)_URL$/);
    if (!match || !value) continue;
    const name = match[1].toLowerCase();
    const token = process.env[`MEGAMEM_${match[1]}_TOKEN`];
    servers.set(name, { url: value, token });
  }

  // 2. Merge explicit plugin config (wins over env; disabled entries removed)
  const configServers = pluginConfig?.servers;
  if (configServers && typeof configServers === "object") {
    for (const [name, entry] of Object.entries(configServers)) {
      if (!entry || typeof entry !== "object") continue;
      if (entry.disabled === true) { servers.delete(name); continue; }
      if (!entry.url) continue;
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
// MCP connection: StreamableHTTP → SSE fallback
// ---------------------------------------------------------------------------

/**
 * @param {string} name
 * @param {{ url: string, token: string | undefined }} config
 * @param {{ info: Function, warn: Function, error: Function }} logger
 * @returns {Promise<InstanceType<typeof Client>>}
 */
async function connectServer(name, config, logger) {
  const { url, token } = config;
  const headers = token ? { Authorization: `Bearer ${token}` } : undefined;

  // Try StreamableHTTP first
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
    logger.warn(`megamem-pro: [${name}] StreamableHTTP failed (${err?.message ?? err}), trying SSE...`);
  }

  // SSE fallback (new Client instance — connect() is one-shot per instance)
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
    id: "openclaw-megamem-pro",

    async start(ctx) {
      if (servers.size === 0) {
        ctx.logger.info(
          "megamem-pro: no servers configured. " +
          "Set MEGAMEM_<NAME>_URL + MEGAMEM_<NAME>_TOKEN env vars and restart."
        );
        return;
      }

      const results = await Promise.allSettled(
        Array.from(servers.entries()).map(async ([name, config]) => {
          const client = await connectServer(name, config, ctx.logger);
          clientRegistry.set(name, client);
        })
      );

      for (const r of results.filter((r) => r.status === "rejected")) {
        ctx.logger.error(`megamem-pro: connection failure — ${r.reason?.message ?? r.reason}`);
      }

      ctx.logger.info(`megamem-pro: ${clientRegistry.size}/${servers.size} server(s) connected.`);
    },

    async stop() {
      for (const [name, client] of clientRegistry.entries()) {
        try { await client.close(); } catch { /* ignore */ }
        clientRegistry.delete(name);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Tool result helpers
// ---------------------------------------------------------------------------

const errorResult = (msg) => ({ content: [{ type: "text", text: msg }] });
const jsonResult = (data) => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });

// ---------------------------------------------------------------------------
// Plugin export
// ---------------------------------------------------------------------------

export default {
  id: "openclaw-megamem-pro",
  name: "MegaMem Pro",
  description:
    "Connects to remote MegaMem MCP servers over StreamableHTTP/SSE. " +
    "Servers auto-discovered from MEGAMEM_<NAME>_URL + MEGAMEM_<NAME>_TOKEN env vars.",

  register(api) {
    const servers = resolveServers(api.pluginConfig);

    if (servers.size === 0) {
      api.logger.info(
        "megamem-pro: no servers found at registration time. " +
        "Set MEGAMEM_<NAME>_URL + MEGAMEM_<NAME>_TOKEN and restart the gateway."
      );
    }

    api.registerService(createMegaMemService(servers));

    for (const [name] of servers) {
      const safeName = name.replace(/[^a-z0-9_]/gi, "_");

      // ── megamem_{name}_list ──────────────────────────────────────────────
      api.registerTool({
        name: `megamem_${safeName}_list`,
        description:
          `List all available tools on the MegaMem '${name}' server. ` +
          `Returns tool names, descriptions, and input schemas. ` +
          `Call this before megamem_${safeName}_call to discover what's available.`,
        parameters: Type.Object({}),

        async execute(_id, _params) {
          const client = clientRegistry.get(name);
          if (!client) return errorResult(
            `MegaMem server '${name}' is not connected. ` +
            `Check MEGAMEM_${name.toUpperCase()}_URL and MEGAMEM_${name.toUpperCase()}_TOKEN.`
          );
          try {
            const page = await client.listTools();
            return jsonResult(page.tools.map((t) => ({
              name: t.name,
              description: t.description ?? "",
              inputSchema: t.inputSchema,
            })));
          } catch (err) {
            return errorResult(`Failed to list tools on '${name}': ${err?.message ?? String(err)}`);
          }
        },
      });

      // ── megamem_{name}_call ──────────────────────────────────────────────
      api.registerTool({
        name: `megamem_${safeName}_call`,
        description:
          `Call a specific tool on the MegaMem '${name}' server. ` +
          `Use megamem_${safeName}_list first to discover available tools and their schemas.`,
        parameters: Type.Object({
          tool: Type.String({ description: "Name of the tool to call" }),
          arguments: Type.Optional(
            Type.Record(Type.String(), Type.Unknown(), {
              description: "Arguments to pass to the tool",
            })
          ),
        }),

        async execute(_id, params) {
          const client = clientRegistry.get(name);
          if (!client) return errorResult(
            `MegaMem server '${name}' is not connected. ` +
            `Check MEGAMEM_${name.toUpperCase()}_URL and MEGAMEM_${name.toUpperCase()}_TOKEN.`
          );
          try {
            const result = await client.callTool({
              name: params.tool,
              arguments: params.arguments ?? {},
            });
            if (result.content && Array.isArray(result.content)) {
              return { content: result.content, isError: result.isError };
            }
            return jsonResult(result);
          } catch (err) {
            return errorResult(`Failed to call '${params.tool}' on '${name}': ${err?.message ?? String(err)}`);
          }
        },
      });

      api.logger.info(`megamem-pro: registered tools for server '${name}'`);
    }
  },
};
