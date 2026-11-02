import { Temporal } from "temporal-polyfill";
import { describe, expect, it } from "vitest";
import {
	clippedSeconds,
	dayRange,
	entrySpan,
	hours,
	lastWeekStart,
	secondsByDay,
	toLocal,
	weekRange,
	weekStartFrom,
	ZONE,
} from "../src/toggl/dates";

const sydney = (local: string) => Temporal.ZonedDateTime.from(`${local}[${ZONE}]`).toInstant();
const entry = (from: string, to: string) => ({
	start: sydney(from).toString(),
	stop: sydney(to).toString(),
	duration: sydney(to).epochMilliseconds / 1000 - sydney(from).epochMilliseconds / 1000,
});

describe("hours", () => {
	it("rounds to two decimals, half up", () => {
		expect(hours(3600)).toBe(1);
		expect(hours(5400)).toBe(1.5);
		expect(hours(1234)).toBe(0.34);
		expect(hours(18)).toBe(0.01);
		expect(hours(17)).toBe(0);
		expect(hours(0)).toBe(0);
	});
});

describe("dayRange", () => {
	it("covers whole Sydney days, inclusive of the end date", () => {
		const range = dayRange("2026-10-26", "2026-11-01");
		expect(range.start.toInstant().toString()).toBe("2026-10-25T13:00:00Z");
		expect(range.end.toInstant().toString()).toBe("2026-11-01T13:00:00Z");
	});

	it("is 23 hours long on the day daylight saving starts", () => {
		const { start, end } = dayRange("2026-10-04", "2026-10-04");
		expect(end.epochMilliseconds - start.epochMilliseconds).toBe(23 * 3600_000);
	});

	it("is 25 hours long on the day daylight saving ends", () => {
		const { start, end } = dayRange("2026-04-05", "2026-04-05");
		expect(end.epochMilliseconds - start.epochMilliseconds).toBe(25 * 3600_000);
	});

	it("rejects reversed and malformed ranges", () => {
		expect(() => dayRange("2026-11-02", "2026-11-01")).toThrow("after");
		expect(() => dayRange("2026-02-30", "2026-03-01")).toThrow();
		expect(() => dayRange("26-10-01", "2026-10-02")).toThrow("YYYY-MM-DD");
	});
});

describe("weeks", () => {
	it("defaults to the previous Monday to Sunday", () => {
		expect(lastWeekStart(sydney("2026-11-02T00:30:00")).toString()).toBe("2026-10-26");
		expect(lastWeekStart(sydney("2026-11-04T12:00:00")).toString()).toBe("2026-10-26");
	});

	it("still reads the previous full week on a Sunday", () => {
		expect(lastWeekStart(sydney("2026-11-01T23:30:00")).toString()).toBe("2026-10-19");
	});

	it("uses the Sydney date, not the UTC date", () => {
		expect(lastWeekStart(Temporal.Instant.from("2026-11-01T20:00:00Z")).toString()).toBe("2026-10-26");
	});

	it("only accepts a Monday", () => {
		expect(weekStartFrom("2026-10-26", sydney("2026-11-04T12:00:00")).toString()).toBe("2026-10-26");
		expect(() => weekStartFrom("2026-10-27", sydney("2026-11-04T12:00:00"))).toThrow("Monday");
	});

	it("spans seven days", () => {
		const { start, end } = weekRange(Temporal.PlainDate.from("2026-10-26"));
		expect(end.epochMilliseconds - start.epochMilliseconds).toBe(7 * 24 * 3600_000);
	});
});

describe("entrySpan", () => {
	const now = sydney("2026-11-02T10:00:00");

	it("runs a negative-duration entry until now", () => {
		const span = entrySpan({ start: sydney("2026-11-02T09:00:00").toString(), stop: null, duration: -1_780_000_000 }, now);
		expect(span.stop.toString()).toBe(now.toString());
	});

	it("falls back to start plus duration when stop is missing", () => {
		const span = entrySpan({ start: sydney("2026-11-02T09:00:00").toString(), stop: null, duration: 1800 }, now);
		expect(span.stop.toString()).toBe(sydney("2026-11-02T09:30:00").toString());
	});

	it("prefers the stop timestamp", () => {
		const e = entry("2026-11-02T08:00:00", "2026-11-02T09:00:00");
		expect(entrySpan(e, now).stop.toString()).toBe(sydney("2026-11-02T09:00:00").toString());
	});
});

describe("secondsByDay and clippedSeconds", () => {
	const week = dayRange("2026-10-26", "2026-11-01");
	const now = sydney("2026-11-03T00:00:00");

	it("splits an entry that crosses midnight", () => {
		const span = entrySpan(entry("2026-10-26T23:00:00", "2026-10-27T01:30:00"), now);
		expect([...secondsByDay(span, week)]).toEqual([
			["2026-10-26", 3600],
			["2026-10-27", 5400],
		]);
	});

	it("clips an entry that starts before the range", () => {
		const span = entrySpan(entry("2026-10-25T22:00:00", "2026-10-26T02:00:00"), now);
		expect(clippedSeconds(span, week)).toBe(2 * 3600);
	});

	it("clips an entry that ends after the range", () => {
		const span = entrySpan(entry("2026-11-01T22:00:00", "2026-11-02T03:00:00"), now);
		expect(clippedSeconds(span, week)).toBe(2 * 3600);
	});

	it("ignores an entry wholly outside the range", () => {
		const span = entrySpan(entry("2026-10-20T09:00:00", "2026-10-20T10:00:00"), now);
		expect(clippedSeconds(span, week)).toBe(0);
	});

	it("counts a running entry up to now", () => {
		const running = { start: sydney("2026-10-30T09:00:00").toString(), stop: null, duration: -1 };
		const span = entrySpan(running, sydney("2026-10-30T11:30:00"));
		expect(clippedSeconds(span, week)).toBe(2.5 * 3600);
	});

	it("counts elapsed time, not wall-clock time, across the daylight saving start", () => {
		const range = dayRange("2026-10-03", "2026-10-04");
		const span = entrySpan(entry("2026-10-03T23:00:00", "2026-10-04T04:00:00"), now);
		expect([...secondsByDay(span, range)]).toEqual([
			["2026-10-03", 3600],
			["2026-10-04", 3 * 3600],
		]);
	});

	it("counts elapsed time across the daylight saving end", () => {
		const range = dayRange("2026-04-04", "2026-04-05");
		const span = entrySpan(entry("2026-04-04T23:00:00", "2026-04-05T04:00:00"), now);
		expect(clippedSeconds(span, range)).toBe(6 * 3600);
	});
});

describe("toLocal", () => {
	it("renders an instant in Sydney with its offset", () => {
		expect(toLocal(Temporal.Instant.from("2026-10-25T13:00:00Z"))).toBe("2026-10-26T00:00:00+11:00");
	});
});
