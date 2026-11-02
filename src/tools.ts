import type { McpServer } from "@modelcontextprotocol/server";
import { Temporal } from "temporal-polyfill";
import { z } from "zod";
import { TogglError, toggl } from "./toggl/client";
import {
	getMe,
	listClients,
	listTags,
	listWorkspaces,
	projectsWithClients,
	resolveEntries,
	resolveWorkspace,
	TimeEntry,
} from "./toggl/data";
import { hours, InputError, parseMoment, toLocal, ZONE } from "./toggl/dates";
import { listTimeEntries, summary, weeklyReview } from "./toggl/reports";

const day = z.string().describe("YYYY-MM-DD, a calendar date in Australia/Sydney");
const moment = z
	.string()
	.describe("ISO 8601. With an offset or Z it is used as is. Without one it is Sydney local time, e.g. 2026-11-02T09:30");
const workspaceId = z.number().int().optional().describe("Defaults to the default workspace");
const id = z.number().int();

type CrudInput = { workspace_id?: number; project_id?: number; id?: number } & Record<string, unknown>;
type Kind = "read" | "write" | "delete";

function register<Shape extends z.ZodRawShape>(
	server: McpServer,
	name: string,
	kind: Kind,
	description: string,
	shape: Shape,
	run: (input: z.infer<z.ZodObject<Shape>>) => Promise<unknown>,
) {
	server.registerTool(
		name,
		{
			description,
			inputSchema: z.object(shape),
			annotations: { readOnlyHint: kind === "read", destructiveHint: kind === "delete", idempotentHint: kind !== "write" },
		},
		async (input: z.infer<z.ZodObject<Shape>>) => {
			try {
				const result = await run(input);
				return { content: [{ type: "text" as const, text: typeof result === "string" ? result : JSON.stringify(result) }] };
			} catch (error) {
				if (error instanceof TogglError || error instanceof InputError) {
					return { isError: true, content: [{ type: "text" as const, text: error.message }] };
				}
				throw error;
			}
		},
	);
}

function compact<Value extends Record<string, unknown>>(value: Value) {
	return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function entryPayload(input: {
	start?: string;
	stop?: string;
	description?: string;
	project_id?: number;
	task_id?: number;
	tags?: string[];
	billable?: boolean;
}) {
	return compact({
		description: input.description,
		project_id: input.project_id,
		task_id: input.task_id,
		tags: input.tags,
		billable: input.billable,
		start: input.start === undefined ? undefined : parseMoment(input.start).toString(),
		stop: input.stop === undefined ? undefined : parseMoment(input.stop).toString(),
	});
}

export function registerTools(server: McpServer) {
	const now = () => Temporal.Now.instant();

	register(server, "get_me", "read", "The Toggl user, default workspace and profile timezone.", {}, async () => {
		const [me, workspaces] = await Promise.all([getMe(), listWorkspaces()]);
		return {
			id: me.id,
			email: me.email,
			name: me.fullname,
			profile_timezone: me.timezone,
			reporting_timezone: ZONE,
			default_workspace: workspaces.find((workspace) => workspace.id === me.default_workspace_id) ?? me.default_workspace_id,
		};
	});

	register(server, "list_workspaces", "read", "Workspaces the user belongs to.", {}, listWorkspaces);

	register(
		server,
		"list_projects",
		"read",
		"Projects with their client names. Cached for about 10 minutes.",
		{ workspace_id: workspaceId, status: z.enum(["active", "archived", "both"]).default("both") },
		async ({ workspace_id, status }) =>
			(await projectsWithClients(await resolveWorkspace(workspace_id)))
				.filter((project) => status === "both" || project.active === (status === "active"))
				.map(({ client_id, ...project }) => ({ ...project, client_id: client_id ?? null })),
	);

	register(server, "list_clients", "read", "Clients. Cached for about 10 minutes.", { workspace_id: workspaceId }, async ({ workspace_id }) =>
		listClients(await resolveWorkspace(workspace_id)),
	);

	register(server, "list_tags", "read", "Tags. Cached for about 10 minutes.", { workspace_id: workspaceId }, async ({ workspace_id }) =>
		listTags(await resolveWorkspace(workspace_id)),
	);

	register(
		server,
		"list_tasks",
		"read",
		"Tasks of one project.",
		{ workspace_id: workspaceId, project_id: id },
		async ({ workspace_id, project_id }) =>
			(await toggl("GET", `/api/v9/workspaces/${await resolveWorkspace(workspace_id)}/projects/${project_id}/tasks`)) ?? [],
	);

	register(server, "get_current_entry", "read", "The running timer, if any.", {}, async () => {
		const current = await toggl("GET", "/api/v9/me/time_entries/current");
		if (current === null) {
			return { running: false };
		}
		const [row] = await resolveEntries([TimeEntry.parse(current)], now());
		if (!row) {
			return { running: false };
		}
		return {
			running: true,
			id: row.entry.id,
			workspace_id: row.entry.workspace_id,
			description: row.description,
			project: row.project,
			client: row.client,
			tags: row.tags,
			start: toLocal(row.span.start),
			elapsed_hours: hours((row.span.stop.epochMilliseconds - row.span.start.epochMilliseconds) / 1000),
		};
	});

	register(
		server,
		"list_time_entries",
		"read",
		"Time entries overlapping the date range (both dates inclusive, Australia/Sydney). Entries crossing midnight or the range edges are clipped: `hours` counts only the part inside the range. A running timer counts up to now.",
		{ start_date: day, end_date: day },
		({ start_date, end_date }) => listTimeEntries(start_date, end_date, now()),
	);

	register(
		server,
		"summary",
		"read",
		"Hours grouped by project, client or tag, with a grand total. Project and client use the Reports API v3 summary. Tag is totalled from time entries, because Reports v3 cannot group by tag, and a multi-tag entry counts toward each tag. sub_group_by: project allows entry, task, user; client allows entry, task, project, user; tag allows project, client, entry.",
		{
			start_date: day,
			end_date: day,
			group_by: z.enum(["project", "client", "tag"]),
			sub_group_by: z.enum(["project", "client", "task", "user", "entry"]).optional(),
			workspace_id: workspaceId,
		},
		({ start_date, end_date, group_by, sub_group_by, workspace_id }) =>
			summary(start_date, end_date, group_by, sub_group_by, workspace_id, now()),
	);

	register(
		server,
		"weekly_review",
		"read",
		"Monday to Sunday review in Australia/Sydney: total hours, hours per day, per project, per client and per tag, top 10 entries, and the comparison with the previous week. Defaults to last week.",
		{ week_start: day.optional().describe("A Monday, YYYY-MM-DD. Defaults to last Monday.") },
		({ week_start }) => weeklyReview(week_start, now()),
	);

	register(
		server,
		"create_time_entry",
		"write",
		"Create a time entry. With stop it is a finished entry. Without stop it starts a running timer (start defaults to now).",
		{
			workspace_id: workspaceId,
			description: z.string().optional(),
			project_id: id.optional(),
			task_id: id.optional(),
			tags: z.array(z.string()).optional().describe("Tag names"),
			billable: z.boolean().optional(),
			start: moment.optional(),
			stop: moment.optional(),
		},
		async ({ workspace_id, start, ...rest }) => {
			const startInstant = start === undefined ? now() : parseMoment(start);
			const stopInstant = rest.stop === undefined ? undefined : parseMoment(rest.stop);
			if (stopInstant && Temporal.Instant.compare(stopInstant, startInstant) <= 0) {
				throw new InputError("stop must be after start");
			}
			const workspace = await resolveWorkspace(workspace_id);
			return toggl("POST", `/api/v9/workspaces/${workspace}/time_entries`, {
				body: {
					...(entryPayload({ ...rest, start: startInstant.toString() })),
					workspace_id: workspace,
					duration: stopInstant ? Math.round((stopInstant.epochMilliseconds - startInstant.epochMilliseconds) / 1000) : -1,
					created_with: "toggl-mcp",
				},
			});
		},
	);

	register(
		server,
		"stop_time_entry",
		"write",
		"Stop a running timer. Without an id it stops the current one.",
		{ workspace_id: workspaceId, id: id.optional() },
		async ({ workspace_id, id: entryId }) => {
			if (entryId !== undefined) {
				return toggl("PATCH", `/api/v9/workspaces/${await resolveWorkspace(workspace_id)}/time_entries/${entryId}/stop`);
			}
			const current = await toggl("GET", "/api/v9/me/time_entries/current");
			if (current === null) {
				throw new InputError("No timer is running");
			}
			const entry = TimeEntry.parse(current);
			return toggl("PATCH", `/api/v9/workspaces/${entry.workspace_id}/time_entries/${entry.id}/stop`);
		},
	);

	register(
		server,
		"update_time_entry",
		"write",
		"Change fields of a time entry. Only the fields given are sent.",
		{
			workspace_id: workspaceId,
			id,
			description: z.string().optional(),
			project_id: id.optional(),
			task_id: id.optional(),
			tags: z.array(z.string()).optional().describe("Tag names"),
			billable: z.boolean().optional(),
			start: moment.optional(),
			stop: moment.optional(),
		},
		async ({ workspace_id, id: entryId, ...fields }) =>
			toggl("PUT", `/api/v9/workspaces/${await resolveWorkspace(workspace_id)}/time_entries/${entryId}`, {
				body: entryPayload(fields),
			}),
	);

	register(
		server,
		"delete_time_entry",
		"delete",
		"Permanently delete a time entry.",
		{ workspace_id: workspaceId, id },
		async ({ workspace_id, id: entryId }) => {
			await toggl("DELETE", `/api/v9/workspaces/${await resolveWorkspace(workspace_id)}/time_entries/${entryId}`);
			return { deleted: entryId };
		},
	);

	const project = {
		name: z.string(),
		client_id: id.optional(),
		active: z.boolean().optional(),
		billable: z.boolean().optional(),
		is_private: z.boolean().optional(),
		color: z.string().optional().describe("Hex colour such as #06aaf5"),
	};
	const tag = { name: z.string() };
	const client = { name: z.string() };
	const task = {
		name: z.string(),
		active: z.boolean().optional(),
		estimated_seconds: z.number().int().optional(),
	};

	const resources: { noun: string; path: string; fields: z.ZodRawShape; parent: z.ZodRawShape }[] = [
		{ noun: "project", path: "projects", fields: project, parent: {} },
		{ noun: "client", path: "clients", fields: client, parent: {} },
		{ noun: "tag", path: "tags", fields: tag, parent: {} },
		{ noun: "task", path: "tasks", fields: task, parent: { project_id: id } },
	];

	for (const resource of resources) {
		const base = async ({ workspace_id, project_id }: CrudInput) => {
			const workspace = await resolveWorkspace(workspace_id);
			return resource.noun === "task"
				? `/api/v9/workspaces/${workspace}/projects/${project_id}/tasks`
				: `/api/v9/workspaces/${workspace}/${resource.path}`;
		};

		register(
			server,
			`create_${resource.noun}`,
			"write",
			`Create a ${resource.noun}.`,
			{ workspace_id: workspaceId, ...resource.parent, ...resource.fields },
			async (input) => {
				const { workspace_id, project_id, ...body } = input as CrudInput;
				return toggl("POST", await base({ workspace_id, project_id }), { body: compact(body) });
			},
		);
		register(
			server,
			`update_${resource.noun}`,
			"write",
			`Change a ${resource.noun}. Only the fields given are sent.`,
			{ workspace_id: workspaceId, ...resource.parent, id, ...partial(resource.fields) },
			async (input) => {
				const { workspace_id, project_id, id: itemId, ...body } = input as CrudInput;
				return toggl("PUT", `${await base({ workspace_id, project_id })}/${itemId}`, { body: compact(body) });
			},
		);
		register(
			server,
			`delete_${resource.noun}`,
			"delete",
			`Permanently delete a ${resource.noun}.`,
			{ workspace_id: workspaceId, ...resource.parent, id },
			async (input) => {
				const { workspace_id, project_id, id: itemId } = input as CrudInput;
				await toggl("DELETE", `${await base({ workspace_id, project_id })}/${itemId}`);
				return { deleted: itemId };
			},
		);
	}

	register(
		server,
		"toggl_api_request",
		"delete",
		"Escape hatch for any Toggl Track API v9 (/api/v9/...) or Reports API v3 (/reports/api/v3/...) endpoint the other tools do not cover. Can change or delete data. Returns Toggl's raw JSON.",
		{
			method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
			path: z.string().describe("Starts with /api/v9/ or /reports/api/v3/"),
			query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
			body: z.unknown().optional(),
		},
		async ({ method, path, query, body }) => {
			const allowed = /^\/(api\/v9|reports\/api\/v3)\//;
			const normalised = new URL(path, "https://api.track.toggl.com").pathname;
			if (!allowed.test(path) || !allowed.test(normalised) || /[?#]/.test(path)) {
				throw new InputError("path must start with /api/v9/ or /reports/api/v3/, with query parameters in query");
			}
			return (await toggl(method, normalised, { query, body })) ?? { ok: true };
		},
	);
}

function partial(shape: z.ZodRawShape) {
	return Object.fromEntries(Object.entries(shape).map(([key, schema]) => [key, z.optional(schema)]));
}
