import { Temporal } from "temporal-polyfill";
import { vi } from "vitest";
import { ZONE } from "../src/toggl/dates";

export const sydney = (local: string) => Temporal.ZonedDateTime.from(`${local}[${ZONE}]`).toInstant();

export function json(body: unknown, init: ResponseInit = {}) {
	return Response.json(body, init);
}

/** Replaces global fetch. A request no route answers throws, so a test can never reach the network. */
export function mockFetch(route: (url: URL, init: RequestInit | undefined) => Response | Promise<Response> | undefined) {
	const calls: { url: URL; init: RequestInit | undefined }[] = [];
	async function mock(input: RequestInfo | URL, init?: RequestInit) {
		const url = new URL(input instanceof Request ? input.url : input);
		calls.push({ url, init });
		const response = await route(url, init);
		if (!response) {
			throw new Error(`Unmocked request: ${init?.method ?? "GET"} ${url}`);
		}
		return response;
	}
	vi.stubGlobal("fetch", mock);
	return calls;
}

export function entry(
	id: number,
	from: string,
	to: string | null,
	fields: { project_id?: number; description?: string; tags?: string[] } = {},
) {
	const start = sydney(from);
	const stop = to === null ? null : sydney(to);
	return {
		id,
		workspace_id: 1,
		project_id: fields.project_id ?? null,
		description: fields.description ?? "",
		tags: fields.tags ?? [],
		billable: false,
		start: start.toString(),
		stop: stop?.toString() ?? null,
		duration: stop ? (stop.epochMilliseconds - start.epochMilliseconds) / 1000 : -Math.floor(start.epochMilliseconds / 1000),
	};
}

export const me = {
	id: 7,
	email: "huw@example.com",
	fullname: "Huw",
	timezone: ZONE,
	default_workspace_id: 1,
	beginning_of_week: 1,
};

export function togglApi(entries: unknown[], overrides: Record<string, unknown> = {}) {
	return (url: URL) => {
		const path = url.pathname;
		if (path in overrides) {
			return json(overrides[path]);
		}
		if (path === "/api/v9/me") {
			return json(me);
		}
		if (path === "/api/v9/me/time_entries") {
			return json(entries);
		}
		if (path === "/api/v9/workspaces/1/projects") {
			return json([
				{ id: 10, name: "Fundraising", client_id: 100, active: true },
				{ id: 11, name: "Ops", client_id: null, active: true },
			]);
		}
		if (path === "/api/v9/workspaces/1/clients") {
			return json([{ id: 100, name: "Kaya", archived: false }]);
		}
		return undefined;
	};
}
