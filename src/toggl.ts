import { env } from "cloudflare:workers";
import type { CallToolResult } from "@modelcontextprotocol/server";

export type Operation = {
	name: string;
	method: string;
	path: string;
	description: string;
	args: { arg: string; name: string; in: string }[];
	inputSchema: Record<string, unknown>;
};

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

function explain(status: number, path: string, detail: string) {
	switch (status) {
		case 401:
		case 403:
			return `Toggl refused the request (HTTP ${status}) for ${path}. Check the TOGGL_API_TOKEN secret and that the account may use this endpoint. ${detail}`;
		case 402:
			return `Toggl returned 402 Payment Required for ${path}: the plan does not include this endpoint, or its hourly quota is spent. ${detail}`;
		case 429:
			return `Toggl rate limit (HTTP 429) for ${path} did not clear after retries. Wait a minute and retry.`;
		default:
			return `Toggl returned HTTP ${status} for ${path}: ${detail}`;
	}
}

/** A 402 or 429 is retried after its Retry-After delay, up to three times, when that delay is short. */
export async function toggl(method: string, url: URL, body: BodyInit | undefined, contentType: string | undefined) {
	for (let attempt = 0; ; attempt++) {
		const response = await fetch(url, {
			method,
			headers: {
				Authorization: `Basic ${btoa(`${env.TOGGL_API_TOKEN}:api_token`)}`,
				...(contentType ? { "Content-Type": contentType } : {}),
			},
			body,
		});
		if (response.ok) {
			return response;
		}

		const retryable = response.status === 429 || response.status === 402;
		const waitSeconds = Number(response.headers.get("Retry-After") ?? 2 ** attempt);
		if (retryable && attempt < MAX_RETRIES && waitSeconds <= MAX_WAIT_SECONDS) {
			await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
			continue;
		}

		console.error("Toggl request failed", { "http.status": response.status, "http.method": method, "http.path": url.pathname });
		const detail = (await response.text()).slice(0, 500);
		const hint = retryable && waitSeconds > MAX_WAIT_SECONDS ? ` Toggl asked to wait ${waitSeconds} seconds.` : "";
		throw new TogglError(explain(response.status, url.pathname, detail) + hint, response.status);
	}
}

function base64ToBytes(base64: string) {
	return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

function bytesToBase64(bytes: Uint8Array) {
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary);
}

function append(params: URLSearchParams | FormData, name: string, value: unknown) {
	for (const item of Array.isArray(value) ? value : [value]) {
		params.append(name, typeof item === "object" ? JSON.stringify(item) : String(item));
	}
}

/** Maps tool arguments onto the operation's path, query string and body exactly as the spec declares them. */
export function buildRequest(operation: Operation, input: Record<string, unknown>) {
	let path = operation.path;
	const query = new URLSearchParams();
	const form = new FormData();
	const files: { name: string; value: string }[] = [];
	let body: unknown;

	for (const { arg, name, in: location } of operation.args) {
		const value = input[arg];
		if (value === undefined) {
			continue;
		}
		if (location === "path") {
			path = path.replace(`{${name}}`, encodeURIComponent(String(value)));
		} else if (location === "query") {
			append(query, name, value);
		} else if (location === "formData") {
			append(form, name, value);
		} else if (location === "file") {
			files.push({ name, value: String(value) });
		} else if (location === "body") {
			body = value;
		}
	}

	const url = new URL(`https://api.track.toggl.com${path}`);
	url.search = query.toString();

	for (const file of files) {
		form.append(file.name, new Blob([base64ToBytes(file.value)]), file.name);
	}
	if ([...form.keys()].length > 0) {
		return { url, body: form, contentType: undefined };
	}
	if (body !== undefined) {
		return { url, body: JSON.stringify(body), contentType: "application/json" };
	}
	return { url, body: undefined, contentType: undefined };
}

/** JSON and text come back as text. Anything else, such as a PDF or XLSX export, comes back as a base64 resource. */
export async function callOperation(operation: Operation, input: Record<string, unknown>): Promise<CallToolResult> {
	try {
		const { url, body, contentType } = buildRequest(operation, input);
		const response = await toggl(operation.method, url, body, contentType);
		const type = response.headers.get("Content-Type") ?? "";
		if (type === "" || type.includes("json") || type.startsWith("text/")) {
			const text = await response.text();
			return { content: [{ type: "text", text: text === "" ? `${response.status} ${response.statusText || "OK"}` : text }] };
		}
		return {
			content: [
				{
					type: "resource",
					resource: {
						uri: url.href,
						mimeType: type,
						blob: bytesToBase64(new Uint8Array(await response.arrayBuffer())),
					},
				},
			],
		};
	} catch (error) {
		if (error instanceof TogglError) {
			return { isError: true, content: [{ type: "text", text: error.message }] };
		}
		throw error;
	}
}
