import { describe, expect, it } from 'vitest';
import { parseIcs } from '../src/ics.ts';
import { isIntervalEvent } from '../src/sources/types.ts';

describe('parseIcs', () => {
  it('distinguishes point events from interval events', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'X-WR-CALNAME:工作日历',
      'BEGIN:VEVENT',
      'UID:point-1',
      'SUMMARY:喝水提醒',
      'DTSTART;TZID=Asia/Shanghai:20261120T150000',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:interval-1',
      'SUMMARY:项目评审会\\,第一轮',
      'LOCATION:3号会议室',
      'DTSTART;TZID="China Standard Time":20261120T160000',
      'DURATION:PT1H30M',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:cancelled-1',
      'SUMMARY:已取消会议',
      'STATUS:CANCELLED',
      'DTSTART:20261120T080000Z',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');

    const windowStartMs = Date.parse('2026-11-20T00:00:00+08:00');
    const windowEndMs = Date.parse('2026-11-21T00:00:00+08:00');
    const events = parseIcs(ics, {
      windowStartMs,
      windowEndMs,
      defaultTimezone: 'Asia/Shanghai',
      source: 'ics',
    });

    expect(events).toHaveLength(2);
    const point = events.find((e) => e.uid === 'point-1')!;
    const interval = events.find((e) => e.uid === 'interval-1')!;

    expect(point.title).toBe('喝水提醒');
    expect(point.calendarName).toBe('工作日历');
    expect(point.startMs).toBe(Date.parse('2026-11-20T15:00:00+08:00'));
    expect(point.endMs).toBe(point.startMs);
    expect(isIntervalEvent(point)).toBe(false);

    expect(interval.title).toBe('项目评审会,第一轮');
    expect(interval.location).toBe('3号会议室');
    expect(interval.startMs).toBe(Date.parse('2026-11-20T16:00:00+08:00'));
    expect(interval.endMs).toBe(Date.parse('2026-11-20T17:30:00+08:00'));
    expect(isIntervalEvent(interval)).toBe(true);
  });

  it('expands RRULE and respects EXDATE', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:daily-standup',
      'SUMMARY:每日站会',
      'DTSTART;TZID=Asia/Shanghai:20261118T093000',
      'DTEND;TZID=Asia/Shanghai:20261118T094500',
      'RRULE:FREQ=DAILY;COUNT=5',
      'EXDATE;TZID=Asia/Shanghai:20261120T093000',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\n');

    const events = parseIcs(ics, {
      windowStartMs: Date.parse('2026-11-18T00:00:00+08:00'),
      windowEndMs: Date.parse('2026-11-23T00:00:00+08:00'),
      defaultTimezone: 'Asia/Shanghai',
      source: 'caldav',
    });

    // 5 days minus 1 EXDATE (Nov 20) = 4 occurrences
    expect(events).toHaveLength(4);
    expect(events.map((e) => e.startMs)).not.toContain(Date.parse('2026-11-20T09:30:00+08:00'));
  });

  it('handles RECURRENCE-ID rescheduling and all-day events without DTEND', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:rec-1',
      'SUMMARY:例会',
      'DTSTART;TZID=Asia/Shanghai:20261119T100000',
      'DTEND;TZID=Asia/Shanghai:20261119T110000',
      'RRULE:FREQ=DAILY;COUNT=2',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:rec-1',
      'SUMMARY:例会（改期）',
      'RECURRENCE-ID;TZID=Asia/Shanghai:20261120T100000',
      'DTSTART;TZID=Asia/Shanghai:20261120T150000',
      'DTEND;TZID=Asia/Shanghai:20261120T160000',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:allday-1',
      'SUMMARY:纪念日',
      'DTSTART;VALUE=DATE:20261120',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');

    const events = parseIcs(ics, {
      windowStartMs: Date.parse('2026-11-19T00:00:00+08:00'),
      windowEndMs: Date.parse('2026-11-22T00:00:00+08:00'),
      defaultTimezone: 'Asia/Shanghai',
      source: 'ics',
    });

    const recStarts = events.filter((e) => e.uid === 'rec-1').map((e) => e.startMs);
    expect(recStarts).toHaveLength(2);
    expect(recStarts).toContain(Date.parse('2026-11-19T10:00:00+08:00'));
    expect(recStarts).toContain(Date.parse('2026-11-20T15:00:00+08:00'));
    expect(recStarts).not.toContain(Date.parse('2026-11-20T10:00:00+08:00'));

    const allDay = events.find((e) => e.uid === 'allday-1')!;
    expect(allDay.allDay).toBe(true);
    expect(allDay.endMs - allDay.startMs).toBe(24 * 60 * 60_000);
    expect(isIntervalEvent(allDay)).toBe(true);

    // 跨夏令时回拨日（2026-11-01 America/New_York 为 25 小时）
    const dstIcs = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:allday-dst',
      'SUMMARY:DST All Day',
      'DTSTART;VALUE=DATE:20261101',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const dstEvents = parseIcs(dstIcs, {
      windowStartMs: Date.parse('2026-11-01T00:00:00Z'),
      windowEndMs: Date.parse('2026-11-03T00:00:00Z'),
      defaultTimezone: 'America/New_York',
      source: 'ics',
    });
    expect(dstEvents[0]!.endMs - dstEvents[0]!.startMs).toBe(25 * 60 * 60_000);

    // 重复全天事件跨越春季夏令时（2026-03-08 America/New_York 为 23 小时）
    const springDstIcs = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:allday-rec-dst',
      'SUMMARY:Recurring DST All Day',
      'DTSTART;VALUE=DATE:20260307',
      'RRULE:FREQ=DAILY;COUNT=2',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const springEvents = parseIcs(springDstIcs, {
      windowStartMs: Date.parse('2026-03-07T00:00:00Z'),
      windowEndMs: Date.parse('2026-03-10T00:00:00Z'),
      defaultTimezone: 'America/New_York',
      source: 'ics',
    }).sort((a, b) => a.startMs - b.startMs);
    expect(springEvents).toHaveLength(2);
    expect(springEvents[0]!.endMs - springEvents[0]!.startMs).toBe(24 * 60 * 60_000);
    expect(springEvents[1]!.endMs - springEvents[1]!.startMs).toBe(23 * 60 * 60_000);
  });
});
