# openclaw-megamem-pro

An [OpenClaw](https://openclaw.ai) plugin that bridges remote [MegaMem](https://github.com/C-Bjorn/megamem) MCP servers into OpenClaw as native agent tools — over StreamableHTTP (with SSE fallback), via Tailscale or any HTTP endpoint.

## What it does

Each configured MCP server gets two tools registered in your OpenClaw agent:

- `megamem_{name}_list` — list available tools on that server
- `megamem_{name}_call` — call a specific tool by name with arguments

## Installation

```bash
# From GitHub (available now)
Clone and install from GitHub: https://github.com/C-Bjorn/openclaw-megamem-pro.git

# From npm (coming soon)
# openclaw plugins install openclaw-megamem-pro
```

## Configuration

Servers are auto-discovered from environment variables. No config file needed for the standard MegaMem tri-profile setup:

```bash
# In openclaw.json env block, or your shell environment:
MEGAMEM_AGENT_URL=http://your-host.tailnet.ts.net:3838/mcp/
MEGAMEM_AGENT_TOKEN=your-agent-profile-token

MEGAMEM_ME_URL=http://your-host.tailnet.ts.net:3838/mcp/
MEGAMEM_ME_TOKEN=your-me-profile-token

MEGAMEM_COMPANY_URL=http://your-host.tailnet.ts.net:3838/mcp/
MEGAMEM_COMPANY_TOKEN=your-company-profile-token
```

This registers 6 tools: `megamem_agent_list`, `megamem_agent_call`, `megamem_me_list`, `megamem_me_call`, `megamem_company_list`, `megamem_company_call`.

**Any** `MEGAMEM_<NAME>_URL` + `MEGAMEM_<NAME>_TOKEN` pair works — name is lowercased and used as the server identifier.

### Optional: explicit plugin config

Override or extend env-discovered servers in `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "megamem-pro": {
        "config": {
          "servers": {
            "agent": {
              "url": "http://myhost:3838/mcp/",
              "tokenEnv": "MY_CUSTOM_TOKEN_VAR"
            },
            "old-server": {
              "disabled": true
            }
          }
        }
      }
    }
  }
}
```

Config entries override env discovery for the same name. `disabled: true` removes a server.

## Transport

Tries **StreamableHTTP** first (MCP 2025-03-26 spec). Falls back to **SSE** automatically if the server doesn't support it. Works over Tailscale, local network, or any reachable HTTP endpoint.

## Token security

Tokens are read from environment variables — never hardcoded. Store them in:
- `env` block of `openclaw.json` (they stay on disk, encrypted if your OS supports it)
- Shell environment / `.env` file outside the config
- Secrets manager via the `tokenEnv` config option pointing to any env var name

## Requirements

- OpenClaw 2026.3.11+
- Node.js 22+
- MegaMem server running and reachable
