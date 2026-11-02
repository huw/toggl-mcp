import { generateKeyPairSync } from "node:crypto";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// A throwaway key pair stands in for the Access team's signing key. Tests sign with the private half; the Worker fetches the public half.
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicJwk = { ...publicKey.export({ format: "jwk" }), kid: "test", alg: "RS256", use: "sig" };
const privateJwk = { ...privateKey.export({ format: "jwk" }), kid: "test", alg: "RS256" };

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
			miniflare: {
				bindings: {
					ACCESS_TEAM_DOMAIN: "test.cloudflareaccess.com",
					ACCESS_AUD: "test-aud",
					TOGGL_API_TOKEN: "test-toggl-token",
					TEST_ACCESS_PRIVATE_JWK: JSON.stringify(privateJwk),
				},
				outboundService: (request: Request) => {
					if (request.url === "https://test.cloudflareaccess.com/cdn-cgi/access/certs") {
						return Response.json({ keys: [publicJwk] });
					}
					return new Response(`Unmocked request: ${request.url}`, { status: 500 });
				},
			},
		}),
	],
	// The first request into the Worker loads the whole bundle, which takes several seconds in the test runner.
	test: { include: ["test/**/*.test.ts"], testTimeout: 30_000 },
});
