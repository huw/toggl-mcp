// Downloads Toggl's published OpenAPI specs into specs/. The asset file names carry content hashes, so they are read from the docs page.
import { writeFileSync } from "node:fs";

const page = await (await fetch("https://engineering.toggl.com/docs/track/openapi/")).text();
for (const name of ["api", "reports", "webhooks"]) {
	const asset = page.match(new RegExp(`/assets/files/${name}-[0-9a-f]+\\.json`))?.[0];
	if (!asset) {
		throw new Error(`No ${name} spec linked from the OpenAPI page`);
	}
	const spec = await (await fetch(`https://engineering.toggl.com${asset}`)).json();
	writeFileSync(`specs/${name}.json`, `${JSON.stringify(spec, null, 2)}\n`);
	console.log(`specs/${name}.json <- ${asset}`);
}
