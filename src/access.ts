import { env } from "cloudflare:workers";
import { createRemoteJWKSet, jwtVerify } from "jose";

const keys = createRemoteJWKSet(new URL(`https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`));

/** Access signs every request it lets through. Checking the signature and audience stops a request that reached the Worker some other way. */
export async function isFromAccess(request: Request) {
	const token = request.headers.get("Cf-Access-Jwt-Assertion");
	if (!token) {
		return false;
	}
	try {
		await jwtVerify(token, keys, { issuer: `https://${env.ACCESS_TEAM_DOMAIN}`, audience: env.ACCESS_AUD });
		return true;
	} catch {
		return false;
	}
}
