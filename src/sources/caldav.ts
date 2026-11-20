/**
 * CalDAV 与 ICS/webcal 订阅同步客户端（纯 TypeScript，基于 Node 内置 fetch）。
 * 支持：
 * 1) 单个服务域名/地址（自动补全 https://）、日历集合 URL 或 .ics / webcal:// 订阅链接
 * 2) CalDAV 服务自动发现（PROPFIND current-user-principal -> calendar-home-set -> calendar collections）
 * 3) 标准 REPORT calendar-query 以及两步式 REPORT calendar-multiget（兼容飞书等服务端）
 */
import { buildIcsCalendar, parseIcs, type NewIcsEventInput } from '../ics.ts';
import type { CalendarEvent, DiscoveredCalendar, SyncSourceReport } from './types.ts';

export interface CaldavSyncOptions {
  urlsRaw: string;
  username: string;
  password: string;
  windowStartMs: number;
  windowEndMs: number;
  defaultTimezone: string;
  fetchImpl?: typeof fetch;
}

export interface CaldavSyncResult {
  events: CalendarEvent[];
  calendars: DiscoveredCalendar[];
  reports: SyncSourceReport[];
}

export function normalizeCaldavUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  const schemeMatch = /^(webcals?|caldavs?|webdavs?|davs?):\/\//i.exec(trimmed);
  if (schemeMatch) {
    return `https://${trimmed.slice(schemeMatch[0].length)}`;
  }
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    return `https://${trimmed}`;
  }
  return trimmed;
}

function formatCaldavUtc(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

function unescapeXml(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** 从 CalDAV multistatus XML 中提取所有 <calendar-data> 块。 */
export function extractCalendarDataFromXml(xml: string): string[] {
  const blocks: string[] = [];
  const re = /<(?:[a-zA-Z0-9_-]+:)?calendar-data\b[^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9_-]+:)?calendar-data>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const ics = unescapeXml(m[1] ?? '').trim();
    if (ics.includes('BEGIN:VCALENDAR') || ics.includes('BEGIN:VEVENT')) {
      blocks.push(ics);
    }
  }
  return blocks;
}

/** 从 multistatus XML 中提取各 <response> 里的 .ics 资源 href。 */
function extractResourceHrefsFromXml(xml: string): string[] {
  const responses = xml.split(/<(?:[a-zA-Z0-9_-]+:)?response\b/i).slice(1);
  const hrefs: string[] = [];
  for (const resp of responses) {
    const hrefMatch = /<(?:[a-zA-Z0-9_-]+:)?href\b[^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9_-]+:)?href>/i.exec(resp);
    if (!hrefMatch) continue;
    const rawHref = unescapeXml(hrefMatch[1] ?? '').trim();
    if (rawHref && /\.ics(?:[?#]|$)/i.test(rawHref)) {
      hrefs.push(rawHref);
    }
  }
  return [...new Set(hrefs)];
}

function extractHrefsInsideTag(xml: string, tagName: string): string[] {
  const re = new RegExp(`<(?:[a-zA-Z0-9_-]+:)?${tagName}\\b[^>]*>([\\s\\S]*?)<\\/(?:[a-zA-Z0-9_-]+:)?${tagName}>`, 'gi');
  const hrefs: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const inner = m[1] ?? '';
    const hrefRe = /<(?:[a-zA-Z0-9_-]+:)?href\b[^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9_-]+:)?href>/gi;
    let hm: RegExpExecArray | null;
    while ((hm = hrefRe.exec(inner)) !== null) {
      const h = unescapeXml(hm[1] ?? '').trim();
      if (h) hrefs.push(h);
    }
  }
  return hrefs;
}

interface DiscoveredCaldavCollection {
  url: string;
  name: string;
}

function extractCalendarCollections(xml: string, baseUrl: string): DiscoveredCaldavCollection[] {
  const responses = xml.split(/<(?:[a-zA-Z0-9_-]+:)?response\b/i).slice(1);
  const seen = new Set<string>();
  const collections: DiscoveredCaldavCollection[] = [];
  for (const resp of responses) {
    if (!/<(?:[a-zA-Z0-9_-]+:)?calendar\b/i.test(resp)) continue;
    const hrefMatch = /<(?:[a-zA-Z0-9_-]+:)?href\b[^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9_-]+:)?href>/i.exec(resp);
    if (!hrefMatch) continue;
    const rawHref = unescapeXml(hrefMatch[1] ?? '').trim();
    if (!rawHref) continue;
    const nameMatch = /<(?:[a-zA-Z0-9_-]+:)?displayname\b[^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9_-]+:)?displayname>/i.exec(resp);
    const displayName = nameMatch ? unescapeXml(nameMatch[1] ?? '').trim() : '';
    try {
      const url = new URL(rawHref, baseUrl).toString();
      if (seen.has(url)) continue;
      seen.add(url);
      collections.push({ url, name: displayName || 'CalDAV 日历' });
    } catch {
      // Ignore malformed href.
    }
  }
  return collections;
}

function buildAuthHeader(username: string, password: string): string | undefined {
  if (!username && !password) return undefined;
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

function escapeXmlText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function multigetCalendarData(
  collectionUrl: string,
  hrefs: string[],
  authHeader: string | undefined,
  fetchFn: typeof fetch,
): Promise<string[]> {
  const blocks: string[] = [];
  const chunkSize = 50;
  for (let i = 0; i < hrefs.length; i += chunkSize) {
    const chunk = hrefs.slice(i, i + chunkSize);
    const hrefXml = chunk.map((h) => `  <D:href>${escapeXmlText(h)}</D:href>`).join('\n');
    const body = `<?xml version="1.0" encoding="utf-8" ?>
<C:calendar-multiget xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop>
    <D:getetag/>
    <C:calendar-data/>
  </D:prop>
${hrefXml}
</C:calendar-multiget>`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/xml; charset=utf-8',
      Depth: '1',
    };
    if (authHeader) headers.Authorization = authHeader;
    const res = await fetchFn(collectionUrl, {
      method: 'REPORT',
      headers,
      body,
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) {
      blocks.push(...extractCalendarDataFromXml(await res.text()));
    }
  }
  return blocks;
}

async function queryCalendarReport(
  url: string,
  authHeader: string | undefined,
  opts: CaldavSyncOptions,
  fetchFn: typeof fetch,
): Promise<{ ok: boolean; status: number; icsBlocks: string[] }> {
  const start = formatCaldavUtc(opts.windowStartMs);
  const end = formatCaldavUtc(opts.windowEndMs);
  const body = `<?xml version="1.0" encoding="utf-8" ?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop>
    <D:getetag/>
    <C:calendar-data/>
  </D:prop>
  <C:filter>
    <C:comp-filter name="VCALENDAR">
      <C:comp-filter name="VEVENT">
        <C:time-range start="${start}" end="${end}"/>
      </C:comp-filter>
    </C:comp-filter>
  </C:filter>
</C:calendar-query>`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/xml; charset=utf-8',
    Depth: '1',
  };
  if (authHeader) headers.Authorization = authHeader;

  const res = await fetchFn(url, {
    method: 'REPORT',
    headers,
    body,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    return { ok: false, status: res.status, icsBlocks: [] };
  }
  const text = await res.text();
  const directBlocks = extractCalendarDataFromXml(text);
  if (directBlocks.length > 0) {
    return { ok: true, status: res.status, icsBlocks: directBlocks };
  }
  // 兼容飞书等 CalDAV：calendar-query 只返回 .ics href，需再通过 calendar-multiget 拉取正文
  const hrefs = extractResourceHrefsFromXml(text);
  if (hrefs.length > 0) {
    const multigetBlocks = await multigetCalendarData(url, hrefs, authHeader, fetchFn);
    return { ok: true, status: res.status, icsBlocks: multigetBlocks };
  }
  return { ok: true, status: res.status, icsBlocks: [] };
}

async function propfind(
  url: string,
  depth: '0' | '1',
  xmlBody: string,
  authHeader: string | undefined,
  fetchFn: typeof fetch,
): Promise<{ text: string; finalUrl: string } | undefined> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/xml; charset=utf-8',
    Depth: depth,
  };
  if (authHeader) headers.Authorization = authHeader;
  const res = await fetchFn(url, {
    method: 'PROPFIND',
    headers,
    body: xmlBody,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return undefined;
  return { text: await res.text(), finalUrl: res.url || url };
}

async function discoverFromEntry(
  entryUrl: string,
  authHeader: string | undefined,
  fetchFn: typeof fetch,
): Promise<DiscoveredCaldavCollection[]> {
  const principalRes = await propfind(
    entryUrl,
    '0',
    `<?xml version="1.0" encoding="utf-8" ?>
<D:propfind xmlns:D="DAV:">
  <D:prop><D:current-user-principal/></D:prop>
</D:propfind>`,
    authHeader,
    fetchFn,
  );
  const principalBase = principalRes?.finalUrl ?? entryUrl;
  const principalHref = principalRes ? extractHrefsInsideTag(principalRes.text, 'current-user-principal')[0] : undefined;
  const principalUrl = principalHref ? new URL(principalHref, principalBase).toString() : principalBase;

  const homeRes = await propfind(
    principalUrl,
    '0',
    `<?xml version="1.0" encoding="utf-8" ?>
<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop><C:calendar-home-set/></D:prop>
</D:propfind>`,
    authHeader,
    fetchFn,
  );
  const homeBase = homeRes?.finalUrl ?? principalUrl;
  const homeHref = homeRes ? extractHrefsInsideTag(homeRes.text, 'calendar-home-set')[0] : undefined;
  const homeUrl = homeHref ? new URL(homeHref, homeBase).toString() : principalBase;

  const listRes = await propfind(
    homeUrl,
    '1',
    `<?xml version="1.0" encoding="utf-8" ?>
<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop><D:resourcetype/><D:displayname/></D:prop>
</D:propfind>`,
    authHeader,
    fetchFn,
  );
  if (!listRes) return [];
  return extractCalendarCollections(listRes.text, listRes.finalUrl);
}

async function discoverCaldavCollections(
  entryUrl: string,
  authHeader: string | undefined,
  fetchFn: typeof fetch,
): Promise<DiscoveredCaldavCollection[]> {
  const direct = await discoverFromEntry(entryUrl, authHeader, fetchFn);
  if (direct.length > 0) return direct;

  // RFC 6764: 若入口路径未发现日历集合，回退尝试 /.well-known/caldav
  try {
    const wellKnownUrl = new URL('/.well-known/caldav', entryUrl).toString();
    if (wellKnownUrl !== entryUrl) {
      return await discoverFromEntry(wellKnownUrl, authHeader, fetchFn);
    }
  } catch {
    // Ignore malformed URL.
  }
  return [];
}

export async function syncCaldavAndSubscriptions(opts: CaldavSyncOptions): Promise<CaldavSyncResult> {
  const url = normalizeCaldavUrl(opts.urlsRaw);
  if (!url) return { events: [], calendars: [], reports: [] };
  const fetchFn = opts.fetchImpl ?? fetch;
  const authHeader = buildAuthHeader(opts.username, opts.password);

  try {
    // 1) 若明确为 .ics 链接，直接 GET
    if (/\.ics(?:[?#]|$)/i.test(url)) {
      const headers: Record<string, string> = {};
      if (authHeader) headers.Authorization = authHeader;
      const res = await fetchFn(url, { headers, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) {
        return { events: [], calendars: [], reports: [{ source: url, count: 0, error: `HTTP ${res.status}` }] };
      }
      const text = await res.text();
      const events = parseIcs(text, {
        windowStartMs: opts.windowStartMs,
        windowEndMs: opts.windowEndMs,
        defaultTimezone: opts.defaultTimezone,
        source: 'ics',
        calendarId: `ics:${url}`,
        calendarName: 'ICS 订阅',
      });
      const calName = events[0]?.calendarName ?? 'ICS 订阅';
      return {
        events,
        calendars: [{ id: `ics:${url}`, name: calName, source: 'ics', count: events.length, writable: false }],
        reports: [{ source: url, count: events.length }],
      };
    }

    // 2) 直接尝试 CalDAV REPORT calendar-query
    const direct = await queryCalendarReport(url, authHeader, opts, fetchFn);
    if (direct.ok && direct.icsBlocks.length > 0) {
      const calId = `caldav:${url}`;
      const events = direct.icsBlocks.flatMap((ics) => parseIcs(ics, {
        windowStartMs: opts.windowStartMs,
        windowEndMs: opts.windowEndMs,
        defaultTimezone: opts.defaultTimezone,
        source: 'caldav',
        calendarId: calId,
        calendarName: 'CalDAV',
      }));
      const calName = events[0]?.calendarName ?? 'CalDAV';
      return {
        events,
        calendars: [{ id: calId, name: calName, source: 'caldav', count: events.length, writable: true }],
        reports: [{ source: url, count: events.length }],
      };
    }

    // 3) 尝试 CalDAV 服务自动发现
    const collections = await discoverCaldavCollections(url, authHeader, fetchFn);
    if (collections.length > 0) {
      const events: CalendarEvent[] = [];
      const calendars: DiscoveredCalendar[] = [];
      for (const col of collections) {
        const rep = await queryCalendarReport(col.url, authHeader, opts, fetchFn);
        let colCount = 0;
        if (rep.ok) {
          const calId = `caldav:${col.url}`;
          for (const ics of rep.icsBlocks) {
            const parsed = parseIcs(ics, {
              windowStartMs: opts.windowStartMs,
              windowEndMs: opts.windowEndMs,
              defaultTimezone: opts.defaultTimezone,
              source: 'caldav',
              calendarId: calId,
              calendarName: col.name,
            });
            colCount += parsed.length;
            events.push(...parsed);
          }
        }
        calendars.push({ id: `caldav:${col.url}`, name: col.name, source: 'caldav', count: colCount, writable: true });
      }
      const dedup = new Map<string, CalendarEvent>();
      for (const ev of events) dedup.set(ev.key, ev);
      return {
        events: [...dedup.values()],
        calendars,
        reports: [{ source: url, count: dedup.size }],
      };
    }

    // 4) 回退：尝试 GET 作为普通 ICS 订阅
    const headers: Record<string, string> = {};
    if (authHeader) headers.Authorization = authHeader;
    const getRes = await fetchFn(url, { headers, signal: AbortSignal.timeout(15_000) });
    if (getRes.ok) {
      const contentType = getRes.headers.get('content-type') ?? '';
      const body = await getRes.text();
      if (contentType.includes('text/calendar') || body.includes('BEGIN:VCALENDAR')) {
        const calId = `ics:${url}`;
        const events = parseIcs(body, {
          windowStartMs: opts.windowStartMs,
          windowEndMs: opts.windowEndMs,
          defaultTimezone: opts.defaultTimezone,
          source: 'ics',
          calendarId: calId,
          calendarName: 'ICS 订阅',
        });
        const calName = events[0]?.calendarName ?? 'ICS 订阅';
        return {
          events,
          calendars: [{ id: calId, name: calName, source: 'ics', count: events.length, writable: false }],
          reports: [{ source: url, count: events.length }],
        };
      }
    }

    return {
      events: [],
      calendars: [],
      reports: [{
        source: url,
        count: 0,
        error: direct.ok ? '未发现日程数据' : `CalDAV REPORT 返回 HTTP ${direct.status}`,
      }],
    };
  } catch (error) {
    return {
      events: [],
      calendars: [],
      reports: [{
        source: url,
        count: 0,
        error: error instanceof Error ? error.message : String(error),
      }],
    };
  }
}

export async function writeCaldavEvent(opts: {
  calendarId: string;
  username: string;
  password: string;
  event: NewIcsEventInput;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  if (!opts.calendarId.startsWith('caldav:')) {
    throw new Error('该日历不是可写的 CalDAV 日历');
  }
  const collectionUrl = opts.calendarId.slice('caldav:'.length).replace(/\/?$/, '/');
  const targetUrl = `${collectionUrl}${encodeURIComponent(opts.event.uid)}.ics`;
  const fetchFn = opts.fetchImpl ?? fetch;
  const authHeader = buildAuthHeader(opts.username, opts.password);
  const headers: Record<string, string> = {
    'Content-Type': 'text/calendar; charset=utf-8',
    'If-None-Match': '*',
  };
  if (authHeader) headers.Authorization = authHeader;

  const res = await fetchFn(targetUrl, {
    method: 'PUT',
    headers,
    body: buildIcsCalendar(opts.event),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`CalDAV 写入失败: HTTP ${res.status}`);
  }
}
