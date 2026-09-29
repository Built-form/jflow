'use strict';

// Recurrence (CONTRACT §5): the natural dates of a schedule, its ends, `active_from`, the
// weekend rule and an instance's effective values. Pure: no DB, no clock. Every date is a
// 'YYYY-MM-DD' string and all arithmetic goes through lib/dates.js (epoch days).
//
// Occurrence n (0-based) is always computed FROM start_date, never chained from the
// previous occurrence (§5.1): monthly from 31 Jan is addMonthsClamped('…-01-31', n), so
// 31 Jan → 28 Feb → 31 Mar → 30 Apr. Natural dates strictly increase with n (each step is
// at least one week or one calendar month), which is what the index search relies on.
//
// A schedule is its row shape, snake_case (DB) or camelCase (JSON), read through the one
// normaliser `normalizeSchedule`. A malformed schedule throws; it is never guessed at.

const { addDays, addMonthsClamped, dayOfWeek, diffDays, isValidDate } = require('./dates');

const FREQUENCIES = ['weekly', 'fortnightly', 'four_weekly', 'monthly', 'quarterly', 'annually'];
const WEEKEND_RULES = ['none', 'previous', 'next'];

// §5.1: the step per interval_count, in days (week-based) or in months (month-based).
const STEP = {
    weekly: { days: 7 },
    fortnightly: { days: 14 },
    four_weekly: { days: 28 },
    monthly: { months: 1 },
    quarterly: { months: 3 },
    annually: { months: 12 },
};

/** `o[snake]` when present, else `o[camel]`; undefined when `o` is null or has neither. */
function field(o, snake, camel) {
    if (o == null) return undefined;
    return o[snake] !== undefined ? o[snake] : o[camel];
}

function optionalDate(value, name) {
    if (value == null) return null;
    if (!isValidDate(value)) {
        throw new TypeError(`Schedule ${name} must be a YYYY-MM-DD date, got ${JSON.stringify(value)}`);
    }
    return value;
}

function positiveInteger(value, name) {
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new TypeError(`Schedule ${name} must be an integer >= 1, got ${JSON.stringify(value)}`);
    }
    return value;
}

/**
 * A schedule row, snake_case or camelCase, as camelCase:
 * `{frequency, intervalCount, startDate, activeFrom, occurrenceCount, endDate, weekendRule,
 * settleMode, amount}`. `intervalCount` defaults to 1 and `weekendRule` to 'none'; absent
 * optional fields are null. Throws on an unknown frequency or weekend rule, a non-integer
 * or < 1 interval or count, or a date that is not a real calendar date.
 */
function normalizeSchedule(schedule) {
    if (schedule == null || typeof schedule !== 'object') throw new TypeError('Schedule must be an object');
    const { frequency } = schedule;
    if (!FREQUENCIES.includes(frequency)) {
        throw new TypeError(`Schedule frequency must be one of ${FREQUENCIES.join(', ')}, got ${JSON.stringify(frequency)}`);
    }
    const interval = field(schedule, 'interval_count', 'intervalCount');
    const count = field(schedule, 'occurrence_count', 'occurrenceCount');
    const startDate = optionalDate(field(schedule, 'start_date', 'startDate'), 'start_date');
    if (startDate === null) throw new TypeError('Schedule start_date is required');
    const weekendRule = field(schedule, 'weekend_rule', 'weekendRule') ?? 'none';
    if (!WEEKEND_RULES.includes(weekendRule)) {
        throw new TypeError(`Schedule weekend_rule must be one of ${WEEKEND_RULES.join(', ')}, got ${JSON.stringify(weekendRule)}`);
    }
    return {
        frequency,
        intervalCount: interval == null ? 1 : positiveInteger(interval, 'interval_count'),
        startDate,
        activeFrom: optionalDate(field(schedule, 'active_from', 'activeFrom'), 'active_from'),
        occurrenceCount: count == null ? null : positiveInteger(count, 'occurrence_count'),
        endDate: optionalDate(field(schedule, 'end_date', 'endDate'), 'end_date'),
        weekendRule,
        settleMode: field(schedule, 'settle_mode', 'settleMode') ?? null,
        amount: field(schedule, 'amount', 'amount') ?? null,
    };
}

/** The normalised schedule plus its step: `stepDays` (week-based) or `stepMonths` (month-based). */
function series(schedule) {
    const s = normalizeSchedule(schedule);
    const step = STEP[s.frequency];
    return {
        ...s,
        stepDays: step.days ? step.days * s.intervalCount : 0,
        stepMonths: step.months ? step.months * s.intervalCount : 0,
    };
}

/** §5.1: the natural date of occurrence n, from start_date. */
function naturalDate(s, n) {
    return s.stepDays
        ? addDays(s.startDate, s.stepDays * n)
        : addMonthsClamped(s.startDate, s.stepMonths * n);
}

/** The smallest n >= 0 whose natural date is >= `date` (ignoring ends and active_from). */
function firstIndexOnOrAfter(s, date) {
    const days = diffDays(date, s.startDate);
    if (days <= 0) return 0;
    if (s.stepDays) return Math.ceil(days / s.stepDays);
    // A month has at most 31 days, so occurrence n is at most 31 × stepMonths × n days
    // after start_date (clamping only moves it earlier): no n below this reaches `date`.
    let n = Math.floor(days / (31 * s.stepMonths));
    while (naturalDate(s, n) < date) n += 1;
    return n;
}

/** §5.2: occurrence n on `date` is within the schedule's end (count and/or end_date). */
function withinEnd(s, n, date) {
    return (s.occurrenceCount === null || n < s.occurrenceCount)
        && (s.endDate === null || date <= s.endDate);
}

/** The first natural date >= `date`, within the end, or null. */
function firstOnOrAfter(s, date) {
    const n = firstIndexOnOrAfter(s, date);
    const natural = naturalDate(s, n);
    return withinEnd(s, n, natural) ? natural : null;
}

/** COALESCE(active_from, start_date) raised to `date` when `date` is later. */
function activeFloor(s, date) {
    const floor = s.activeFrom ?? s.startDate;
    return date > floor ? date : floor;
}

function requireDate(value, name) {
    if (!isValidDate(value)) throw new TypeError(`${name} must be a YYYY-MM-DD date, got ${JSON.stringify(value)}`);
}

/**
 * Natural dates with from <= natural <= to, ascending, honouring the end and active_from
 * (dates < active_from belong to the predecessor); [] when to < start_date.
 */
function occurrences(schedule, from, to) {
    const s = series(schedule);
    requireDate(from, 'from');
    requireDate(to, 'to');
    const out = [];
    const lo = activeFloor(s, from);
    if (to < lo) return out;
    for (let n = firstIndexOnOrAfter(s, lo); ; n += 1) {
        const date = naturalDate(s, n);
        if (date > to || !withinEnd(s, n, date)) break;
        out.push(date);
    }
    return out;
}

/**
 * The n of `date` counted from start_date, or -1 when `date` is not an occurrence: off the
 * grid, before start_date or active_from, past end_date or beyond occurrence_count, or not
 * a real 'YYYY-MM-DD' date.
 */
function occurrenceIndex(schedule, date) {
    const s = series(schedule);
    if (!isValidDate(date) || date < s.startDate) return -1;
    if (s.activeFrom !== null && date < s.activeFrom) return -1;
    const n = firstIndexOnOrAfter(s, date);
    return naturalDate(s, n) === date && withinEnd(s, n, date) ? n : -1;
}

/** True iff `date` is an occurrence's natural date (§5.4: end and active_from included). */
function isOccurrence(schedule, date) {
    return occurrenceIndex(schedule, date) >= 0;
}

/** The first natural date >= COALESCE(active_from, start_date), or null when the end leaves none. */
function firstActiveOccurrence(schedule) {
    const s = series(schedule);
    return firstOnOrAfter(s, activeFloor(s, s.startDate));
}

/** The first natural date > `date` and >= active_from, or null when the series has ended. */
function nextOccurrenceAfter(schedule, date) {
    const s = series(schedule);
    return firstOnOrAfter(s, activeFloor(s, addDays(date, 1)));
}

/**
 * What split and end write on the old row, and what a split offers the successor (D21,
 * D22). `k` must be an occurrence (the routes refuse anything else first; a stray call
 * throws rather than write a wrong count).
 *
 * keepSeries (frequency, interval, start and weekend rule untouched): the successor keeps
 * start_date and starts at active_from = k; n still counts from start_date, so the count
 * inherits verbatim. Otherwise the successor starts at k with the occurrences before k
 * taken off the count.
 */
function endBefore(schedule, k, { keepSeries = false } = {}) {
    const s = normalizeSchedule(schedule);
    const n = occurrenceIndex(schedule, k);
    if (n < 0) throw new RangeError(`endBefore: ${JSON.stringify(k)} is not an occurrence of the schedule`);
    const successor = keepSeries
        ? { startDate: s.startDate, activeFrom: k, occurrenceCount: s.occurrenceCount, endDate: s.endDate }
        : {
            startDate: k,
            activeFrom: null,
            occurrenceCount: s.occurrenceCount === null ? null : s.occurrenceCount - n,
            endDate: s.endDate,
        };
    return { endDate: addDays(k, -1), occurrenceCount: null, successor };
}

/**
 * §5.3: none → date; previous → Saturday/Sunday to Friday; next → Saturday/Sunday to
 * Monday; weekdays unchanged.
 */
function weekendAdjust(date, rule) {
    if (!WEEKEND_RULES.includes(rule)) {
        throw new TypeError(`Weekend rule must be one of ${WEEKEND_RULES.join(', ')}, got ${JSON.stringify(rule)}`);
    }
    const dow = dayOfWeek(date); // ISO: Saturday 6, Sunday 7
    if (rule === 'none' || dow < 6) return date;
    if (rule === 'previous') return addDays(date, dow === 6 ? -1 : -2);
    return addDays(date, dow === 6 ? 2 : 1);
}

/**
 * §5.3 / §3.4, the one definition: an override's due_date verbatim when set (a person chose
 * it, so the weekend rule is bypassed), else the weekend-adjusted natural date. `override`
 * is the override row (snake_case or camelCase) or null.
 */
function effectiveDate(schedule, natural, override = null) {
    const due = field(override, 'due_date', 'dueDate');
    if (due != null) {
        requireDate(due, 'Override due_date');
        return due;
    }
    return weekendAdjust(natural, normalizeSchedule(schedule).weekendRule);
}

/**
 * §3.4: an instance's effective values. amount = override.amount ?? schedule.amount (DECIMAL
 * strings, untouched); status = override.status ?? 'expected'; settleMode =
 * override.settle_mode ?? schedule.settle_mode. It does not check `isOccurrence`: orphan
 * detection (§5.5) is the caller's.
 */
function effectiveValues(schedule, natural, override = null) {
    const s = normalizeSchedule(schedule);
    return {
        naturalDate: natural,
        effectiveDate: effectiveDate(s, natural, override),
        amount: field(override, 'amount', 'amount') ?? s.amount,
        status: field(override, 'status', 'status') ?? 'expected',
        settleMode: field(override, 'settle_mode', 'settleMode') ?? s.settleMode,
    };
}

module.exports = {
    FREQUENCIES,
    WEEKEND_RULES,
    normalizeSchedule,
    occurrences,
    isOccurrence,
    occurrenceIndex,
    firstActiveOccurrence,
    nextOccurrenceAfter,
    endBefore,
    weekendAdjust,
    effectiveDate,
    effectiveValues,
};
