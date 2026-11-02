import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearCache, TogglError, toggl } from "../src/toggl/client";
import { json, mockFetch } from "./helpers";

beforeEach(() => {
	clearCache();
	vi.unstubAllGlobals();
});

describe("toggl client", () => {
	it("authenticates with the API token as HTTP Basic auth", async () => {
		const calls = mockFetch(() => json({ ok: true }));
		await toggl("GET", "/api/v9/me");
		const headers = new Headers(calls[0]?.init?.headers);
		expect(headers.get("Authorization")).toBe(`Basic ${btoa("test-toggl-token:api_token")}`);
		expect(calls[0]?.url.href).toBe("https://api.track.toggl.com/api/v9/me");
	});

	it("retries a 429 after the Retry-After delay, then succeeds", async () => {
		let attempts = 0;
		mockFetch(() => (++attempts < 3 ? new Response("slow down", { status: 429, headers: { "Retry-After": "0" } }) : json({ ok: true })));
		expect(await toggl("GET", "/api/v9/me")).toEqual({ ok: true });
		expect(attempts).toBe(3);
	});

	it("retries a 402, then reports a clear error when it persists", async () => {
		let attempts = 0;
		mockFetch(() => {
			attempts++;
			return new Response("quota", { status: 402, headers: { "Retry-After": "0" } });
		});
		await expect(toggl("POST", "/reports/api/v3/workspace/1/summary/time_entries")).rejects.toThrow(/402 Payment Required.*plan/);
		expect(attempts).toBe(4);
	});

	it("does not wait out a long Retry-After inside one request", async () => {
		let attempts = 0;
		mockFetch(() => {
			attempts++;
			return new Response("", { status: 429, headers: { "Retry-After": "3000" } });
		});
		const error = await toggl("GET", "/api/v9/me").catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(TogglError);
		expect((error as TogglError).message).toContain("3000 seconds");
		expect(attempts).toBe(1);
	});

	it("explains a rejected token without echoing it", async () => {
		mockFetch(() => new Response("nope", { status: 403 }));
		const error = (await toggl("GET", "/api/v9/me").catch((caught: unknown) => caught)) as TogglError;
		expect(error.status).toBe(403);
		expect(error.message).toContain("TOGGL_API_TOKEN");
		expect(error.message).not.toContain("test-toggl-token");
	});

	it("returns null for an empty body", async () => {
		mockFetch(() => new Response(null, { status: 200 }));
		expect(await toggl("DELETE", "/api/v9/workspaces/1/tags/2")).toBeNull();
	});
});
