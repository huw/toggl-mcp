import { env, exports } from "cloudflare:workers";
import { importJWK, SignJWT } from "jose";
import { describe, expect, it } from "vitest";

async function accessToken(claims: { aud?: string; iss?: string; expiresIn?: string } = {}) {
	const key = await importJWK(JSON.parse((env as unknown as { TEST_ACCESS_PRIVATE_JWK: string }).TEST_ACCESS_PRIVATE_JWK), "RS256");
	return new SignJWT({ email: "huw@example.com" })
		.setProtectedHeader({ alg: "RS256", kid: "test" })
		.setIssuer(claims.iss ?? "https://test.cloudflareaccess.com")
		.setAudience(claims.aud ?? "test-aud")
		.setIssuedAt()
		.setExpirationTime(claims.expiresIn ?? "5m")
		.sign(key);
}

function get(path: string, token?: string) {
	return exports.default.fetch(`https://toggl-mcp.test${path}`, {
		headers: token ? { "Cf-Access-Jwt-Assertion": token } : {},
	});
}

describe("Cloudflare Access gate", () => {
	it("refuses a request that did not come through Access", async () => {
		expect((await get("/mcp")).status).toBe(403);
	});

	it("refuses a token for another Access application", async () => {
		expect((await get("/mcp", await accessToken({ aud: "other-app" }))).status).toBe(403);
	});

	it("refuses a token from another team", async () => {
		expect((await get("/mcp", await accessToken({ iss: "https://other.cloudflareaccess.com" }))).status).toBe(403);
	});

	it("refuses an expired token", async () => {
		expect((await get("/mcp", await accessToken({ expiresIn: "-1m" }))).status).toBe(403);
	});

	it("lets a valid Access token through to the MCP handler", async () => {
		const response = await get("/mcp", await accessToken());
		expect(response.status).not.toBe(403);
	});

	it("serves nothing outside /mcp", async () => {
		expect((await get("/", await accessToken())).status).toBe(404);
	});
});
