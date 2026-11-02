import { Temporal } from "temporal-polyfill";
import { z } from "zod";
import { toggl } from "./client";
import { fetchEntries, getMe, listClients, projectsWithClients, type ResolvedEntry, resolveWorkspace } from "./data";
import {
	clippedSeconds,
	type DateRange,
	dayRange,
	hours,
	InputError,
	secondsByDay,
	toLocal,
	weekRange,
	weekStartFrom,
	ZONE,
} from "./dates";

const UNTAGGED = "(untagged)";
const NO_PROJECT = "(no project)";
const NO_CLIENT = "(no client)";
const MAX_LISTED = 500;

type Overlap = { row: ResolvedEntry; seconds: number };

function overlaps(rows: ResolvedEntry[], range: DateRange) {
	return rows.flatMap((row) => {
		const seconds = clippedSeconds(row.span, range);
		return seconds > 0 ? [{ row, seconds }] : [];
	});
}

function total(items: Overlap[]) {
	return items.reduce((sum, item) => sum + item.seconds, 0);
}

function groupSeconds(items: Overlap[], keys: (row: ResolvedEntry) => string[]) {
	const totals = new Map<string, number>();
	for (const item of items) {
		for (const key of keys(item.row)) {
			totals.set(key, (totals.get(key) ?? 0) + item.seconds);
		}
	}
	return totals;
}

function table(headers: string[], rows: (string | number)[][]) {
	const cell = (value: string | number) => String(value).replaceAll("|", "\\|").replaceAll(/\s*\n\s*/g, " ");
	return [
		`| ${headers.join(" | ")} |`,
		`|${headers.map(() => "---").join("|")}|`,
		...rows.map((row) => `| ${row.map(cell).join(" | ")} |`),
	].join("\n");
}

export async function listTimeEntries(startDate: string, endDate: string, now: Temporal.Instant) {
	const range = dayRange(startDate, endDate);
	const items = overlaps(await fetchEntries(range, now), range).sort((left, right) =>
		Temporal.Instant.compare(left.row.span.start, right.row.span.start),
	);
	return {
		timezone: ZONE,
		start_date: startDate,
		end_date: endDate,
		total_hours: hours(total(items)),
		count: items.length,
		truncated: items.length > MAX_LISTED || undefined,
		entries: items.slice(0, MAX_LISTED).map(({ row, seconds }) => {
			const wholeEntry = hours((row.span.stop.epochMilliseconds - row.span.start.epochMilliseconds) / 1000);
			return {
				id: row.entry.id,
				description: row.description,
				project: row.project,
				client: row.client,
				tags: row.tags,
				start: toLocal(row.span.start),
				stop: row.running ? null : toLocal(row.span.stop),
				running: row.running || undefined,
				hours: hours(seconds),
				hours_whole_entry: wholeEntry === hours(seconds) ? undefined : wholeEntry,
			};
		}),
	};
}

const Summary = z.object({
	groups: z.array(
		z.object({
			id: z.number().nullable(),
			sub_groups: z.array(
				z.object({ id: z.union([z.number(), z.string()]).nullable(), title: z.string().nullish(), seconds: z.number() }),
			),
		}),
	),
});

const reportsGrouping = {
	project: { grouping: "projects", subs: { entry: "time_entries", task: "tasks", user: "users" } },
	client: { grouping: "clients", subs: { entry: "time_entries", task: "tasks", project: "projects", user: "users" } },
} as const;

export type GroupBy = "project" | "client" | "tag";
export type SubGroupBy = "project" | "client" | "task" | "user" | "entry";

/** Project and client groupings use the Reports v3 summary. Tag is not a Reports v3 grouping, so it is totalled from the time entries. */
export async function summary(
	startDate: string,
	endDate: string,
	groupBy: GroupBy,
	subGroupBy: SubGroupBy | undefined,
	workspaceId: number | undefined,
	now: Temporal.Instant,
) {
	const range = dayRange(startDate, endDate);
	const me = await getMe();
	const warning =
		me.timezone === ZONE
			? undefined
			: `The Toggl profile timezone is ${me.timezone}, not ${ZONE}. Reports v3 probably reads whole days in the profile timezone, so project and client totals may shift at the range edges.`;

	if (groupBy === "tag") {
		if (subGroupBy === "task" || subGroupBy === "user") {
			throw new InputError(`group_by=tag supports sub_group_by of project, client or entry, not ${subGroupBy}`);
		}
		const items = overlaps(await fetchEntries(range, now), range);
		const keyOf = (row: ResolvedEntry) => (row.tags.length > 0 ? row.tags : [UNTAGGED]);
		const subKey = (row: ResolvedEntry) =>
			subGroupBy === "project" ? (row.project ?? NO_PROJECT) : subGroupBy === "client" ? (row.client ?? NO_CLIENT) : row.description;
		const groups = [...groupSeconds(items, keyOf)].sort((left, right) => right[1] - left[1]);
		return {
			source: "time_entries",
			note: "An entry with several tags counts toward each of them, so tag totals can add up to more than the grand total.",
			warning,
			grand_total_hours: hours(total(items)),
			groups: groups.map(([name, seconds]) => ({
				name,
				hours: hours(seconds),
				sub_groups: subGroupBy
					? [...groupSeconds(items.filter((item) => keyOf(item.row).includes(name)), (row) => [subKey(row)])]
							.sort((left, right) => right[1] - left[1])
							.map(([subName, subSeconds]) => ({ name: subName, hours: hours(subSeconds) }))
					: undefined,
			})),
		};
	}

	const config = reportsGrouping[groupBy];
	const subs: Record<string, string> = config.subs;
	const sub = subGroupBy ?? "user";
	if (!subs[sub]) {
		throw new InputError(`group_by=${groupBy} supports sub_group_by of ${Object.keys(subs).join(", ")}, not ${sub}`);
	}

	const workspace = await resolveWorkspace(workspaceId);
	const [report, projects, clients] = await Promise.all([
		toggl("POST", `/reports/api/v3/workspace/${workspace}/summary/time_entries`, {
			body: {
				start_date: startDate,
				end_date: endDate,
				grouping: config.grouping,
				sub_grouping: subs[sub],
				user_ids: [me.id],
			},
		}).then((json) => Summary.parse(json)),
		projectsWithClients(workspace),
		listClients(workspace),
	]);

	const names = new Map<string, string>(
		groupBy === "project"
			? projects.map((project) => [String(project.id), project.name])
			: clients.map((client) => [String(client.id), client.name]),
	);
	const subNames = new Map<string, string>(
		sub === "project" ? projects.map((project) => [String(project.id), project.name]) : [],
	);

	const groups = report.groups
		.map((group) => ({
			name: group.id === null ? (groupBy === "project" ? NO_PROJECT : NO_CLIENT) : (names.get(String(group.id)) ?? `id ${group.id}`),
			seconds: group.sub_groups.reduce((sum, item) => sum + item.seconds, 0),
			sub_groups: group.sub_groups,
		}))
		.sort((left, right) => right.seconds - left.seconds);

	return {
		source: "reports_v3",
		warning,
		grand_total_hours: hours(groups.reduce((sum, group) => sum + group.seconds, 0)),
		groups: groups.map((group) => ({
			name: group.name,
			hours: hours(group.seconds),
			sub_groups:
				sub === "user"
					? undefined
					: group.sub_groups.map((item) => ({
							name: item.title ?? (item.id === null ? "(none)" : (subNames.get(String(item.id)) ?? `id ${item.id}`)),
							hours: hours(item.seconds),
						})),
		})),
	};
}

function comparison(current: Map<string, number>, previous: Map<string, number>) {
	return [...new Set([...current.keys(), ...previous.keys()])]
		.map((name) => ({ name, now: current.get(name) ?? 0, before: previous.get(name) ?? 0 }))
		.sort((left, right) => right.now - left.now || right.before - left.before)
		.map(({ name, now, before }) => [name, hours(now), hours(before), signed(hours(now) - hours(before))]);
}

function signed(value: number) {
	const rounded = Math.round(value * 100) / 100;
	return rounded > 0 ? `+${rounded}` : String(rounded);
}

export async function weeklyReview(weekStart: string | undefined, now: Temporal.Instant) {
	const monday = weekStartFrom(weekStart, now);
	const previousMonday = monday.subtract({ days: 7 });
	const current = weekRange(monday);
	const previous = weekRange(previousMonday);

	const rows = await fetchEntries({ start: previous.start, end: current.end }, now);
	const thisWeek = overlaps(rows, current);
	const lastWeek = overlaps(rows, previous);

	const perDay = new Map<string, number>(Array.from({ length: 7 }, (_, offset) => [monday.add({ days: offset }).toString(), 0] as const));
	for (const { row } of thisWeek) {
		for (const [day, seconds] of secondsByDay(row.span, current)) {
			perDay.set(day, (perDay.get(day) ?? 0) + seconds);
		}
	}

	const projectKey = (row: ResolvedEntry) => [row.project ?? NO_PROJECT];
	const clientKey = (row: ResolvedEntry) => [row.client ?? NO_CLIENT];
	const tagKey = (row: ResolvedEntry) => (row.tags.length > 0 ? row.tags : [UNTAGGED]);
	const compare = (keys: (row: ResolvedEntry) => string[]) =>
		comparison(groupSeconds(thisWeek, keys), groupSeconds(lastWeek, keys));
	const headers = (label: string) => [label, "Hours", "Prev week", "Change"];

	const totalNow = hours(total(thisWeek));
	const totalBefore = hours(total(lastWeek));
	const topEntries = [...thisWeek]
		.sort((left, right) => right.seconds - left.seconds)
		.slice(0, 10)
		.map(({ row, seconds }) => [
			hours(seconds),
			row.description || "(no description)",
			row.project ?? NO_PROJECT,
			toLocal(row.span.start).slice(0, 10),
		]);

	const percent = totalBefore === 0 ? "n/a" : `${signed(Math.round(((totalNow - totalBefore) / totalBefore) * 1000) / 10)}%`;
	const running = thisWeek.some(({ row }) => row.running);

	return [
		`# Week ${monday.toString()} to ${monday.add({ days: 6 }).toString()} (${ZONE})`,
		`Total **${totalNow} h** vs ${totalBefore} h the week before (${signed(totalNow - totalBefore)} h, ${percent}).${running ? " A running timer is counted up to now." : ""}`,
		"## Per day",
		table(
			["Day", "Hours"],
			[...perDay].map(([day, seconds]) => [
				`${day} ${Temporal.PlainDate.from(day).toLocaleString("en-AU", { weekday: "short" })}`,
				hours(seconds),
			]),
		),
		"## By project",
		table(headers("Project"), compare(projectKey)),
		"## By client",
		table(headers("Client"), compare(clientKey)),
		"## By tag",
		table(headers("Tag"), compare(tagKey)),
		"Entries with several tags count toward each tag.",
		"## Top 10 entries",
		table(["Hours", "Description", "Project", "Date"], topEntries),
	].join("\n\n");
}
