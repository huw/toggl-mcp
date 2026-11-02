import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearCache } from "../src/toggl/client";
import { InputError } from "../src/toggl/dates";
import { listTimeEntries, summary, weeklyReview } from "../src/toggl/reports";
import { entry, json, me, mockFetch, sydney, togglApi } from "./helpers";

const now = sydney("2026-11-02T09:00:00");

// Week under review is Mon 2026-10-26 to Sun 2026-11-01. The Sunday-night entry straddles the week boundary.
const entries = [
	entry(1, "2026-10-26T09:00:00", "2026-10-26T12:00:00", { project_id: 10, description: "Grant draft | v2", tags: ["grants"] }),
	entry(2, "2026-10-27T23:00:00", "2026-10-28T01:00:00", { project_id: 11, description: "Late deploy" }),
	entry(3, "2026-10-28T14:00:00", "2026-10-28T15:30:00", { project_id: 10, description: "Funder calls", tags: ["grants", "calls"] }),
	entry(4, "2026-10-25T22:00:00", "2026-10-26T02:00:00", { project_id: 11, description: "Migration" }),
	entry(5, "2026-10-20T10:00:00", "2026-10-20T12:00:00", { project_id: 10, description: "Old grant work", tags: ["grants"] }),
];

beforeEach(() => {
	clearCache();
	vi.unstubAllGlobals();
});

describe("weeklyReview", () => {
	it("defaults to last Monday to Sunday and compares with the week before", async () => {
		const calls = mockFetch(togglApi(entries));
		const review = await weeklyReview(undefined, now);

		expect(review).toContain("# Week 2026-10-26 to 2026-11-01 (Australia/Sydney)");
		expect(review).toContain("Total **8.5 h** vs 4 h the week before (+4.5 h, +112.5%)");
		// The window opens a day early so an entry that began before the range is still fetched.
		const startDate = calls.find((call) => call.url.pathname === "/api/v9/me/time_entries")?.url.searchParams.get("start_date");
		expect(startDate).toBe(sydney("2026-10-18T00:00:00").toString());
	});

	it("splits entries across midnight and the week boundary per day", async () => {
		mockFetch(togglApi(entries));
		const review = await weeklyReview("2026-10-26", now);
		expect(review).toContain("| 2026-10-26 Mon | 5 |");
		expect(review).toContain("| 2026-10-27 Tue | 1 |");
		expect(review).toContain("| 2026-10-28 Wed | 2.5 |");
		expect(review).toContain("| 2026-11-01 Sun | 0 |");
	});

	it("reports project, client and tag hours with their change", async () => {
		mockFetch(togglApi(entries));
		const review = await weeklyReview("2026-10-26", now);
		expect(review).toContain("| Fundraising | 4.5 | 2 | +2.5 |");
		expect(review).toContain("| Ops | 4 | 2 | +2 |");
		expect(review).toContain("| Kaya | 4.5 | 2 | +2.5 |");
		expect(review).toContain("| (no client) | 4 | 2 | +2 |");
		expect(review).toContain("| grants | 4.5 | 2 | +2.5 |");
		expect(review).toContain("| calls | 1.5 | 0 | +1.5 |");
		expect(review).toContain("| (untagged) | 4 | 2 | +2 |");
	});

	it("lists the top entries by clipped duration and escapes table separators", async () => {
		mockFetch(togglApi(entries));
		const review = await weeklyReview("2026-10-26", now);
		const top = review.slice(review.indexOf("## Top 10 entries"));
		expect(top.indexOf("Grant draft \\| v2")).toBeLessThan(top.indexOf("Funder calls"));
		expect(top).toContain("| 2 | Migration | Ops | 2026-10-25 |");
	});

	it("counts a running timer up to now", async () => {
		mockFetch(togglApi([entry(9, "2026-11-01T20:00:00", null, { project_id: 10 })]));
		const review = await weeklyReview("2026-10-26", sydney("2026-11-01T22:30:00"));
		expect(review).toContain("Total **2.5 h**");
		expect(review).toContain("A running timer is counted up to now.");
	});

	it("rejects a week_start that is not a Monday", async () => {
		await expect(weeklyReview("2026-10-27", now)).rejects.toBeInstanceOf(InputError);
	});
});

describe("listTimeEntries", () => {
	it("resolves names, clips to the range and reports hours to two decimals", async () => {
		mockFetch(togglApi(entries));
		const result = await listTimeEntries("2026-10-26", "2026-10-26", now);
		expect(result.total_hours).toBe(5);
		expect(result.entries.map((row) => row.id)).toEqual([4, 1]);
		expect(result.entries[0]).toMatchObject({
			project: "Ops",
			client: null,
			start: "2026-10-25T22:00:00+11:00",
			hours: 2,
			hours_whole_entry: 4,
		});
		expect(result.entries[1]).toMatchObject({ project: "Fundraising", client: "Kaya", tags: ["grants"], hours: 3 });
	});
});

describe("summary", () => {
	it("groups by tag from time entries, counting a multi-tag entry toward each tag", async () => {
		mockFetch(togglApi(entries));
		const result = await summary("2026-10-26", "2026-11-01", "tag", "project", undefined, now);
		expect(result.source).toBe("time_entries");
		expect(result.grand_total_hours).toBe(8.5);
		expect(result.groups.map((group) => [group.name, group.hours])).toEqual([
			["grants", 4.5],
			["(untagged)", 4],
			["calls", 1.5],
		]);
		expect(result.groups[0]?.sub_groups).toEqual([{ name: "Fundraising", hours: 4.5 }]);
	});

	it("groups by project through the Reports v3 summary and resolves names", async () => {
		const calls = mockFetch((url, init) =>
			url.pathname === "/reports/api/v3/workspace/1/summary/time_entries"
				? json({
						groups: [
							{ id: 10, sub_groups: [{ id: 1, title: "Grant draft", seconds: 16200 }] },
							{ id: null, sub_groups: [{ id: 2, title: "Misc", seconds: 3600 }] },
						],
					})
				: togglApi(entries)(url),
		);
		const result = await summary("2026-10-26", "2026-11-01", "project", "entry", undefined, now);
		const report = calls.find((call) => call.url.pathname.startsWith("/reports/"));
		expect(JSON.parse(String(report?.init?.body))).toEqual({
			start_date: "2026-10-26",
			end_date: "2026-11-01",
			grouping: "projects",
			sub_grouping: "time_entries",
			user_ids: [me.id],
		});
		expect(result.source).toBe("reports_v3");
		expect(result.grand_total_hours).toBe(5.5);
		expect(result.groups).toEqual([
			{ name: "Fundraising", hours: 4.5, sub_groups: [{ name: "Grant draft", hours: 4.5 }] },
			{ name: "(no project)", hours: 1, sub_groups: [{ name: "Misc", hours: 1 }] },
		]);
	});

	it("warns when the Toggl profile timezone is not Sydney", async () => {
		mockFetch(togglApi(entries, { "/api/v9/me": { ...me, timezone: "Europe/London" } }));
		const result = await summary("2026-10-26", "2026-11-01", "tag", undefined, undefined, now);
		expect(result.warning).toContain("Europe/London");
	});

	it("rejects a sub-grouping the endpoint does not support", async () => {
		mockFetch(togglApi(entries));
		await expect(summary("2026-10-26", "2026-11-01", "project", "project", undefined, now)).rejects.toThrow("supports sub_group_by");
		await expect(summary("2026-10-26", "2026-11-01", "tag", "task", undefined, now)).rejects.toThrow("supports sub_group_by");
	});
});
