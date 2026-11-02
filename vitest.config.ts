import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
			miniflare: {
				// Stands in for GitHub when the real worker runs through exports.default. The authorization code a test passes is echoed back as the access token, then as the login.
				outboundService: async (request: Request) => {
					const { href } = new URL(request.url);
					if (href === "https://github.com/login/oauth/access_token") {
						const code = new URLSearchParams(await request.text()).get("code");
						return new Response(`access_token=${code}&token_type=bearer`, {
							headers: { "Content-Type": "application/x-www-form-urlencoded" },
						});
					}
					if (href === "https://api.github.com/user") {
						const login = request.headers.get("Authorization")?.split(" ")[1];
						return Response.json({ login, id: 1 });
					}
					return new Response(`Unmocked request: ${href}`, { status: 500 });
				},
				bindings: {
					GITHUB_CLIENT_ID: "test-client-id",
					GITHUB_CLIENT_SECRET: "test-client-secret",
					COOKIE_ENCRYPTION_KEY: "0".repeat(64),
					TOGGL_API_TOKEN: "test-toggl-token",
				},
			},
		}),
	],
	test: { include: ["test/**/*.test.ts"] },
});
