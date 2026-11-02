import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/server/validators/cf-worker";
import { afterEach, describe, expect, it, vi } from "vitest";
import operations from "../src/generated/operations.json";
import { allowlist } from "../scripts/allowlist";
import { buildRequest, callOperation, redact, type Operation } from "../src/toggl";

const all = operations as Operation[];
const byName = (name: string) => {
	const operation = all.find((candidate) => candidate.name === name);
	if (!operation) {
		throw new Error(`No operation ${name}`);
	}
	return operation;
};

function stubFetch(respond: (url: URL, init: RequestInit | undefined) => Response) {
	const calls: { url: URL; init: RequestInit | undefined }[] = [];
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(input instanceof Request ? input.url : input);
		calls.push({ url, init });
		return respond(url, init);
	});
	return calls;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("generated surface", () => {
	it("exposes exactly the allowlisted operations, each with its kind", () => {
		expect(all.map((operation) => operation.name).sort()).toEqual(Object.keys(allowlist).sort());
		for (const operation of all) {
			expect(operation.kind, operation.name).toBe(allowlist[operation.name]);
		}
	});

	it("leaves out account, admin, billing and outbound operations", () => {
		const names = all.map((operation) => operation.name);
		for (const name of ["put_me", "post_close_account", "post_reset_token", "post_avatars"]) {
			expect(names).not.toContain(name);
		}
		for (const operation of all) {
			expect(operation.path, operation.name).not.toMatch(/^\/webhooks\/|desktop_login|\/auth\/|\/organizations|\/subscription|\/invitations|\/scheduled_reports|\/integrations|\/shared|\/export/);
			expect(operation.path, operation.name).not.toMatch(/\.(pdf|csv|xlsx|\{extension\})$/);
		}
	});

	it("only deletes time entries", () => {
		const deletes = all.filter((operation) => operation.method === "DELETE" || operation.kind === "delete");
		expect(deletes.map((operation) => operation.name)).toEqual(["delete_workspace_time_entries"]);
		expect(all.filter((operation) => /\/delete$/.test(operation.path))).toEqual([]);
	});

	it("marks only GETs and reports as read-only", () => {
		for (const operation of all.filter((candidate) => candidate.kind === "read")) {
			expect(operation.method === "GET" || operation.path.startsWith("/reports/") || operation.path.endsWith("/data"), operation.name).toBe(true);
		}
		for (const operation of all.filter((candidate) => candidate.kind !== "read")) {
			expect(operation.method, operation.name).not.toBe("GET");
		}
	});

	it("gives every tool a unique, valid MCP name", () => {
		const names = all.map((operation) => operation.name);
		expect(new Set(names).size).toBe(names.length);
		for (const name of names) {
			expect(name).toMatch(/^[a-z0-9_]{1,64}$/);
		}
	});

	it("declares every path parameter as a required argument", () => {
		for (const operation of all) {
			for (const [, name] of operation.path.matchAll(/\{([^}]+)\}/g)) {
				const arg = operation.args.find((candidate) => candidate.in === "path" && candidate.name === name);
				expect(arg, `${operation.name} {${name}}`).toBeDefined();
				expect((operation.inputSchema.required as string[]) ?? [], operation.name).toContain(arg?.arg);
			}
		}
	});

	it("compiles every input schema", () => {
		const validator = new CfWorkerJsonSchemaValidator();
		for (const operation of all) {
			expect(() => validator.getValidator(operation.inputSchema as never), operation.name).not.toThrow();
		}
	});
});

describe("buildRequest", () => {
	it("fills path parameters, encoding them", () => {
		const { url } = buildRequest(byName("get_workspace_project_task"), { workspace_id: 1, project_id: 2, task_id: "a/b c" });
		expect(url.pathname).toBe("/api/v9/workspaces/1/projects/2/tasks/a%2Fb%20c");
	});

	it("puts query parameters in the query string", () => {
		const { url, body } = buildRequest(byName("get_time_entries"), { start_date: "2026-10-26", end_date: "2026-11-02", meta: true });
		expect(url.href).toBe("https://api.track.toggl.com/api/v9/me/time_entries?start_date=2026-10-26&end_date=2026-11-02&meta=true");
		expect(body).toBeUndefined();
	});

	it("sends the body argument as JSON", () => {
		const { url, body, contentType } = buildRequest(byName("reports_post_summary_time_entries"), {
			workspace_id: 5,
			body: { start_date: "2026-10-26", end_date: "2026-11-01", grouping: "projects" },
		});
		expect(url.pathname).toBe("/reports/api/v3/workspace/5/summary/time_entries");
		expect(contentType).toBe("application/json");
		expect(JSON.parse(String(body))).toEqual({ start_date: "2026-10-26", end_date: "2026-11-01", grouping: "projects" });
	});

	it("uploads file parameters as multipart form data", () => {
		const upload: Operation = { ...byName("get_me"), method: "POST", args: [{ arg: "file", name: "file", in: "file" }] };
		const { body, contentType } = buildRequest(upload, { file: btoa("png-bytes") });
		expect(body).toBeInstanceOf(FormData);
		expect(contentType).toBeUndefined();
	});
});

describe("callOperation", () => {
	it("authenticates with the API token and returns Toggl's JSON verbatim", async () => {
		const calls = stubFetch(() => Response.json([{ id: 1, description: "Grant draft" }]));
		const result = await callOperation(byName("get_time_entries"), {});
		expect(result.content).toEqual([{ type: "text", text: '[{"id":1,"description":"Grant draft"}]' }]);
		expect(new Headers(calls[0]?.init?.headers).get("Authorization")).toBe(`Basic ${btoa("test-toggl-token:api_token")}`);
	});

	it("returns a binary export as a base64 resource", async () => {
		stubFetch(() => new Response(new Uint8Array([37, 80, 68, 70]), { headers: { "Content-Type": "application/pdf" } }));
		const result = await callOperation(byName("reports_post_summary_time_entries"), { workspace_id: 5, body: {} });
		expect(result.content[0]).toMatchObject({ type: "resource", resource: { mimeType: "application/pdf", blob: btoa("%PDF") } });
	});

	it("redacts the API token and other secrets from responses", async () => {
		stubFetch(() =>
			Response.json({
				id: 1,
				email: "huw@example.com",
				api_token: "abc123",
				workspaces: [{ id: 2, name: "Kaya", api_token: "def456", ical_url: "https://example.com/ical/xyz" }],
				note: "token test-toggl-token in free text",
			}),
		);
		const result = await callOperation(byName("get_me"), {});
		const text = (result.content[0] as { text: string }).text;
		expect(JSON.parse(text)).toEqual({
			id: 1,
			email: "huw@example.com",
			api_token: "[redacted]",
			workspaces: [{ id: 2, name: "Kaya", api_token: "[redacted]", ical_url: "[redacted]" }],
			note: "token [redacted] in free text",
		});
		expect(text).not.toMatch(/abc123|def456|xyz|test-toggl-token/);
	});

	it("redacts the API token from error details and non-JSON text", async () => {
		expect(redact("plain test-toggl-token text")).toBe("plain [redacted] text");
		stubFetch(() => new Response("bad token test-toggl-token", { status: 400 }));
		const result = await callOperation(byName("get_me"), {});
		expect(result.isError).toBe(true);
		expect((result.content[0] as { text: string }).text).not.toContain("test-toggl-token");
	});

	it("keeps empty secret fields as they are", () => {
		expect(JSON.parse(redact('{"api_token":null,"token":""}'))).toEqual({ api_token: null, token: "" });
	});

	it("retries a 429 after Retry-After, then succeeds", async () => {
		let attempts = 0;
		stubFetch(() => (++attempts < 3 ? new Response("", { status: 429, headers: { "Retry-After": "0" } }) : Response.json({ ok: true })));
		const result = await callOperation(byName("get_me"), {});
		expect(result.isError).toBeUndefined();
		expect(attempts).toBe(3);
	});

	it("reports a persistent 402 as a tool error naming the plan", async () => {
		stubFetch(() => new Response("quota", { status: 402, headers: { "Retry-After": "0" } }));
		const result = await callOperation(byName("get_me"), {});
		expect(result.isError).toBe(true);
		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("402 Payment Required") });
	});

	it("does not wait out a long Retry-After", async () => {
		let attempts = 0;
		stubFetch(() => {
			attempts++;
			return new Response("", { status: 429, headers: { "Retry-After": "3000" } });
		});
		const result = await callOperation(byName("get_me"), {});
		expect(result.content[0]).toMatchObject({ text: expect.stringContaining("3000 seconds") });
		expect(attempts).toBe(1);
	});
});
