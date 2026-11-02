import type { McpServer } from "@modelcontextprotocol/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerTools } from "../src/tools";
import { clearCache } from "../src/toggl/client";
import { json, me, mockFetch } from "./helpers";

type Handler = (input: Record<string, unknown>) => Promise<{ isError?: boolean; content: { text: string }[] }>;
const tools = new Map<string, { config: { annotations?: Record<string, boolean> }; handler: Handler }>();
registerTools({
	registerTool: (name: string, config: never, handler: Handler) => tools.set(name, { config, handler }),
} as unknown as McpServer);

const call = (name: string, input: Record<string, unknown> = {}) => {
	const tool = tools.get(name);
	if (!tool) {
		throw new Error(`No tool ${name}`);
	}
	return tool.handler(input);
};

beforeEach(() => {
	clearCache();
	vi.unstubAllGlobals();
});

describe("tool registry", () => {
	it("offers the read tools from the brief and full write coverage", () => {
		for (const name of [
			"get_me", "list_workspaces", "list_projects", "list_clients", "list_tags", "get_current_entry",
			"list_time_entries", "summary", "weekly_review", "create_time_entry", "stop_time_entry",
			"update_time_entry", "delete_time_entry", "create_project", "update_project", "delete_project",
			"create_client", "update_client", "delete_client", "create_tag", "update_tag", "delete_tag",
			"create_task", "update_task", "delete_task", "toggl_api_request",
		]) {
			expect(tools.has(name), name).toBe(true);
		}
	});

	it("marks reads read-only and deletes destructive", () => {
		expect(tools.get("weekly_review")?.config.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
		expect(tools.get("delete_time_entry")?.config.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
		expect(tools.get("create_time_entry")?.config.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
	});
});

describe("write tools", () => {
	it("creates a finished entry, reading a zone-less time as Sydney local time", async () => {
		const calls = mockFetch((url) => (url.pathname === "/api/v9/me" ? json(me) : json({ id: 99 })));
		await call("create_time_entry", {
			description: "Review",
			project_id: 10,
			tags: ["grants"],
			start: "2026-10-26T09:00",
			stop: "2026-10-26T10:30",
		});
		const post = calls.find((request) => request.init?.method === "POST");
		expect(post?.url.pathname).toBe("/api/v9/workspaces/1/time_entries");
		expect(JSON.parse(String(post?.init?.body))).toEqual({
			description: "Review",
			project_id: 10,
			tags: ["grants"],
			start: "2026-10-25T22:00:00Z",
			stop: "2026-10-25T23:30:00Z",
			workspace_id: 1,
			duration: 5400,
			created_with: "toggl-mcp",
		});
	});

	it("starts a running timer with duration -1 when stop is omitted", async () => {
		const calls = mockFetch((url) => (url.pathname === "/api/v9/me" ? json(me) : json({ id: 99 })));
		await call("create_time_entry", { description: "Timer", start: "2026-10-26T09:00:00+11:00" });
		const body = JSON.parse(String(calls.find((request) => request.init?.method === "POST")?.init?.body));
		expect(body.duration).toBe(-1);
		expect(body.stop).toBeUndefined();
	});

	it("rejects a stop that is not after start as a tool error", async () => {
		mockFetch((url) => (url.pathname === "/api/v9/me" ? json(me) : json({})));
		const result = await call("create_time_entry", { start: "2026-10-26T10:00", stop: "2026-10-26T09:00" });
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("stop must be after start");
	});

	it("sends only the fields given when updating a project", async () => {
		const calls = mockFetch((url) => (url.pathname === "/api/v9/me" ? json(me) : json({ id: 10 })));
		await call("update_project", { id: 10, name: "Renamed" });
		const put = calls.find((request) => request.init?.method === "PUT");
		expect(put?.url.pathname).toBe("/api/v9/workspaces/1/projects/10");
		expect(JSON.parse(String(put?.init?.body))).toEqual({ name: "Renamed" });
	});

	it("addresses tasks under their project", async () => {
		const calls = mockFetch((url) => (url.pathname === "/api/v9/me" ? json(me) : json({ id: 3 })));
		await call("create_task", { project_id: 10, name: "Draft" });
		expect(calls.find((request) => request.init?.method === "POST")?.url.pathname).toBe("/api/v9/workspaces/1/projects/10/tasks");
	});

	it("stops the current timer when no id is given", async () => {
		const calls = mockFetch((url) => {
			if (url.pathname === "/api/v9/me/time_entries/current") {
				return json({ id: 55, workspace_id: 2, start: "2026-10-26T00:00:00Z", duration: -1, stop: null });
			}
			return json({ id: 55 });
		});
		await call("stop_time_entry");
		const patch = calls.find((request) => request.init?.method === "PATCH");
		expect(patch?.url.pathname).toBe("/api/v9/workspaces/2/time_entries/55/stop");
	});

	it("reports that nothing is running when stopping without a timer", async () => {
		mockFetch((url) => (url.pathname === "/api/v9/me/time_entries/current" ? json(null) : undefined));
		const result = await call("stop_time_entry");
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toBe("No timer is running");
	});
});

describe("get_current_entry", () => {
	it("reports no timer when none is running", async () => {
		mockFetch((url) => (url.pathname === "/api/v9/me/time_entries/current" ? json(null) : undefined));
		expect(JSON.parse((await call("get_current_entry")).content[0]?.text ?? "")).toEqual({ running: false });
	});
});

describe("toggl_api_request", () => {
	it("passes v9 and Reports v3 paths through", async () => {
		const calls = mockFetch(() => json({ ok: 1 }));
		await call("toggl_api_request", { method: "GET", path: "/api/v9/me/features" });
		await call("toggl_api_request", { method: "POST", path: "/reports/api/v3/workspace/1/search/time_entries", body: { a: 1 } });
		expect(calls.map((request) => request.url.pathname)).toEqual(["/api/v9/me/features", "/reports/api/v3/workspace/1/search/time_entries"]);
	});

	it("refuses other paths, other hosts and traversal", async () => {
		const calls = mockFetch(() => json({}));
		for (const path of ["/api/v8/me", "https://evil.example/api/v9/me", "/api/v9/../../admin", "//evil.example/api/v9/me"]) {
			const result = await call("toggl_api_request", { method: "GET", path });
			expect(result.isError, path).toBe(true);
		}
		expect(calls).toHaveLength(0);
	});
});
