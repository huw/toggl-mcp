import { env } from "cloudflare:workers";
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import { GitHubHandler } from "./github-handler";
import { registerTools } from "./tools";
import type { Props } from "./utils";

function createServer() {
	const server = new McpServer({ name: "toggl-mcp", version: "0.1.0" });
	const props = getMcpAuthContext()?.props as Props | undefined;
	if (props?.login.toLowerCase() === env.ALLOWED_GITHUB_USERNAME.toLowerCase()) {
		registerTools(server);
	}
	return server;
}

const mcpHandler = createMcpHandler(createServer);
const apiHandler = {
	fetch(request: Request, bindings: Env, ctx: ExecutionContext) {
		return mcpHandler(request, bindings, ctx);
	},
} satisfies ExportedHandler<Env>;

export default new OAuthProvider<Env>({
	apiHandler,
	apiRoute: "/mcp",
	authorizeEndpoint: "/authorize",
	clientRegistrationEndpoint: "/register",
	defaultHandler: GitHubHandler as any,
	tokenEndpoint: "/token",
	resourceMetadata: { resource: env.MCP_RESOURCE },
});
