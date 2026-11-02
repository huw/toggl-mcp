import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/server/validators/cf-worker";
import { afterEach, describe, expect, it, vi } from "vitest";
import operations from "../src/generated/operations.json";
import { buildRequest, callOperation, type Operation } from "../src/toggl";

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
	it("has one tool per operation in the Track, Reports and Webhooks specs", () => {
		expect(all).toHaveLength(329);
		expect(all.filter((operation) => operation.path.startsWith("/api/v9/"))).toHaveLength(283);
		expect(all.filter((operation) => /^\/(reports|insights)\//.test(operation.path))).toHaveLength(36);
		expect(all.filter((operation) => operation.path.startsWith("/webhooks/api/v1/"))).toHaveLength(10);
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
		const { url } = buildRequest(byName("webhooks_get_validate"), {
			workspace_id: 1,
			subscription_id: 2,
			validation_code: "a/b c",
		});
		expect(url.pathname).toBe("/webhooks/api/v1/validate/1/2/a%2Fb%20c");
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
		const avatar = byName("post_avatars");
		const file = avatar.args.find((arg) => arg.in === "file");
		const { body, contentType } = buildRequest(avatar, { [file?.arg ?? ""]: btoa("png-bytes") });
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
		const result = await callOperation(byName("reports_post_summary_time_entries_pdf"), { workspace_id: 5, body: {} });
		expect(result.content[0]).toMatchObject({ type: "resource", resource: { mimeType: "application/pdf", blob: btoa("%PDF") } });
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
