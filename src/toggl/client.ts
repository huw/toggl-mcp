import { env } from "cloudflare:workers";
import { Temporal } from "temporal-polyfill";
import { z } from "zod";

export class TogglError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

const MAX_RETRIES = 3;
const MAX_WAIT_SECONDS = 15;
const CACHE_TTL_MS = 10 * 60 * 1000;

const cache = new Map<string, { expires: number; value: unknown }>();

export function clearCache() {
	cache.clear();
}

function explain(status: number, path: string, detail: string) {
	switch (status) {
		case 401:
		case 403:
			return `Toggl rejected the API token (HTTP ${status}) for ${path}. Check the TOGGL_API_TOKEN secret and that the account can use this endpoint.`;
		case 402:
			return `Toggl returned 402 Payment Required for ${path}: this usually means the Toggl plan does not include the endpoint or its hourly quota is spent. Wait and retry, or check the plan.`;
		case 429:
			return `Toggl rate limit hit (HTTP 429) for ${path} and retries did not clear it. Wait a minute and retry.`;
		default:
			return `Toggl returned HTTP ${status} for ${path}: ${detail}`;
	}
}

/** `path` starts with /api/v9 or /reports/api/v3. A 402 or 429 is retried after the Retry-After delay, up to three times, if that delay is short. */
export async function toggl(
	method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
	path: string,
	{ body, query }: { body?: unknown; query?: Record<string, string | number | boolean | undefined> } = {},
) {
	const url = new URL(`https://api.track.toggl.com${path}`);
	for (const [key, value] of Object.entries(query ?? {})) {
		if (value !== undefined) {
			url.searchParams.set(key, String(value));
		}
	}
	if (method !== "GET") {
		clearCache();
	}

	for (let attempt = 0; ; attempt++) {
		const response = await fetch(url, {
			method,
			headers: {
				Authorization: `Basic ${btoa(`${env.TOGGL_API_TOKEN}:api_token`)}`,
				"Content-Type": "application/json",
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});

		if (response.ok) {
			const text = await response.text();
			return text === "" ? null : (JSON.parse(text) as unknown);
		}

		const retryable = response.status === 429 || response.status === 402;
		const waitSeconds = Number(response.headers.get("Retry-After") ?? 2 ** attempt);
		if (retryable && attempt < MAX_RETRIES && waitSeconds <= MAX_WAIT_SECONDS) {
			await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
			continue;
		}

		console.error("Toggl request failed", { "http.status": response.status, "http.path": path });
		const detail = (await response.text()).slice(0, 300);
		const retryHint = retryable && waitSeconds > MAX_WAIT_SECONDS ? ` Toggl asked to wait ${waitSeconds} seconds.` : "";
		throw new TogglError(explain(response.status, path, detail) + retryHint, response.status);
	}
}

/** Caches static lookups (projects, clients, tags) for about 10 minutes. Any write clears the whole cache. */
export async function cached<Schema extends z.ZodType>(
	key: string,
	schema: Schema,
	load: () => Promise<unknown>,
): Promise<z.infer<Schema>> {
	const hit = cache.get(key);
	if (hit && hit.expires > Temporal.Now.instant().epochMilliseconds) {
		return hit.value as z.infer<Schema>;
	}
	const value = schema.parse(await load());
	cache.set(key, { expires: Temporal.Now.instant().epochMilliseconds + CACHE_TTL_MS, value });
	return value;
}
