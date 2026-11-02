# toggl-mcp

A personal remote MCP server for [Toggl Track](https://toggl.com/track/), running on Cloudflare Workers. It speaks streamable HTTP at `/mcp`, so claude.ai, the Claude mobile apps and Claude's cloud sessions can use it as a custom connector.

- **Single user.** Sign-in is GitHub OAuth. Exactly one GitHub login is allowed; anyone else gets a 403 after signing in.
- **Weeks run Monday to Sunday in `Australia/Sydney`.** Date ranges are inclusive calendar days in that zone.
- **Read and write.** Reading time for a weekly review is the main use, but entries, projects, clients, tags and tasks can be changed too.

Built from Cloudflare's [`remote-mcp-github-oauth`](https://github.com/cloudflare/ai/tree/main/demos/remote-mcp-github-oauth) template: `@cloudflare/workers-oauth-provider` handles OAuth and a stateless `createMcpHandler` serves MCP. There is no Durable Object and no `/sse` endpoint.

## Tools

Read-only:

| Tool | Returns |
| --- | --- |
| `get_me` | User, default workspace, profile timezone |
| `list_workspaces`, `list_projects`, `list_clients`, `list_tags`, `list_tasks` | Lookups. Projects include client names. Cached about 10 minutes (in memory, cleared by any write) |
| `get_current_entry` | The running timer, if any |
| `list_time_entries(start_date, end_date)` | Entries overlapping the range, with description, project, client, tags, start, stop and hours (2dp). Names are resolved from IDs |
| `summary(start_date, end_date, group_by, sub_group_by?)` | Hours by `project`, `client` or `tag`, with a grand total |
| `weekly_review(week_start?)` | Total, per day, per project, client and tag, top 10 entries, and the change from the previous week. Defaults to last Monday to Sunday. Markdown tables |

Write tools (`delete_*` and `toggl_api_request` are marked destructive):

- `create_time_entry` (omit `stop` to start a timer), `update_time_entry`, `stop_time_entry`, `delete_time_entry`
- `create_`, `update_` and `delete_` for `project`, `client`, `tag` and `task`
- `toggl_api_request`: any other Track API v9 or Reports API v3 endpoint. The path must start with `/api/v9/` or `/reports/api/v3/`

Times you pass in without an offset (`2026-11-02T09:30`) are Sydney local time. With an offset or `Z` they are used as is.

### How time is counted

- A running entry has a negative duration in Toggl. It counts up to now.
- An entry crossing midnight is split between the days. An entry crossing the edge of a range counts only the part inside it.
- Hours are elapsed time, so the Sydney days daylight saving starts and ends are 23 and 25 hours long.
- Toggl filters entries by start time, so the fetch window opens a day early to catch an entry that began just before the range.

### Tags in `summary`

Reports API v3 summaries can group by project, client or user, but not by tag. Grouping by project or client uses the Reports API. Grouping by tag is totalled from your time entries, and an entry with several tags counts toward each of them, so tag totals can add up to more than the grand total. The output says so.

Reports v3 is expected to read whole days in your Toggl profile timezone, which I have not verified against the live API. If that timezone is not `Australia/Sydney`, `summary` includes a warning. Setting it to Sydney in Toggl avoids any shift at the range edges.

## Setup

You need a Cloudflare account, a GitHub account and a Toggl API token.

```sh
pnpm install
```

### 1. KV namespace

```sh
pnpm wrangler kv namespace create OAUTH_KV
```

Put the printed `id` in `wrangler.jsonc` under `kv_namespaces`.

### 2. URL and allowed user

In `wrangler.jsonc`, set `MCP_RESOURCE` to the deployed URL. Every OAuth token is bound to it:

```jsonc
"MCP_RESOURCE": "https://toggl-mcp.<your-subdomain>.workers.dev/mcp"
```

`ALLOWED_GITHUB_USERNAME` is the one GitHub login that may use the server. The match ignores case.

### 3. GitHub OAuth app

GitHub, Settings, Developer settings, OAuth Apps, New OAuth App:

- **Homepage URL:** `https://toggl-mcp.<your-subdomain>.workers.dev`
- **Authorization callback URL:** `https://toggl-mcp.<your-subdomain>.workers.dev/callback`

Then generate a client secret. The server only reads your GitHub login (`read:user`).

### 4. Secrets

None of these belong in the repo. Each command prompts for the value:

```sh
pnpm wrangler secret put GITHUB_CLIENT_ID
pnpm wrangler secret put GITHUB_CLIENT_SECRET
pnpm wrangler secret put COOKIE_ENCRYPTION_KEY   # openssl rand -hex 32
pnpm wrangler secret put TOGGL_API_TOKEN         # Toggl: Profile settings, API token
```

### 5. Deploy

```sh
pnpm deploy
```

The MCP endpoint is `https://toggl-mcp.<your-subdomain>.workers.dev/mcp`.

## Add it to claude.ai

1. Settings, Connectors, Add custom connector.
2. Paste the `/mcp` URL.
3. Sign in with GitHub when prompted.

## Try it with the MCP Inspector

```sh
npx @modelcontextprotocol/inspector
```

Choose the Streamable HTTP transport, enter the `/mcp` URL, and use OAuth sign-in. Then call `weekly_review` with no arguments.

## Develop

```sh
pnpm test          # runs inside workerd
pnpm type-check
pnpm dev           # needs .dev.vars, see .dev.vars.example
```

For `pnpm dev`, set `MCP_RESOURCE` to `http://localhost:8788/mcp` and use a second GitHub OAuth app whose callback is `http://localhost:8788/callback`.

Tests cover the date and timezone logic, hours rounding, the Toggl client's 402 and 429 handling, the weekly review and summaries against mocked Toggl responses, write payloads, the passthrough path guard, and the GitHub allow-list.

## Privacy

Tokens and time-entry descriptions are never logged. A failed Toggl call logs only the HTTP status and path. The OAuth token carries your GitHub login and nothing else.
