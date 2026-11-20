import { describe, expect, it } from 'vitest';
import type { CalendarEvent } from '../src/sources/types.ts';
import { ackEvent, applyNotifications, evaluateDueNotifications, type CalendarStoreFile } from '../src/store.ts';

function makeStore(events: CalendarEvent[]): CalendarStoreFile {
  return { version: 1, calendars: [], events, states: {} };
}

describe('store reminder evaluation', () => {
  const t0 = Date.parse('2026-11-20T10:00:00+08:00');

  it('reminds point event only once', () => {
    const point: CalendarEvent = {
      key: 'system:p1:' + t0,
      uid: 'p1',
      calendarId: 'system:default',
      title: '吃药',
      source: 'system',
      startMs: t0,
      endMs: t0,
      allDay: false,
    };
    const store = makeStore([point]);

    const first = evaluateDueNotifications(store, t0 + 10_000, { intervalMode: 'every_15m', notifyOnEnd: true });
    expect(first).toHaveLength(1);
    expect(first[0]!.kind).toBe('point');

    applyNotifications(store, first, t0 + 10_000);

    const second = evaluateDueNotifications(store, t0 + 20 * 60_000, { intervalMode: 'every_15m', notifyOnEnd: true });
    expect(second).toHaveLength(0);
  });

  it('reminds interval event every 15 minutes and on end when enabled', () => {
    const interval: CalendarEvent = {
      key: 'caldav:i1:' + t0,
      uid: 'i1',
      calendarId: 'caldav:work',
      title: '专注编码',
      source: 'caldav',
      startMs: t0,
      endMs: t0 + 40 * 60_000, // 40 分钟区间
      allDay: false,
    };
    const store = makeStore([interval]);

    // 10:00 -> start
    const n1 = evaluateDueNotifications(store, t0, { intervalMode: 'every_15m', notifyOnEnd: true });
    expect(n1.map((n) => n.kind)).toEqual(['interval_start']);
    applyNotifications(store, n1, t0);

    // 10:10 -> not yet 15m
    expect(evaluateDueNotifications(store, t0 + 10 * 60_000, { intervalMode: 'every_15m', notifyOnEnd: true })).toHaveLength(0);

    // 10:15 -> repeat #2
    const n2 = evaluateDueNotifications(store, t0 + 15 * 60_000, { intervalMode: 'every_15m', notifyOnEnd: true });
    expect(n2.map((n) => n.kind)).toEqual(['interval_repeat']);
    expect(n2[0]!.firedCount).toBe(2);
    applyNotifications(store, n2, t0 + 15 * 60_000);

    // 10:40 -> end reached
    const nEnd = evaluateDueNotifications(store, t0 + 40 * 60_000, { intervalMode: 'every_15m', notifyOnEnd: true });
    expect(nEnd.map((n) => n.kind)).toEqual(['interval_end']);
    applyNotifications(store, nEnd, t0 + 40 * 60_000);

    // 10:41 -> end already notified
    expect(evaluateDueNotifications(store, t0 + 41 * 60_000, { intervalMode: 'every_15m', notifyOnEnd: true })).toHaveLength(0);
  });

  it('supports once, hourly, daily modes and ackEvent', () => {
    const interval: CalendarEvent = {
      key: 'system:i2:' + t0,
      uid: 'i2',
      calendarId: 'system:default',
      title: '出差',
      source: 'system',
      startMs: t0,
      endMs: t0 + 48 * 60 * 60_000, // 2 天
      allDay: false,
    };
    const store = makeStore([interval]);

    // once: fires once at start, never repeats
    const n1 = evaluateDueNotifications(store, t0, { intervalMode: 'once', notifyOnEnd: false });
    expect(n1).toHaveLength(1);
    applyNotifications(store, n1, t0);
    expect(evaluateDueNotifications(store, t0 + 25 * 60 * 60_000, { intervalMode: 'once', notifyOnEnd: false })).toHaveLength(0);

    // switch mode hot to hourly: fires at +1h
    const nHourly = evaluateDueNotifications(store, t0 + 60 * 60_000, { intervalMode: 'hourly', notifyOnEnd: false });
    expect(nHourly).toHaveLength(1);
    expect(nHourly[0]!.kind).toBe('interval_repeat');
    applyNotifications(store, nHourly, t0 + 60 * 60_000);

    // daily: +2h is not enough, +25h triggers
    expect(evaluateDueNotifications(store, t0 + 2 * 60 * 60_000, { intervalMode: 'daily', notifyOnEnd: false })).toHaveLength(0);
    const nDaily = evaluateDueNotifications(store, t0 + 25 * 60 * 60_000, { intervalMode: 'daily', notifyOnEnd: false });
    expect(nDaily).toHaveLength(1);

    // ack stops further interval repeats
    expect(ackEvent(store, '出差')?.uid).toBe('i2');
    expect(evaluateDueNotifications(store, t0 + 26 * 60 * 60_000, { intervalMode: 'hourly', notifyOnEnd: false })).toHaveLength(0);
  });
});
