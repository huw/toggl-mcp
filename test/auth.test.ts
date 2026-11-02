import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { bindStateToSession, createOAuthState } from "../src/workers-oauth-utils";

const redirectUri = "https://claude.ai/api/mcp/auth_callback";

/** Seeds the record dynamic registration would write. Posting a body through exports.default.fetch hangs in workerd. */
async function registerClient() {
	const clientId = "test-client";
	await env.OAUTH_KV.put(
		`client:${clientId}`,
		JSON.stringify({
			clientId,
			clientName: "test",
			redirectUris: [redirectUri],
			grantTypes: ["authorization_code", "refresh_token"],
			responseTypes: ["code"],
			tokenEndpointAuthMethod: "none",
			authMethodExplicit: true,
			registrationDate: 1_700_000_000,
		}),
	);
	return clientId;
}

async function callbackAs(login: string) {
	const clientId = await registerClient();
	const { stateToken } = await createOAuthState(
		{
			responseType: "code",
			clientId,
			redirectUri,
			scope: [],
			state: "client-state",
			codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
			codeChallengeMethod: "S256",
		},
		env.OAUTH_KV,
	);
	const { setCookie } = await bindStateToSession(stateToken);
	return exports.default.fetch(
		new Request(`https://toggl-mcp.test/callback?code=${login}&state=${stateToken}`, {
			headers: { Cookie: setCookie.split(";")[0] ?? "" },
			redirect: "manual",
		}),
	);
}

describe("GitHub allow-list", () => {
	it("returns 403 to any other GitHub login after sign-in", { timeout: 30_000 }, async () => {
		const response = await callbackAs("someone-else");
		expect(response.status).toBe(403);
		expect(response.headers.get("Location")).toBeNull();
	});

	it("completes authorization for the allowed login, ignoring case", { timeout: 30_000 }, async () => {
		const response = await callbackAs("Huw");
		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toMatch(new RegExp(`^${redirectUri}\\?code=`));
	});
});

describe("MCP endpoint", () => {
	it("refuses a request without an access token", async () => {
		const response = await exports.default.fetch(
			new Request("https://toggl-mcp.test/mcp", {
				method: "POST",
				headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
			}),
		);
		expect(response.status).toBe(401);
	});

	it("advertises its OAuth endpoints for connectors", async () => {
		const response = await exports.default.fetch("https://toggl-mcp.test/.well-known/oauth-authorization-server");
		const metadata = (await response.json()) as Record<string, string>;
		expect(metadata.authorization_endpoint).toBe("https://toggl-mcp.test/authorize");
		expect(metadata.registration_endpoint).toBe("https://toggl-mcp.test/register");
	});
});
