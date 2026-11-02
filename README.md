# toggl-mcp

A personal remote MCP server for [Toggl Track](https://toggl.com/track/), running on Cloudflare Workers. It speaks streamable HTTP at `/mcp`, so claude.ai, the Claude mobile apps and Claude's cloud sessions can use it as a custom connector.

- **Single user.** Sign-in is GitHub OAuth. Exactly one GitHub login is allowed; anyone else gets a 403 after signing in.
- **The whole Toggl API, 1:1.** Every operation in Toggl's published OpenAPI specs is one MCP tool: 283 Track API v9 operations, 36 Reports API v3 and Insights operations, and 10 Webhooks operations. There are no convenience tools and no reshaping of responses.

Built from Cloudflare's [`remote-mcp-github-oauth`](https://github.com/cloudflare/ai/tree/main/demos/remote-mcp-github-oauth) template: `@cloudflare/workers-oauth-provider` handles OAuth and a stateless `createMcpHandler` serves MCP. There is no Durable Object and no `/sse` endpoint.

## Tools

`src/generated/operations.json` is generated from `specs/` by `scripts/generate.ts`. Each tool:

- is named after the operation's `operationId`. Reports and Webhooks tools are prefixed `reports_` and `webhooks_`; their specs have no operationIds, so the name comes from the method and path.
- takes the operation's path, query and form parameters as arguments, and its request body as `body`. Input schemas are the spec's, with references resolved.
- returns Toggl's response verbatim. JSON and text come back as text; binary exports (PDF, XLSX) come back as a base64 resource.
- is marked read-only for `GET` and destructive for `DELETE`.

A 402 or 429 is retried after Toggl's `Retry-After` delay, up to three times, if the delay is 15 seconds or less. Otherwise the tool returns an error saying why.

To pick up changes to Toggl's API:

```sh
pnpm specs:fetch   # downloads the current specs from engineering.toggl.com
pnpm generate      # rewrites src/generated/operations.json
```

Where the specs are wrong, the generator works around them: undeclared path placeholders become required arguments, `formData` parameters on `GET` operations go in the query string, and the avatar upload's `file` field is sent as a file.

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

Choose the Streamable HTTP transport, enter the `/mcp` URL, and use OAuth sign-in. Then call `get_me`.

## Develop

```sh
pnpm test          # runs inside workerd
pnpm type-check
pnpm dev           # needs .dev.vars, see .dev.vars.example
```

For `pnpm dev`, set `MCP_RESOURCE` to `http://localhost:8788/mcp` and use a second GitHub OAuth app whose callback is `http://localhost:8788/callback`.

Tests cover the generated surface (counts, names, path parameters, every schema compiles), request mapping, response handling, 402 and 429 handling, and the GitHub allow-list.

## Privacy

Tokens and time-entry data are never logged. A failed Toggl call logs only the HTTP status, method and path. The OAuth token carries your GitHub login and nothing else.
