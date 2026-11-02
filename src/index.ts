import { fromJsonSchema, McpServer } from "@modelcontextprotocol/server";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/server/validators/cf-worker";
import { createMcpHandler } from "agents/mcp/server";
import { isFromAccess } from "./access";
import operations from "./generated/operations.json";
import { callOperation, type Operation } from "./toggl";

const validator = new CfWorkerJsonSchemaValidator();
const tools = (operations as Operation[]).map((operation) => ({
	operation,
	config: {
		description: operation.description,
		inputSchema: fromJsonSchema<Record<string, unknown>>(operation.inputSchema, validator),
		// Annotations come from the allowlist, not the HTTP method: Toggl's reports are POSTs that only read.
		annotations: {
			readOnlyHint: operation.kind === "read",
			destructiveHint: operation.kind === "update" || operation.kind === "delete",
			idempotentHint: operation.kind !== "create",
			openWorldHint: false,
		},
	},
}));

function createServer() {
	const server = new McpServer({ name: "toggl-mcp", version: "0.3.0" });
	for (const { operation, config } of tools) {
		server.registerTool(operation.name, config, (input) => callOperation(operation, input));
	}
	return server;
}

const mcpHandler = createMcpHandler(createServer);

export default {
	async fetch(request, bindings, ctx) {
		if (new URL(request.url).pathname !== "/mcp") {
			return new Response("Not found", { status: 404 });
		}
		if (!(await isFromAccess(request))) {
			return new Response("Forbidden", { status: 403 });
		}
		return mcpHandler(request, bindings, ctx);
	},
} satisfies ExportedHandler<Env>;
