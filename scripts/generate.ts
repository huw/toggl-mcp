// Turns Toggl's OpenAPI (Swagger 2.0) specs in specs/ into src/generated/operations.json, one MCP tool per operation.
// Run with `pnpm generate` after `pnpm specs:fetch`.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

type Json = Record<string, any>;

const sources = [
	{ file: "api", prefix: "/api/v9", namePrefix: "" },
	{ file: "reports", prefix: "", namePrefix: "reports_" },
	// The webhooks spec omits its base path. Toggl serves it at /webhooks/api/v1.
	{ file: "webhooks", prefix: "/webhooks/api/v1", namePrefix: "webhooks_" },
];
const METHODS = ["get", "post", "put", "patch", "delete"];
const MAX_NAME = 64;
const MAX_DESCRIPTION = 2000;

function clean(schema: unknown): unknown {
	if (Array.isArray(schema)) {
		return schema.map(clean);
	}
	if (schema === null || typeof schema !== "object") {
		return schema;
	}
	return Object.fromEntries(
		Object.entries(schema)
			.filter(([key]) => !key.startsWith("x-") && key !== "example" && key !== "discriminator")
			.map(([key, value]) => [key, key === "properties" ? mapValues(value, clean) : clean(value)]),
	);
}

function mapValues(object: Json, map: (value: unknown) => unknown) {
	return Object.fromEntries(Object.entries(object ?? {}).map(([key, value]) => [key, map(value)]));
}

function resolver(spec: Json) {
	const resolve = (schema: unknown, seen: string[]): unknown => {
		if (Array.isArray(schema)) {
			return schema.map((item) => resolve(item, seen));
		}
		if (schema === null || typeof schema !== "object") {
			return schema;
		}
		const ref = (schema as Json).$ref;
		if (typeof ref === "string") {
			const name = ref.replace("#/definitions/", "");
			if (seen.includes(name)) {
				return { type: "object", description: `${name} (recursive, shape omitted)` };
			}
			return resolve(spec.definitions?.[name] ?? { type: "object" }, [...seen, name]);
		}
		return mapValues(schema as Json, (value) => resolve(value, seen));
	};
	return (schema: unknown) => clean(resolve(schema, []));
}

function toolName(raw: string) {
	const name = raw
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");
	if (name.length <= MAX_NAME) {
		return name;
	}
	const hash = createHash("sha1").update(name).digest("hex").slice(0, 6);
	return `${name.slice(0, MAX_NAME - 7)}_${hash}`;
}

const operations: Json[] = [];
const names = new Set<string>();

for (const source of sources) {
	const spec = JSON.parse(readFileSync(`specs/${source.file}.json`, "utf8"));
	const resolve = resolver(spec);
	const parameter = (param: Json) =>
		param.$ref ? spec.parameters[param.$ref.replace("#/parameters/", "")] : param;

	for (const [path, item] of Object.entries<Json>(spec.paths)) {
		for (const method of METHODS) {
			const op = item[method];
			if (!op) {
				continue;
			}
			const fullPath = `${source.prefix}${path}`;
			// The Reports and Webhooks specs have no operationIds, so their names come from the path without its version prefix and parameters.
			const fallback = `${method}_${path
				.replace(/^\/(reports\/api\/v3|insights\/api\/v1)(\/workspace)?/, "")
				.replace(/\{[^}]+\}/g, "")}`;
			const base = `${source.namePrefix}${op.operationId ?? fallback}`;
			let name = toolName(base);
			for (let suffix = 2; names.has(name); suffix++) {
				name = toolName(`${base}_${suffix}`);
			}
			names.add(name);

			const declared = [...(item.parameters ?? []), ...(op.parameters ?? [])].map(parameter);
			// A few operations use a path placeholder without declaring it.
			const undeclared = [...path.matchAll(/\{([^}]+)\}/g)]
				.map(([, name]) => name)
				.filter((name) => !declared.some((param) => param.in === "path" && param.name === name))
				.map((name) => ({ name, in: "path", type: "string", required: true }));
			const params = [...declared, ...undeclared];
			const properties: Json = {};
			const required: string[] = [];
			const args: { arg: string; name: string; in: string }[] = [];
			const taken = new Set(params.filter((param) => param.in !== "body").map((param) => param.name));

			for (const param of params) {
				if (param.in === "header") {
					continue;
				}
				if (param.in === "body") {
					const arg = taken.has("body") ? "request_body" : "body";
					properties[arg] = { ...(resolve(param.schema) as Json), description: param.description ?? "Request body" };
					args.push({ arg, name: arg, in: "body" });
					if (param.required) {
						required.push(arg);
					}
					continue;
				}
				const arg = args.some((existing) => existing.arg === param.name) ? `${param.in}_${param.name}` : param.name;
				const { name: _name, in: _in, required: isRequired, collectionFormat: _format, ...schema } = param;
				// Some GET operations declare formData parameters, which a GET cannot carry, so they go in the query string. The avatar upload declares its file as a string named "file".
				const isFile = param.type === "file" || (param.in === "formData" && param.name === "file");
				properties[arg] = isFile
					? { type: "string", description: `${param.description ?? "File"} (base64-encoded contents)` }
					: resolve(schema);
				const location = isFile ? "file" : param.in === "formData" && method === "get" ? "query" : param.in;
				args.push({ arg, name: param.name, in: location });
				if (isRequired || param.in === "path") {
					required.push(arg);
				}
			}

			const summary = [op.summary, op.description].filter(Boolean).join("\n\n").trim();
			operations.push({
				name,
				method: method.toUpperCase(),
				path: fullPath,
				description: `${method.toUpperCase()} ${fullPath}${summary ? `\n\n${summary}` : ""}`.slice(0, MAX_DESCRIPTION),
				args,
				inputSchema: { type: "object", properties, ...(required.length > 0 ? { required } : {}) },
			});
		}
	}
}

writeFileSync("src/generated/operations.json", `${JSON.stringify(operations)}\n`);
console.log(`Wrote ${operations.length} operations`);
