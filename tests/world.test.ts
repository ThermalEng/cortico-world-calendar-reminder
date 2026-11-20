import { chmodSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
      caldavUrl: 'https://cal.example.com/work/',
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

    // Switching caldavUsername (same URL) must also reject writing to old account's cached calendar ID
    cfg.caldavUsername = 'bob';
    const switchedUserRes = await addTool.handler({
      title: '不应写到旧账号',
      start: '2026-11-21T13:00:00+08:00',
    }, {} as never);
    expect(switchedUserRes).toContain('CalDAV 配置或账号已变更');

    // Switching caldavUrl must reject writing to old server's cached calendar ID
    cfg.caldavUsername = '';
    cfg.caldavUrl = 'https://new-cal.example.com/new/';
    const switchedRes = await addTool.handler({
      title: '不应写到旧服务器',
      start: '2026-11-21T12:00:00+08:00',
    }, {} as never);
    expect(switchedRes).toContain('CalDAV 配置或账号已变更');

    // Test writeSystemCalendarEvent on Linux targets exact selected file & serializes concurrent writes
    const icsFile2 = join(dataDir, 'second.ics');
    writeFileSync(icsFile2, 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n', 'utf8');
    const discoveredEmpty = await syncSystemCalendars({
      systemCalendarEnabled: false,
      localIcsPaths: `${icsFile}\n${icsFile2}`,
      windowStartMs: Date.parse('2026-11-21T00:00:00+08:00'),
      windowEndMs: Date.parse('2026-11-22T00:00:00+08:00'),
      defaultTimezone: 'Asia/Shanghai',
      platform: 'linux',
    });
    expect(discoveredEmpty.calendars.map((c) => c.id)).toContain(`system:file:${icsFile2}`);

    await Promise.all([
      writeSystemCalendarEvent({
        calendarId: `system:file:${icsFile2}`,
        platform: 'linux',
        event: {
          uid: 'u-local-write-1',
          title: '并发写入A',
          startMs: Date.parse('2026-11-21T14:00:00+08:00'),
          endMs: Date.parse('2026-11-21T15:00:00+08:00'),
          timezone: 'Asia/Shanghai',
        },
      }),
      writeSystemCalendarEvent({
        calendarId: `system:file:${icsFile2}`,
        platform: 'linux',
        event: {
          uid: 'u-local-write-2',
          title: '并发写入B',
          startMs: Date.parse('2026-11-21T16:00:00+08:00'),
          endMs: Date.parse('2026-11-21T17:00:00+08:00'),
          timezone: 'Asia/Shanghai',
        },
      }),
    ]);

    const sysRead1 = await syncSystemCalendars({
      systemCalendarEnabled: false,
      localIcsPaths: icsFile,
      windowStartMs: Date.parse('2026-11-21T00:00:00+08:00'),
      windowEndMs: Date.parse('2026-11-22T00:00:00+08:00'),
      defaultTimezone: 'Asia/Shanghai',
      platform: 'linux',
    });
    expect(sysRead1.events).toHaveLength(0);

    const sysRead2 = await syncSystemCalendars({
      systemCalendarEnabled: false,
      localIcsPaths: icsFile2,
      windowStartMs: Date.parse('2026-11-21T00:00:00+08:00'),
      windowEndMs: Date.parse('2026-11-22T00:00:00+08:00'),
      defaultTimezone: 'Asia/Shanghai',
      platform: 'linux',
    });
    expect(sysRead2.events.map((e) => e.title).sort()).toEqual(['并发写入A', '并发写入B']);

    await expect(writeSystemCalendarEvent({
      calendarId: 'system:file:/nonexistent/path.ics',
      platform: 'linux',
      event: {
        uid: 'u-bad',
        title: '不存在',
        startMs: Date.parse('2026-11-21T10:00:00+08:00'),
        endMs: Date.parse('2026-11-21T10:00:00+08:00'),
        timezone: 'Asia/Shanghai',
      },
    })).rejects.toThrow();

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

  it('preserves cache on sync error and retries failed due pushes per item', async () => {
    const dataDir = makeTempDir('cal-retry-');
    let nowMs = Date.parse('2026-11-20T14:00:00+08:00');
    let failSync = false;
    let failFirstDue = true;
    const pushedTitles: string[] = [];

    const cfg: CalendarReminderConfigSection = {
      ...CALENDAR_REMINDER_DEFAULTS,
      enabled: true,
    };

    const host = {
      pushEvent: async (ev: { type: string; text: string }) => {
        if (ev.type === 'calendar.due' && ev.text.includes('日程A') && failFirstDue) {
          failFirstDue = false;
          throw new Error('transient push error');
        }
        if (ev.type === 'calendar.due') pushedTitles.push(ev.text);
      },
      log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    } as unknown as WorldHost;

    const world = new CalendarReminderWorld({
      cfg,
      timezone: 'Asia/Shanghai',
      dataDir,
      now: () => nowMs,
      syncSources: async () => {
        if (failSync) {
          return { events: [], reports: [{ source: 'mock', count: 0, error: 'network down' }] };
        }
        return {
          events: [
            {
              key: 'system:a:1',
              uid: 'a',
              calendarId: 'system:mock',
              title: '日程A',
              source: 'system',
              startMs: Date.parse('2026-11-20T14:05:00+08:00'),
              endMs: Date.parse('2026-11-20T14:05:00+08:00'),
              allDay: false,
            },
            {
              key: 'system:b:1',
              uid: 'b',
              calendarId: 'system:mock',
              title: '日程B',
              source: 'system',
              startMs: Date.parse('2026-11-20T14:05:00+08:00'),
              endMs: Date.parse('2026-11-20T14:05:00+08:00'),
              allDay: false,
            },
          ],
          calendars: [{ id: 'system:mock', name: 'Mock', source: 'system', count: 2, writable: true }],
          reports: [{ source: 'mock', count: 2 }],
        };
      },
    });

    await world.start(host);

    // Sync fails -> cached events must be preserved
    failSync = true;
    await world.syncNow();
    const listText = await world.tools().find((t) => t.name === 'calendar_list')!.handler({}, {} as never);
    expect(listText).toContain('日程A');
    expect(listText).toContain('日程B');

    // First due push for A fails -> B must still be delivered, and A retried on next check
    nowMs = Date.parse('2026-11-20T14:05:00+08:00');
    await world.checkAndPushDue();
    expect(pushedTitles.some((t) => t.includes('日程B'))).toBe(true);
    expect(pushedTitles.some((t) => t.includes('日程A'))).toBe(false);

    await world.checkAndPushDue();
    expect(pushedTitles.filter((t) => t.includes('日程A'))).toHaveLength(1);
    expect(pushedTitles.filter((t) => t.includes('日程B'))).toHaveLength(1);

    await world.stop();

    // Empty CalDAV collection returns 207 without error
    const emptyCal = await syncCaldavAndSubscriptions({
      urlsRaw: 'https://cal.example.com/empty/',
      username: '',
      password: '',
      windowStartMs: Date.parse('2026-11-20T00:00:00+08:00'),
      windowEndMs: Date.parse('2026-11-21T00:00:00+08:00'),
      defaultTimezone: 'Asia/Shanghai',
      fetchImpl: async (_url, init) => {
        if (init?.method === 'REPORT') {
          return new Response('<?xml version="1.0"?><D:multistatus xmlns:D="DAV:"/>', { status: 207 });
        }
        return new Response('', { status: 404 });
      },
    });
    expect(emptyCal.reports[0]?.error).toBeUndefined();
    expect(emptyCal.calendars).toHaveLength(1);

    // CalDAV multiget 503 must report error (not treat as empty)
    const multigetFail = await syncCaldavAndSubscriptions({
      urlsRaw: 'https://cal.example.com/work/',
      username: '',
      password: '',
      windowStartMs: Date.parse('2026-11-20T00:00:00+08:00'),
      windowEndMs: Date.parse('2026-11-21T00:00:00+08:00'),
      defaultTimezone: 'Asia/Shanghai',
      fetchImpl: async (_url, init) => {
        const body = String(init?.body ?? '');
        if (init?.method === 'REPORT' && body.includes('calendar-multiget')) {
          return new Response('Service Unavailable', { status: 503 });
        }
        if (init?.method === 'REPORT') {
          return new Response('<D:multistatus xmlns:D="DAV:"><D:response><D:href>/work/1.ics</D:href></D:response></D:multistatus>', { status: 207 });
        }
        return new Response('', { status: 404 });
      },
    });
    expect(multigetFail.reports[0]?.error).toContain('503');

    // 207 Multi-Status containing per-resource 503 inside calendar-multiget must report error
    const inner503 = await syncCaldavAndSubscriptions({
      urlsRaw: 'https://cal.example.com/work/',
      username: '',
      password: '',
      windowStartMs: Date.parse('2026-11-20T00:00:00+08:00'),
      windowEndMs: Date.parse('2026-11-21T00:00:00+08:00'),
      defaultTimezone: 'Asia/Shanghai',
      fetchImpl: async (_url, init) => {
        const body = String(init?.body ?? '');
        if (init?.method === 'REPORT' && body.includes('calendar-multiget')) {
          return new Response('<D:multistatus xmlns:D="DAV:"><D:response><D:href>/work/1.ics</D:href><D:propstat><D:status>HTTP/1.1 503 Service Unavailable</D:status></D:propstat></D:response></D:multistatus>', { status: 207 });
        }
        if (init?.method === 'REPORT') {
          return new Response('<D:multistatus xmlns:D="DAV:"><D:response><D:href>/work/1.ics</D:href></D:response></D:multistatus>', { status: 207 });
        }
        return new Response('', { status: 404 });
      },
    });
    expect(inner503.reports[0]?.error).toContain('503');

    // 207 Multi-Status containing per-resource 503 inside direct calendar-query must report error
    const directQuery503 = await syncCaldavAndSubscriptions({
      urlsRaw: 'https://cal.example.com/work/',
      username: '',
      password: '',
      windowStartMs: Date.parse('2026-11-20T00:00:00+08:00'),
      windowEndMs: Date.parse('2026-11-21T00:00:00+08:00'),
      defaultTimezone: 'Asia/Shanghai',
      fetchImpl: async (_url, init) => {
        if (init?.method === 'REPORT') {
          return new Response(
            '<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:response><D:href>/work/1.ics</D:href><D:propstat><D:prop><C:calendar-data>BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:ok1\nSUMMARY:OK\nDTSTART:20261120T080000Z\nEND:VEVENT\nEND:VCALENDAR</C:calendar-data></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response><D:response><D:href>/work/2.ics</D:href><D:propstat><D:status>HTTP/1.1 503 Service Unavailable</D:status></D:propstat></D:response></D:multistatus>',
            { status: 207 },
          );
        }
        return new Response('', { status: 404 });
      },
    });
    expect(directQuery503.reports[0]?.error).toContain('503');

    // Mixed calendar-query 207 (one inline calendar-data + one 404 needing multiget) must fetch both
    const mixedQuery = await syncCaldavAndSubscriptions({
      urlsRaw: 'https://cal.example.com/work/',
      username: '',
      password: '',
      windowStartMs: Date.parse('2026-11-20T00:00:00+08:00'),
      windowEndMs: Date.parse('2026-11-21T00:00:00+08:00'),
      defaultTimezone: 'Asia/Shanghai',
      fetchImpl: async (_url, init) => {
        const body = String(init?.body ?? '');
        if (init?.method === 'REPORT' && body.includes('calendar-multiget')) {
          return new Response(
            '<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:response><D:href>/work/2.ics</D:href><D:propstat><D:prop><C:calendar-data>BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:m2\nSUMMARY:补取日程\nDTSTART:20261120T090000Z\nEND:VEVENT\nEND:VCALENDAR</C:calendar-data></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>',
            { status: 207 },
          );
        }
        if (init?.method === 'REPORT') {
          return new Response(
            '<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:response><D:href>/work/1.ics</D:href><D:propstat><D:prop><C:calendar-data>BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:m1\nSUMMARY:直出日程\nDTSTART:20261120T080000Z\nEND:VEVENT\nEND:VCALENDAR</C:calendar-data></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response><D:response><D:href>/work/2.ics</D:href><D:propstat><D:prop><D:getetag>2</D:getetag></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat><D:propstat><D:prop><C:calendar-data/></D:prop><D:status>HTTP/1.1 404 Not Found</D:status></D:propstat></D:response></D:multistatus>',
            { status: 207 },
          );
        }
        return new Response('', { status: 404 });
      },
    });
    expect(mixedQuery.events.map((e) => e.title).sort()).toEqual(['直出日程', '补取日程']);

    // CalDAV PUT with query string keeps query intact
    let putUrl = '';
    await writeCaldavEvent({
      calendarId: 'caldav:https://cal.example.com/dav/?token=xyz',
      username: 'u',
      password: 'p',
      event: {
        uid: 'ev1',
        title: 'Query URL',
        startMs: Date.parse('2026-11-21T10:00:00+08:00'),
        endMs: Date.parse('2026-11-21T10:00:00+08:00'),
        timezone: 'Asia/Shanghai',
      },
      fetchImpl: async (u) => {
        putUrl = String(u);
        return new Response('', { status: 201 });
      },
    });
    expect(putUrl).toBe('https://cal.example.com/dav/ev1.ics?token=xyz');
  });

  it('preserves file mode & symlinks, isolates duplicate UIDs across calendars, and serializes sync vs due pushes', async () => {
    const dir = makeTempDir('cal-perms-');
    const realIcs = join(dir, 'real.ics');
    const linkIcs = join(dir, 'link.ics');
    writeFileSync(realIcs, 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n', 'utf8');
    chmodSync(realIcs, 0o600);
    symlinkSync(realIcs, linkIcs);

    await Promise.all([
      writeSystemCalendarEvent({
        calendarId: `system:file:${realIcs}`,
        platform: 'linux',
        event: {
          uid: 'perm-real',
          title: '真实路径写入',
          startMs: Date.parse('2026-11-21T09:00:00+08:00'),
          endMs: Date.parse('2026-11-21T09:00:00+08:00'),
          timezone: 'Asia/Shanghai',
        },
      }),
      writeSystemCalendarEvent({
        calendarId: `system:file:${linkIcs}`,
        platform: 'linux',
        event: {
          uid: 'perm-1',
          title: '权限测试',
          startMs: Date.parse('2026-11-21T10:00:00+08:00'),
          endMs: Date.parse('2026-11-21T10:00:00+08:00'),
          timezone: 'Asia/Shanghai',
        },
      }),
    ]);
    expect(lstatSync(linkIcs).isSymbolicLink()).toBe(true);
    expect(lstatSync(realIcs).mode & 0o777).toBe(0o600);
    const realContent = readFileSync(realIcs, 'utf8');
    expect(realContent).toContain('SUMMARY:真实路径写入');
    expect(realContent).toContain('SUMMARY:权限测试');

    // Two calendars with same UID + startMs must not overwrite each other
    const calA = join(dir, 'a.ics');
    const calB = join(dir, 'b.ics');
    const sameEvent = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:shared\r\nSUMMARY:共有\r\nDTSTART:20261121T020000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
    writeFileSync(calA, sameEvent, 'utf8');
    writeFileSync(calB, sameEvent, 'utf8');
    const both = await syncSystemCalendars({
      systemCalendarEnabled: false,
      localIcsPaths: `${calA}\n${calB}`,
      windowStartMs: Date.parse('2026-11-21T00:00:00Z'),
      windowEndMs: Date.parse('2026-11-22T00:00:00Z'),
      defaultTimezone: 'Asia/Shanghai',
      platform: 'linux',
    });
    expect(both.events).toHaveLength(2);

    // Concurrent slow sync + checkAndPushDue must not duplicate notification
    const dataDir = makeTempDir('cal-race-');
    const nowMs = Date.parse('2026-11-20T14:00:00+08:00');
    let dueCount = 0;
    let releaseSync!: () => void;
    const syncGate = new Promise<void>((r) => { releaseSync = r; });

    const cfg: CalendarReminderConfigSection = {
      ...CALENDAR_REMINDER_DEFAULTS,
      enabled: true,
      localIcsPaths: 'rel-ics-dir',
      disabledCalendars: ['system:本地 ICS'],
      writableCalendars: ['system:removed'],
    };
    const host = {
      pushEvent: async (ev: { type: string }) => {
        if (ev.type === 'calendar.due') dueCount++;
      },
      log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    } as unknown as WorldHost;

    const resolvedRelDir = join(process.cwd(), 'rel-ics-dir');
    let firstSync = true;
    const world = new CalendarReminderWorld({
      cfg,
      timezone: 'Asia/Shanghai',
      dataDir,
      now: () => nowMs,
      syncSources: async () => {
        if (!firstSync) await syncGate;
        firstSync = false;
        return {
          events: [{
            key: 'system:active:race:' + nowMs,
            uid: 'race',
            calendarId: 'system:active',
            title: '并发提醒',
            source: 'system',
            startMs: nowMs,
            endMs: nowMs,
            allDay: false,
          }],
          calendars: [
            { id: 'system:active', name: 'Active', source: 'system', count: 1, writable: true },
            { id: `system:file:${resolvedRelDir}/a.ics`, name: 'A', source: 'system', count: 0, writable: true },
            { id: `system:file:${resolvedRelDir}/b.ics`, name: 'B', source: 'system', count: 0, writable: true },
          ],
          reports: [{ source: 'mock', count: 1 }],
        };
      },
    });

    await world.start(host);
    expect(dueCount).toBe(1);
    // Legacy group ID "system:本地 ICS" with relative path must expand to all resolved custom local calendars
    expect(cfg.disabledCalendars).toContain(`system:file:${resolvedRelDir}/a.ics`);
    expect(cfg.disabledCalendars).toContain(`system:file:${resolvedRelDir}/b.ics`);

    // Start slow sync, then run two concurrent checkAndPushDue calls
    const slowSync = world.syncNow();
    await Promise.all([world.checkAndPushDue(), world.checkAndPushDue()]);
    releaseSync();
    await slowSync;
    await world.checkAndPushDue();
    expect(dueCount).toBe(1);

    // Removed calendar ID in writableCalendars must be rejected
    const addRes = await world.tools().find((t) => t.name === 'calendar_add')!.handler({
      title: '不应写入',
      start: '2026-11-21T10:00:00+08:00',
    }, {} as never);
    expect(addRes).toContain('写入日历失败');

    await world.stop();
  });
});
