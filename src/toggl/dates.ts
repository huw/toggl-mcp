import { Temporal } from "temporal-polyfill";

export const ZONE = "Australia/Sydney";

export type DateRange = { start: Temporal.ZonedDateTime; end: Temporal.ZonedDateTime };
export type Span = { start: Temporal.Instant; stop: Temporal.Instant };

export function parseDay(value: string) {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
		throw new InputError(`Expected a YYYY-MM-DD date, got "${value}"`);
	}
	return Temporal.PlainDate.from(value, { overflow: "reject" });
}

/** Both dates inclusive, as whole days in Australia/Sydney. `end` is the exclusive start of the day after. */
export function dayRange(startDate: string, endDate: string): DateRange {
	const first = parseDay(startDate);
	const last = parseDay(endDate);
	if (Temporal.PlainDate.compare(first, last) > 0) {
		throw new InputError("start_date is after end_date");
	}
	return {
		start: first.toZonedDateTime(ZONE),
		end: last.add({ days: 1 }).toZonedDateTime(ZONE),
	};
}

export function mondayOf(date: Temporal.PlainDate) {
	return date.subtract({ days: date.dayOfWeek - 1 });
}

/** The Monday of the previous full week. A Monday morning review therefore reads the week that just ended. */
export function lastWeekStart(now: Temporal.Instant) {
	return mondayOf(now.toZonedDateTimeISO(ZONE).toPlainDate()).subtract({ days: 7 });
}

export function weekStartFrom(weekStart: string | undefined, now: Temporal.Instant) {
	if (weekStart === undefined) {
		return lastWeekStart(now);
	}
	const date = parseDay(weekStart);
	if (date.dayOfWeek !== 1) {
		throw new InputError(`week_start must be a Monday, but ${weekStart} is a ${date.toLocaleString("en-AU", { weekday: "long" })}`);
	}
	return date;
}

export function weekRange(monday: Temporal.PlainDate) {
	return dayRange(monday.toString(), monday.add({ days: 6 }).toString());
}

export function hours(seconds: number) {
	return Math.round((seconds * 100) / 3600) / 100;
}

/** A running entry has a negative duration (minus its start epoch) and no stop; it runs until `now`. */
export function entrySpan(
	entry: { start: string; stop?: string | null; duration: number },
	now: Temporal.Instant,
): Span {
	const start = Temporal.Instant.from(entry.start);
	if (entry.duration < 0 || !entry.stop) {
		return { start, stop: entry.duration < 0 ? now : start.add({ seconds: entry.duration }) };
	}
	return { start, stop: Temporal.Instant.from(entry.stop) };
}

/** Seconds of `span` falling on each Sydney calendar day inside `range`, so an entry across midnight or a range edge is split. */
export function secondsByDay(span: Span, range: DateRange) {
	const from = Temporal.Instant.compare(span.start, range.start.toInstant()) > 0 ? span.start : range.start.toInstant();
	const to = Temporal.Instant.compare(span.stop, range.end.toInstant()) < 0 ? span.stop : range.end.toInstant();
	const days = new Map<string, number>();
	if (Temporal.Instant.compare(from, to) >= 0) {
		return days;
	}
	for (
		let day = from.toZonedDateTimeISO(ZONE).toPlainDate();
		day.toZonedDateTime(ZONE).toInstant().epochMilliseconds < to.epochMilliseconds;
		day = day.add({ days: 1 })
	) {
		const dayStart = day.toZonedDateTime(ZONE).toInstant().epochMilliseconds;
		const dayEnd = day.add({ days: 1 }).toZonedDateTime(ZONE).toInstant().epochMilliseconds;
		const overlapMs = Math.min(to.epochMilliseconds, dayEnd) - Math.max(from.epochMilliseconds, dayStart);
		if (overlapMs > 0) {
			days.set(day.toString(), Math.round(overlapMs / 1000));
		}
	}
	return days;
}

export function clippedSeconds(span: Span, range: DateRange) {
	return [...secondsByDay(span, range).values()].reduce((sum, seconds) => sum + seconds, 0);
}

export function toLocal(instant: Temporal.Instant) {
	return instant.toZonedDateTimeISO(ZONE).toString({ timeZoneName: "never" });
}

/** Bad tool input the caller can fix, returned as a tool error rather than thrown as a server fault. */
export class InputError extends Error {}

/** An ISO timestamp with an offset or Z is taken as is. Anything without one is a Sydney wall-clock time. */
export function parseMoment(value: string) {
	if (/(Z|[+-]\d{2}:?\d{2})$/i.test(value)) {
		return Temporal.Instant.from(value);
	}
	return Temporal.PlainDateTime.from(value).toZonedDateTime(ZONE).toInstant();
}
