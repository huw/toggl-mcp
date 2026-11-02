# toggl-mcp

A personal remote MCP server for [Toggl Track](https://toggl.com/track/), running on Cloudflare Workers. It speaks streamable HTTP at `/mcp`, so claude.ai, the Claude mobile apps and Claude's cloud sessions can use it as a custom connector.

- **Single user, behind Cloudflare Access.** Access is the OAuth provider, through Managed OAuth, and an Access policy decides who may sign in. The Worker verifies the JWT Access attaches to every request it lets through, and refuses anything without a valid one.
- **The whole Toggl API, 1:1.** Every operation in Toggl's published OpenAPI specs is one MCP tool: 283 Track API v9 operations, 36 Reports API v3 and Insights operations, and 10 Webhooks operations. There are no convenience tools and no reshaping of responses.

A stateless `createMcpHandler` from the Agents SDK serves MCP. There is no Durable Object and no `/sse` endpoint.

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

You need a Cloudflare account with a Zero Trust organisation (the free plan is enough) and a Toggl API token.

```sh
pnpm install
```

### 1. Deploy the Worker

```sh
pnpm wrangler secret put TOGGL_API_TOKEN   # Toggl: Profile settings, API token
pnpm deploy
```

Until step 3 is done, every request gets a 403, because nothing carries a valid Access JWT yet.

### 2. Put Access in front of it

1. In the Cloudflare dashboard, open the Worker, then Settings, Domains & Routes. On the `workers.dev` route, turn on Cloudflare Access. This creates an Access application for the hostname.
2. In Zero Trust, Access controls, Applications, edit that application:
   - **Policy:** one Allow rule that includes only your email address. One-time PIN works as the login method with no other setup.
   - **Advanced settings:** turn on **Managed OAuth**. Under dynamic client registration, allow the redirect URI `https://claude.ai/api/mcp/auth_callback`. To use the MCP Inspector locally too, allow localhost.
3. Note the application's **Application Audience (AUD) tag** and your team domain, `<team>.cloudflareaccess.com`.

### 3. Tell the Worker which Access application to trust

In `wrangler.jsonc`:

```jsonc
"ACCESS_TEAM_DOMAIN": "<team>.cloudflareaccess.com",
"ACCESS_AUD": "<the AUD tag>"
```

Then run `pnpm deploy` again. The MCP endpoint is `https://toggl-mcp.<your-subdomain>.workers.dev/mcp`.

## Add it to claude.ai

1. Settings, Connectors, Add custom connector.
2. Paste the `/mcp` URL.
3. Sign in through Cloudflare Access when prompted.

## Try it with the MCP Inspector

```sh
npx @modelcontextprotocol/inspector
```

Choose the Streamable HTTP transport, enter the `/mcp` URL, and use the OAuth flow, which signs you in through Access. Then call `get_me`.

## Develop

```sh
pnpm test          # runs inside workerd
pnpm type-check
```

`wrangler dev` sits behind no Access application, so a local server answers every request with 403.

Tests cover the generated surface (counts, names, path parameters, every schema compiles), request mapping, response handling, 402 and 429 handling, and the Access JWT check (missing, wrong audience, wrong team, expired, valid).

## Privacy

Tokens and time-entry data are never logged. A failed Toggl call logs only the HTTP status, method and path. The Worker never sees your Access session token, only the signed assertion Access derives from it.
