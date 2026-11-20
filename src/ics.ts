/**
 * 纯 TypeScript RFC 5545 iCalendar (.ics) 解析器与 RRULE 展开器。
 * 零第三方依赖，支持折行、TZID、DURATION、全天日程、EXDATE 与常见 RRULE。
 */
import { resolveTimezone, zonedToEpochMs } from './time.ts';
import type { CalendarEvent, CalendarSourceKind } from './sources/types.ts';

export interface ParseIcsOptions {
  /** 展开窗口起点（UTC 毫秒） */
  windowStartMs: number;
  /** 展开窗口终点（UTC 毫秒） */
  windowEndMs: number;
  /** 缺省时区（用于浮动时间与全天日程） */
  defaultTimezone: string;
  /** 事件来源类型 */
  source: CalendarSourceKind;
  /** 所属日历 ID（用于启用/停用过滤） */
  calendarId?: string;
  /** 默认日历名称 */
  calendarName?: string;
}

interface IcsProp {
  name: string;
  params: Record<string, string>;
  value: string;
}

interface ParsedDate {
  ms: number;
  allDay: boolean;
  tzid?: string;
}

/** RFC 5545 折行展开：CRLF/LF 后跟单个空格或制表符表示续行。 */
export function unfoldIcsLines(raw: string): string[] {
  const normalized = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const unfolded = normalized.replace(/\n[ \t]/g, '');
  return unfolded.split('\n');
}

function unescapeIcsText(text: string): string {
  return text
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\')
    .trim();
}

function parsePropLine(line: string): IcsProp | undefined {
  const colonIdx = findUnquotedColon(line);
  if (colonIdx <= 0) return undefined;
  const left = line.slice(0, colonIdx);
  const value = line.slice(colonIdx + 1);
  const segments = splitUnquotedSemicolon(left);
  const name = segments[0]!.trim().toUpperCase();
  const params: Record<string, string> = {};
  for (let i = 1; i < segments.length; i++) {
    const eqIdx = segments[i]!.indexOf('=');
    if (eqIdx > 0) {
      const k = segments[i]!.slice(0, eqIdx).trim().toUpperCase();
      const v = segments[i]!.slice(eqIdx + 1).trim().replace(/^"|"$/g, '');
      params[k] = v;
    }
  }
  return { name, params, value };
}

function findUnquotedColon(line: string): number {
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === ':' && !inQuotes) return i;
  }
  return -1;
}

function splitUnquotedSemicolon(text: string): string[] {
  const out: string[] = [];
  let inQuotes = false;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === ';' && !inQuotes) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out;
}

/** 解析 ICS 日期/时间：YYYYMMDD 或 YYYYMMDDTHHMMSS(Z)。 */
export function parseIcsDate(
  value: string,
  params: Record<string, string>,
  defaultTimezone: string,
): ParsedDate | undefined {
  const clean = value.trim();
  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(clean);
  if (dateOnly || params.VALUE === 'DATE') {
    const m = /^(\d{4})(\d{2})(\d{2})/.exec(clean);
    if (!m) return undefined;
    const tz = resolveTimezone(params.TZID, defaultTimezone);
    const ms = zonedToEpochMs(Number(m[1]), Number(m[2]), Number(m[3]), 0, 0, 0, tz);
    return { ms, allDay: true, tzid: tz };
  }

  const dt = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/i.exec(clean);
  if (!dt) return undefined;
  const year = Number(dt[1]);
  const month = Number(dt[2]);
  const day = Number(dt[3]);
  const hour = Number(dt[4]);
  const minute = Number(dt[5]);
  const second = Number(dt[6] ?? '0');
  const isUtc = Boolean(dt[7]);
  if (isUtc) {
    return { ms: Date.UTC(year, month - 1, day, hour, minute, second), allDay: false, tzid: 'UTC' };
  }
  const tz = resolveTimezone(params.TZID, defaultTimezone);
  return { ms: zonedToEpochMs(year, month, day, hour, minute, second, tz), allDay: false, tzid: tz };
}

/** 解析 RFC 5545 DURATION，例如 PT1H30M、P1D、P1W。 */
export function parseIcsDurationMs(raw: string): number {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec(raw.trim());
  if (!m) return 0;
  const sign = m[1] === '-' ? -1 : 1;
  const weeks = Number(m[2] ?? 0);
  const days = Number(m[3] ?? 0);
  const hours = Number(m[4] ?? 0);
  const minutes = Number(m[5] ?? 0);
  const seconds = Number(m[6] ?? 0);
  const totalSec = (((weeks * 7 + days) * 24 + hours) * 60 + minutes) * 60 + seconds;
  return sign * totalSec * 1000;
}

interface RRule {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
  interval: number;
  count?: number;
  untilMs?: number;
  byDay?: string[];
  byMonthDay?: number[];
  byMonth?: number[];
}

function parseRRule(raw: string, defaultTimezone: string): RRule | undefined {
  const kv: Record<string, string> = {};
  for (const part of raw.trim().split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) kv[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1).toUpperCase();
  }
  const freq = kv.FREQ;
  if (freq !== 'DAILY' && freq !== 'WEEKLY' && freq !== 'MONTHLY' && freq !== 'YEARLY') {
    return undefined;
  }
  const interval = Math.max(1, Number(kv.INTERVAL ?? '1') || 1);
  const count = kv.COUNT ? Math.max(1, Number(kv.COUNT) || 1) : undefined;
  let untilMs: number | undefined;
  if (kv.UNTIL) {
    const parsed = parseIcsDate(kv.UNTIL, {}, defaultTimezone);
    if (parsed) untilMs = parsed.allDay ? parsed.ms + 86_400_000 - 1 : parsed.ms;
  }
  const byDay = kv.BYDAY ? kv.BYDAY.split(',').filter(Boolean) : undefined;
  const byMonthDay = kv.BYMONTHDAY ? kv.BYMONTHDAY.split(',').map(Number).filter(Number.isFinite) : undefined;
  const byMonth = kv.BYMONTH ? kv.BYMONTH.split(',').map(Number).filter(Number.isFinite) : undefined;
  return { freq, interval, count, untilMs, byDay, byMonthDay, byMonth };
}

const WEEKDAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const;

function getZonedComponents(ms: number, timeZone: string): {
  year: number; month: number; day: number; hour: number; minute: number; second: number; weekday: string;
} {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
    hour12: false,
  });
  const map: Record<string, string> = {};
  for (const p of fmt.formatToParts(new Date(ms))) {
    if (p.type !== 'literal') map[p.type] = p.value;
  }
  const weekdayMap: Record<string, string> = {
    Sun: 'SU', Mon: 'MO', Tue: 'TU', Wed: 'WE', Thu: 'TH', Fri: 'FR', Sat: 'SA',
  };
  const hour = Number(map.hour) === 24 ? 0 : Number(map.hour);
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour,
    minute: Number(map.minute),
    second: Number(map.second),
    weekday: weekdayMap[map.weekday ?? ''] ?? WEEKDAY_CODES[new Date(ms).getUTCDay()]!,
  };
}

function expandRRule(
  startMs: number,
  durationMs: number,
  tzid: string,
  rrule: RRule,
  exdates: Set<number>,
  windowStartMs: number,
  windowEndMs: number,
): number[] {
  const results: number[] = [];
  const base = getZonedComponents(startMs, tzid);
  const hardEnd = rrule.untilMs !== undefined ? Math.min(rrule.untilMs, windowEndMs) : windowEndMs;
  const maxSteps = 2000;
  let generated = 0;

  const pushIfValid = (ms: number): boolean => {
    if (ms > hardEnd) return false;
    generated++;
    if (rrule.count !== undefined && generated > rrule.count) return false;
    if (!exdates.has(ms)) {
      const endMs = ms + Math.max(0, durationMs);
      if (endMs >= windowStartMs && ms <= windowEndMs) {
        results.push(ms);
      }
    }
    return true;
  };

  if (rrule.freq === 'DAILY') {
    for (let step = 0; step < maxSteps; step++) {
      const d = new Date(Date.UTC(base.year, base.month - 1, base.day + step * rrule.interval));
      const ms = zonedToEpochMs(
        d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(),
        base.hour, base.minute, base.second, tzid,
      );
      if (rrule.byDay && rrule.byDay.length > 0) {
        const comp = getZonedComponents(ms, tzid);
        if (!rrule.byDay.some((b) => b.endsWith(comp.weekday))) continue;
      }
      if (!pushIfValid(ms)) break;
    }
  } else if (rrule.freq === 'WEEKLY') {
    const targetDays = rrule.byDay && rrule.byDay.length > 0
      ? rrule.byDay.map((b) => b.slice(-2))
      : [base.weekday];
    for (let week = 0; week < maxSteps; week++) {
      let stopped = false;
      for (let dow = 0; dow < 7; dow++) {
        const d = new Date(Date.UTC(base.year, base.month - 1, base.day + week * 7 * rrule.interval + dow));
        const ms = zonedToEpochMs(
          d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(),
          base.hour, base.minute, base.second, tzid,
        );
        if (ms < startMs) continue;
        const comp = getZonedComponents(ms, tzid);
        if (!targetDays.includes(comp.weekday)) continue;
        if (!pushIfValid(ms)) { stopped = true; break; }
      }
      if (stopped) break;
    }
  } else if (rrule.freq === 'MONTHLY') {
    for (let step = 0; step < maxSteps; step++) {
      const targetMonthIdx = (base.month - 1) + step * rrule.interval;
      const year = base.year + Math.floor(targetMonthIdx / 12);
      const month = (targetMonthIdx % 12) + 1;
      const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
      const targetDays = rrule.byMonthDay && rrule.byMonthDay.length > 0
        ? rrule.byMonthDay.map((d) => (d < 0 ? daysInMonth + 1 + d : d)).filter((d) => d >= 1 && d <= daysInMonth)
        : [base.day];
      let stopped = false;
      for (const day of targetDays.sort((a, b) => a - b)) {
        const ms = zonedToEpochMs(year, month, day, base.hour, base.minute, base.second, tzid);
        if (ms < startMs) continue;
        if (!pushIfValid(ms)) { stopped = true; break; }
      }
      if (stopped) break;
    }
  } else if (rrule.freq === 'YEARLY') {
    for (let step = 0; step < 50; step++) {
      const year = base.year + step * rrule.interval;
      const months = rrule.byMonth && rrule.byMonth.length > 0 ? rrule.byMonth : [base.month];
      let stopped = false;
      for (const month of months) {
        const ms = zonedToEpochMs(year, month, base.day, base.hour, base.minute, base.second, tzid);
        if (ms < startMs) continue;
        if (!pushIfValid(ms)) { stopped = true; break; }
      }
      if (stopped) break;
    }
  }

  return results;
}

interface RawVEvent {
  uid: string;
  summary: string;
  description?: string;
  location?: string;
  status?: string;
  dtstart?: ParsedDate;
  dtend?: ParsedDate;
  durationMs?: number;
  rrule?: string;
  exdates: number[];
  rdates: number[];
}

/** 解析完整 ICS 文本，返回落在 [windowStartMs, windowEndMs] 内的统一事件列表。 */
export function parseIcs(icsText: string, opts: ParseIcsOptions): CalendarEvent[] {
  const lines = unfoldIcsLines(icsText);
  let calendarName = opts.calendarName;
  const rawEvents: RawVEvent[] = [];
  let current: RawVEvent | undefined;
  let inSubcomponent = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.toUpperCase() === 'BEGIN:VEVENT') {
      current = { uid: '', summary: '', exdates: [], rdates: [] };
      inSubcomponent = 0;
      continue;
    }
    if (trimmed.toUpperCase() === 'END:VEVENT') {
      if (current) rawEvents.push(current);
      current = undefined;
      inSubcomponent = 0;
      continue;
    }
    if (current && trimmed.toUpperCase().startsWith('BEGIN:')) {
      inSubcomponent++;
      continue;
    }
    if (current && trimmed.toUpperCase().startsWith('END:')) {
      if (inSubcomponent > 0) inSubcomponent--;
      continue;
    }
    if (inSubcomponent > 0) continue;

    const prop = parsePropLine(line);
    if (!prop) continue;

    if (!current) {
      if (prop.name === 'X-WR-CALNAME' && prop.value.trim()) {
        calendarName = calendarName ?? unescapeIcsText(prop.value);
      }
      continue;
    }

    switch (prop.name) {
      case 'UID':
        current.uid = prop.value.trim();
        break;
      case 'SUMMARY':
        current.summary = unescapeIcsText(prop.value);
        break;
      case 'DESCRIPTION':
        current.description = unescapeIcsText(prop.value);
        break;
      case 'LOCATION':
        current.location = unescapeIcsText(prop.value);
        break;
      case 'STATUS':
        current.status = prop.value.trim().toUpperCase();
        break;
      case 'DTSTART':
        current.dtstart = parseIcsDate(prop.value, prop.params, opts.defaultTimezone);
        break;
      case 'DTEND':
        current.dtend = parseIcsDate(prop.value, prop.params, opts.defaultTimezone);
        break;
      case 'DURATION':
        current.durationMs = parseIcsDurationMs(prop.value);
        break;
      case 'RRULE':
        current.rrule = prop.value.trim();
        break;
      case 'EXDATE':
        for (const v of prop.value.split(',')) {
          const d = parseIcsDate(v, prop.params, opts.defaultTimezone);
          if (d) current.exdates.push(d.ms);
        }
        break;
      case 'RDATE':
        for (const v of prop.value.split(',')) {
          const d = parseIcsDate(v, prop.params, opts.defaultTimezone);
          if (d) current.rdates.push(d.ms);
        }
        break;
    }
  }

  const events: CalendarEvent[] = [];
  for (let i = 0; i < rawEvents.length; i++) {
    const raw = rawEvents[i]!;
    if (raw.status === 'CANCELLED') continue;
    if (!raw.dtstart) continue;
    const title = raw.summary || '（无标题日程）';
    const uid = raw.uid || `anon-${i}-${raw.dtstart.ms}`;

    let durationMs = 0;
    if (raw.dtend) {
      durationMs = Math.max(0, raw.dtend.ms - raw.dtstart.ms);
    } else if (raw.durationMs !== undefined) {
      durationMs = Math.max(0, raw.durationMs);
    }

    const exdateSet = new Set(raw.exdates);
    const occurrences = new Set<number>();

    if (raw.rrule) {
      const rule = parseRRule(raw.rrule, opts.defaultTimezone);
      if (rule) {
        const tzid = raw.dtstart.tzid ?? resolveTimezone(undefined, opts.defaultTimezone);
        for (const occ of expandRRule(
          raw.dtstart.ms,
          durationMs,
          tzid,
          rule,
          exdateSet,
          opts.windowStartMs,
          opts.windowEndMs,
        )) {
          occurrences.add(occ);
        }
      } else if (!exdateSet.has(raw.dtstart.ms)) {
        occurrences.add(raw.dtstart.ms);
      }
    } else if (!exdateSet.has(raw.dtstart.ms)) {
      occurrences.add(raw.dtstart.ms);
    }

    for (const rdate of raw.rdates) {
      if (!exdateSet.has(rdate)) occurrences.add(rdate);
    }

    for (const startMs of occurrences) {
      const endMs = startMs + durationMs;
      if (endMs < opts.windowStartMs || startMs > opts.windowEndMs) continue;
      events.push({
        key: `${opts.source}:${uid}:${startMs}`,
        uid,
        calendarId: opts.calendarId ?? `${opts.source}:${calendarName ?? 'default'}`,
        title,
        description: raw.description,
        location: raw.location,
        source: opts.source,
        calendarName,
        startMs,
        endMs,
        allDay: raw.dtstart.allDay,
      });
    }
  }

  return events;
}

export interface NewIcsEventInput {
  uid: string;
  title: string;
  startMs: number;
  endMs: number;
  allDay?: boolean;
  location?: string;
  description?: string;
  timezone: string;
}

function escapeIcsText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\r?\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

function formatIcsUtc(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

function formatIcsDateOnly(ms: number, timezone: string): string {
  const fmt = new Intl.DateTimeFormat('sv-SE', {
    timeZone: resolveTimezone(timezone, 'UTC'),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(new Date(ms)).replace(/-/g, '');
}

/** 生成单个 VEVENT 块（不含 VCALENDAR 外壳）。 */
export function buildVEventBlock(input: NewIcsEventInput): string {
  const lines: string[] = [
    'BEGIN:VEVENT',
    `UID:${input.uid}`,
    `DTSTAMP:${formatIcsUtc(Date.now())}`,
    `SUMMARY:${escapeIcsText(input.title)}`,
  ];
  if (input.allDay) {
    lines.push(`DTSTART;VALUE=DATE:${formatIcsDateOnly(input.startMs, input.timezone)}`);
    if (input.endMs > input.startMs) {
      lines.push(`DTEND;VALUE=DATE:${formatIcsDateOnly(input.endMs, input.timezone)}`);
    }
  } else {
    lines.push(`DTSTART:${formatIcsUtc(input.startMs)}`);
    if (input.endMs > input.startMs) {
      lines.push(`DTEND:${formatIcsUtc(input.endMs)}`);
    }
  }
  if (input.location?.trim()) lines.push(`LOCATION:${escapeIcsText(input.location.trim())}`);
  if (input.description?.trim()) lines.push(`DESCRIPTION:${escapeIcsText(input.description.trim())}`);
  lines.push('END:VEVENT');
  return lines.join('\r\n');
}

/** 生成完整的 RFC 5545 VCALENDAR 文本，用于 CalDAV PUT 或 .ics 写入。 */
export function buildIcsCalendar(input: NewIcsEventInput): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Coopanion//cortico-world-calendar-reminder//CN',
    'CALSCALE:GREGORIAN',
    buildVEventBlock(input),
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}
