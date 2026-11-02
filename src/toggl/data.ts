import { Temporal } from "temporal-polyfill";
import { z } from "zod";
import { cached, toggl } from "./client";
import { type DateRange, entrySpan } from "./dates";

const Me = z.object({
	id: z.number(),
	email: z.string(),
	fullname: z.string(),
	timezone: z.string(),
	default_workspace_id: z.number(),
	beginning_of_week: z.number(),
});

const Workspace = z.object({
	id: z.number(),
	name: z.string(),
	organization_id: z.number().nullish(),
	admin: z.boolean().nullish(),
});

const Project = z.object({
	id: z.number(),
	name: z.string(),
	client_id: z.number().nullish(),
	active: z.boolean(),
	billable: z.boolean().nullish(),
	color: z.string().nullish(),
});

const Client = z.object({ id: z.number(), name: z.string(), archived: z.boolean().nullish() });
const Tag = z.object({ id: z.number(), name: z.string() });

export const TimeEntry = z.object({
	id: z.number(),
	workspace_id: z.number(),
	project_id: z.number().nullish(),
	description: z.string().nullish(),
	tags: z.array(z.string()).nullish(),
	billable: z.boolean().nullish(),
	start: z.string(),
	stop: z.string().nullish(),
	duration: z.number(),
});
export type TimeEntry = z.infer<typeof TimeEntry>;

export function getMe() {
	return cached("me", Me, () => toggl("GET", "/api/v9/me"));
}

export function listWorkspaces() {
	return cached("workspaces", z.array(Workspace), () => toggl("GET", "/api/v9/me/workspaces"));
}

export async function resolveWorkspace(workspaceId: number | undefined) {
	return workspaceId ?? (await getMe()).default_workspace_id;
}

export function listClients(workspaceId: number) {
	return cached(`clients:${workspaceId}`, z.array(Client), async () =>
		(await toggl("GET", `/api/v9/workspaces/${workspaceId}/clients`, { query: { status: "both" } })) ?? [],
	);
}

export function listTags(workspaceId: number) {
	return cached(`tags:${workspaceId}`, z.array(Tag), async () =>
		(await toggl("GET", `/api/v9/workspaces/${workspaceId}/tags`)) ?? [],
	);
}

export function listProjects(workspaceId: number) {
	return cached(`projects:${workspaceId}`, z.array(Project), async () => {
		const perPage = 200;
		const projects: unknown[] = [];
		for (let page = 1; ; page++) {
			const batch =
				((await toggl("GET", `/api/v9/workspaces/${workspaceId}/projects`, {
					query: { active: "both", per_page: perPage, page },
				})) as unknown[] | null) ?? [];
			projects.push(...batch);
			if (batch.length < perPage) {
				return projects;
			}
		}
	});
}

export async function projectsWithClients(workspaceId: number) {
	const [projects, clients] = await Promise.all([listProjects(workspaceId), listClients(workspaceId)]);
	const clientNames = new Map(clients.map((client) => [client.id, client.name]));
	return projects.map((project) => ({
		...project,
		client: project.client_id ? (clientNames.get(project.client_id) ?? null) : null,
	}));
}

/** Entries carry only ids for projects and clients, so names come from the cached per-workspace lookups. */
export async function resolveEntries(entries: TimeEntry[], now: Temporal.Instant) {
	const workspaceIds = [...new Set(entries.map((entry) => entry.workspace_id))];
	const projectsByWorkspace = new Map(
		await Promise.all(
			workspaceIds.map(async (workspaceId) => [workspaceId, await projectsWithClients(workspaceId)] as const),
		),
	);
	const projectById = new Map(
		[...projectsByWorkspace.values()].flat().map((project) => [project.id, project] as const),
	);

	return entries.map((entry) => {
		const project = entry.project_id ? projectById.get(entry.project_id) : undefined;
		return {
			entry,
			span: entrySpan(entry, now),
			description: entry.description ?? "",
			project: project?.name ?? null,
			client: project?.client ?? null,
			tags: entry.tags ?? [],
			running: entry.duration < 0,
		};
	});
}
export type ResolvedEntry = Awaited<ReturnType<typeof resolveEntries>>[number];

const WINDOW_DAYS = 60;

/**
 * Entries overlapping `range`. Toggl filters by start time, so the window opens a day early to catch entries that began
 * before the range, and is fetched in 60-day chunks because the endpoint caps the span.
 */
export async function fetchEntries(range: DateRange, now: Temporal.Instant) {
	const byId = new Map<number, TimeEntry>();
	const from = range.start.subtract({ days: 1 }).toInstant();
	const to = range.end.toInstant();
	for (
		let windowStart = from;
		Temporal.Instant.compare(windowStart, to) < 0;
		windowStart = windowStart.add({ hours: WINDOW_DAYS * 24 })
	) {
		const windowEnd = windowStart.add({ hours: WINDOW_DAYS * 24 });
		const batch = z.array(TimeEntry).parse(
			(await toggl("GET", "/api/v9/me/time_entries", {
				query: {
					start_date: windowStart.toString(),
					end_date: (Temporal.Instant.compare(windowEnd, to) < 0 ? windowEnd : to).toString(),
				},
			})) ?? [],
		);
		for (const entry of batch) {
			byId.set(entry.id, entry);
		}
	}
	return resolveEntries([...byId.values()], now);
}
