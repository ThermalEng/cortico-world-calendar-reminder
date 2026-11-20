import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorldHost } from 'cortico/core/types.ts';
import { afterEach, describe, expect, it } from 'vitest';
import { CALENDAR_REMINDER_DEFAULTS, type CalendarReminderConfigSection } from '../src/config.ts';
import { normalizeCaldavUrl, syncCaldavAndSubscriptions, writeCaldavEvent } from '../src/sources/caldav.ts';
import { syncSystemCalendars, writeSystemCalendarEvent } from '../src/sources/system.ts';
import { CalendarReminderWorld } from '../src/world.ts';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('CalendarReminderWorld & sources', () => {
  it('respects syncIntervalMinutes and pushes due/ended events', async () => {
    const dataDir = makeTempDir('cal-world-');
    let nowMs = Date.parse('2026-11-20T14:00:00+08:00');
    let syncCalls = 0;

    const cfg: CalendarReminderConfigSection = {
      ...CALENDAR_REMINDER_DEFAULTS,
      enabled: true,
      intervalMode: 'every_15m',
      notifyOnEnd: true,
      syncIntervalMinutes: 5,
    };

    const pushed: Array<{ type: string; text: string }> = [];
    const host = {
      pushEvent: async (ev: { type: string; text: string }) => {
        pushed.push({ type: ev.type, text: ev.text });
      },
      log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    } as unknown as WorldHost;

    const world = new CalendarReminderWorld({
      cfg,
      timezone: 'Asia/Shanghai',
      dataDir,
      now: () => nowMs,
      syncSources: async () => {
        syncCalls++;
        return {
          events: [
            {
              key: 'system:meeting:1',
              uid: 'meeting',
              calendarId: 'system:default',
              title: '下午例会',
              source: 'system',
              startMs: Date.parse('2026-11-20T14:10:00+08:00'),
              endMs: Date.parse('2026-11-20T14:40:00+08:00'),
              allDay: false,
            },
          ],
          calendars: [{ id: 'system:default', name: '默认日历', source: 'system', count: 1 }],
          reports: [{ source: 'mock', count: 1 }],
        };
      },
    });

    await world.start(host);
    expect(syncCalls).toBe(1);
    expect(pushed.some((p) => p.type === 'calendar.ready')).toBe(true);

    // 2 minutes later: < 5m syncIntervalMinutes, should NOT re-sync
    nowMs += 2 * 60_000;
    await world.tick();
    expect(syncCalls).toBe(1);

    // 14:10 -> event starts -> calendar.due + re-sync (>= 5m elapsed)
    nowMs = Date.parse('2026-11-20T14:10:00+08:00');
    await world.tick();
    expect(syncCalls).toBe(2);
    expect(pushed.some((p) => p.type === 'calendar.due' && p.text.includes('下午例会'))).toBe(true);

    // 14:40 -> event ends -> calendar.ended
    nowMs = Date.parse('2026-11-20T14:40:00+08:00');
    await world.tick();
    expect(pushed.some((p) => p.type === 'calendar.ended' && p.text.includes('时间到了'))).toBe(true);

    // Tools work
    const listText = await world.tools().find((t) => t.name === 'calendar_list')!.handler({}, {} as never);
    expect(listText).toContain('下午例会');

    // Toggle calendar off via WebUI panel invoke
    const uiState = await world.webUi().invoke!('calendars', 'toggle', ['system:default', false]) as {
      calendars: Array<{ id: string; enabled: boolean }>;
    };
    expect(uiState.calendars[0]!.enabled).toBe(false);
    const mutedList = await world.tools().find((t) => t.name === 'calendar_list')!.handler({}, {} as never);
    expect(mutedList).toContain('没有待提醒日程');

    await world.stop();
  });

  it('syncs Linux local .ics directories and CalDAV REPORT XML', async () => {
    const icsDir = makeTempDir('cal-ics-');
    writeFileSync(
      join(icsDir, 'test.ics'),
      [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'BEGIN:VEVENT',
        'UID:local-1',
        'SUMMARY:本地日历测试',
        'DTSTART;TZID=Asia/Shanghai:20261120T180000',
        'END:VEVENT',
        'END:VCALENDAR',
      ].join('\r\n'),
      'utf8',
    );

    const windowStartMs = Date.parse('2026-11-20T00:00:00+08:00');
    const windowEndMs = Date.parse('2026-11-21T00:00:00+08:00');

    const sysRes = await syncSystemCalendars({
      systemCalendarEnabled: false,
      localIcsPaths: icsDir,
      windowStartMs,
      windowEndMs,
      defaultTimezone: 'Asia/Shanghai',
      platform: 'linux',
    });
    expect(sysRes.events).toHaveLength(1);
    expect(sysRes.events[0]!.title).toBe('本地日历测试');

    const mockFetch: typeof fetch = async (_input, init) => {
      if (init?.method === 'REPORT') {
        const reqBody = String(init.body ?? '');
        if (reqBody.includes('calendar-multiget')) {
          const xml = `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:response>
    <D:propstat>
      <D:prop>
        <C:calendar-data>BEGIN:VCALENDAR&#xD;&#xA;VERSION:2.0&#xD;&#xA;BEGIN:VEVENT&#xD;&#xA;UID:caldav-1&#xD;&#xA;SUMMARY:CalDAV 同步测试&#xD;&#xA;DTSTART:20261120T100000Z&#xD;&#xA;DTEND:20261120T110000Z&#xD;&#xA;END:VEVENT&#xD;&#xA;END:VCALENDAR</C:calendar-data>
      </D:prop>
    </D:propstat>
  </D:response>
</D:multistatus>`;
          return new Response(xml, { status: 207, headers: { 'Content-Type': 'application/xml' } });
        }
        const queryXml = `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:response>
    <D:href>/dav/user/work/event-1.ics</D:href>
    <D:propstat><D:prop><D:getetag>123</D:getetag></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
  </D:response>
</D:multistatus>`;
        return new Response(queryXml, { status: 207, headers: { 'Content-Type': 'application/xml' } });
      }
      return new Response('', { status: 404 });
    };

    const caldavRes = await syncCaldavAndSubscriptions({
      urlsRaw: 'cal.example.com/dav/user/work/',
      username: 'alice',
      password: 'secret',
      windowStartMs,
      windowEndMs,
      defaultTimezone: 'Asia/Shanghai',
      fetchImpl: mockFetch,
    });
    expect(caldavRes.events).toHaveLength(1);
    expect(caldavRes.events[0]!.title).toBe('CalDAV 同步测试');

    expect(normalizeCaldavUrl('caldav.feishu.cn')).toBe('https://caldav.feishu.cn');
    expect(normalizeCaldavUrl('webcal://example.com/a.ics')).toBe('https://example.com/a.ics');
    expect(normalizeCaldavUrl('webcals://example.com/a.ics')).toBe('https://example.com/a.ics');
    expect(normalizeCaldavUrl('caldav://caldav.feishu.cn')).toBe('https://caldav.feishu.cn');
    expect(normalizeCaldavUrl('caldavs://caldav.feishu.cn')).toBe('https://caldav.feishu.cn');
    expect(normalizeCaldavUrl('webdav://cal.example.com/calendar')).toBe('https://cal.example.com/calendar');
    expect(normalizeCaldavUrl('webdavs://cal.example.com/calendar')).toBe('https://cal.example.com/calendar');
    expect(normalizeCaldavUrl('dav://cal.example.com/dav')).toBe('https://cal.example.com/dav');
    expect(normalizeCaldavUrl('http://localhost:5232/cal/')).toBe('http://localhost:5232/cal/');
  });

  it('supports toggleWrite and calendar_add to writable calendars', async () => {
    const dataDir = makeTempDir('cal-write-');
    const icsFile = join(dataDir, 'local.ics');
    writeFileSync(icsFile, 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n', 'utf8');

    const cfg: CalendarReminderConfigSection = {
      ...CALENDAR_REMINDER_DEFAULTS,
      enabled: true,
      localIcsPaths: icsFile,
    };

    const written: Array<{ calId: string; title: string }> = [];
    const host = {
      pushEvent: async () => {},
      log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    } as unknown as WorldHost;

    const world = new CalendarReminderWorld({
      cfg,
      timezone: 'Asia/Shanghai',
      dataDir,
      now: () => Date.parse('2026-11-20T16:00:00+08:00'),
      syncSources: async () => ({
        events: [],
        calendars: [{ id: 'caldav:https://cal.example.com/work/', name: '工作日历', source: 'caldav', count: 0, writable: true }],
        reports: [],
      }),
      writeEvent: async (calId, ev) => {
        written.push({ calId, title: ev.title });
      },
    });

    await world.start(host);
    const addTool = world.tools().find((t) => t.name === 'calendar_add')!;

    // No writable calendar selected yet
    const blocked = await addTool.handler({ title: '测试日程', start: '2026-11-21T10:00:00+08:00' }, {} as never);
    expect(blocked).toContain('尚未勾选任何可写入的目标日历');

    // Enable write via toggleWrite
    const state = await world.webUi().invoke!('calendars', 'toggleWrite', ['caldav:https://cal.example.com/work/', true]) as {
      calendars: Array<{ allowWrite: boolean }>;
    };
    expect(state.calendars[0]!.allowWrite).toBe(true);

    const okRes = await addTool.handler({
      title: '项目周会',
      start: '2026-11-21T10:00:00+08:00',
      end: '2026-11-21T11:00:00+08:00',
    }, {} as never);
    expect(okRes).toContain('已写入日历（工作日历）');
    expect(written).toEqual([{ calId: 'caldav:https://cal.example.com/work/', title: '项目周会' }]);

    // Test writeSystemCalendarEvent on Linux local .ics file
    await writeSystemCalendarEvent({
      calendarId: 'system:本地',
      localIcsPaths: icsFile,
      platform: 'linux',
      event: {
        uid: 'u-local-write',
        title: '本地写入测试',
        startMs: Date.parse('2026-11-21T14:00:00+08:00'),
        endMs: Date.parse('2026-11-21T15:00:00+08:00'),
        timezone: 'Asia/Shanghai',
      },
    });
    const sysRead = await syncSystemCalendars({
      systemCalendarEnabled: false,
      localIcsPaths: icsFile,
      windowStartMs: Date.parse('2026-11-21T00:00:00+08:00'),
      windowEndMs: Date.parse('2026-11-22T00:00:00+08:00'),
      defaultTimezone: 'Asia/Shanghai',
      platform: 'linux',
    });
    expect(sysRead.events.some((e) => e.title === '本地写入测试')).toBe(true);

    // Test writeCaldavEvent PUT
    let putMethod = '';
    let putBody = '';
    await writeCaldavEvent({
      calendarId: 'caldav:https://cal.example.com/work/',
      username: 'u',
      password: 'p',
      event: {
        uid: 'u-dav-1',
        title: 'DAV 写入',
        startMs: Date.parse('2026-11-21T16:00:00+08:00'),
        endMs: Date.parse('2026-11-21T16:00:00+08:00'),
        timezone: 'Asia/Shanghai',
      },
      fetchImpl: async (_url, init) => {
        putMethod = init?.method ?? '';
        putBody = String(init?.body ?? '');
        return new Response('', { status: 201 });
      },
    });
    expect(putMethod).toBe('PUT');
    expect(putBody).toContain('SUMMARY:DAV 写入');

    await world.stop();
  });
});
