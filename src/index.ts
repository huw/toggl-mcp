import { env } from "cloudflare:workers";
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { fromJsonSchema, McpServer } from "@modelcontextprotocol/server";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/server/validators/cf-worker";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import { GitHubHandler } from "./github-handler";
import operations from "./generated/operations.json";
import { callOperation, type Operation } from "./toggl";
import type { Props } from "./utils";

const validator = new CfWorkerJsonSchemaValidator();
const tools = (operations as Operation[]).map((operation) => ({
	operation,
	config: {
		description: operation.description,
		inputSchema: fromJsonSchema<Record<string, unknown>>(operation.inputSchema, validator),
		annotations: {
			readOnlyHint: operation.method === "GET",
			destructiveHint: operation.method === "DELETE",
			idempotentHint: ["GET", "PUT", "DELETE"].includes(operation.method),
		},
	},
}));

function createServer() {
	const server = new McpServer({ name: "toggl-mcp", version: "0.1.0" });
	const props = getMcpAuthContext()?.props as Props | undefined;
	if (props?.login.toLowerCase() === env.ALLOWED_GITHUB_USERNAME.toLowerCase()) {
		for (const { operation, config } of tools) {
			server.registerTool(operation.name, config, (input) => callOperation(operation, input));
		}
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
