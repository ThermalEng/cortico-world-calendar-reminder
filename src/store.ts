/**
 * 日历事件缓存与提醒状态持久化：
 * - 落盘路径：<dataDir>/calendar-reminder/store.json
 * - 负责点任务单次提醒、区间任务按频率重复提醒、区间结束提醒、以及用户 ack 静默。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { intervalModeMs, type IntervalRemindMode } from './config.ts';
import { isIntervalEvent, type CalendarEvent, type DiscoveredCalendar } from './sources/types.ts';

/** 点任务过期宽限：超过 30 分钟未触发的旧点任务不再补发。 */
const POINT_GRACE_MS = 30 * 60_000;
/** 结束提醒宽限：结束时间已过去超过 30 分钟的旧日程不再补发结束提醒。 */
const END_GRACE_MS = 30 * 60_000;
/** 状态保留天数：超过 7 天前的旧状态自动清理。 */
const STATE_RETENTION_MS = 7 * 24 * 60 * 60_000;

export interface EventNotifyState {
  firedCount: number;
  lastFiredAt?: number;
  endNotified: boolean;
  acked: boolean;
  endMs: number;
}

export interface CalendarStoreFile {
  version: 1;
  lastSyncAt?: number;
  calendars: DiscoveredCalendar[];
  events: CalendarEvent[];
  states: Record<string, EventNotifyState>;
}

export type DueKind = 'point' | 'interval_start' | 'interval_repeat' | 'interval_end';

export interface DueNotification {
  event: CalendarEvent;
  kind: DueKind;
  firedCount: number;
}

function storePath(dataDir: string): string {
  return join(dataDir, 'calendar-reminder', 'store.json');
}

function emptyStore(): CalendarStoreFile {
  return { version: 1, calendars: [], events: [], states: {} };
}

export function readStore(dataDir: string): { file: CalendarStoreFile; recovered: boolean } {
  const path = storePath(dataDir);
  if (!existsSync(path)) return { file: emptyStore(), recovered: false };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<CalendarStoreFile>;
    if (!raw || raw.version !== 1 || !Array.isArray(raw.events) || typeof raw.states !== 'object' || !raw.states) {
      return { file: emptyStore(), recovered: true };
    }
    return {
      file: {
        version: 1,
        lastSyncAt: typeof raw.lastSyncAt === 'number' ? raw.lastSyncAt : undefined,
        calendars: Array.isArray(raw.calendars) ? raw.calendars : [],
        events: raw.events,
        states: raw.states,
      },
      recovered: false,
    };
  } catch {
    return { file: emptyStore(), recovered: true };
  }
}

export function writeStore(dataDir: string, file: CalendarStoreFile): void {
  const path = storePath(dataDir);
  const dir = join(dataDir, 'calendar-reminder');
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(file, null, 2), 'utf8');
  renameSync(tmp, path);
}

export function pruneStates(file: CalendarStoreFile, now: number): void {
  const cutoff = now - STATE_RETENTION_MS;
  for (const [key, st] of Object.entries(file.states)) {
    if (st.endMs < cutoff) {
      delete file.states[key];
    }
  }
}

/** 扫描当前时刻应当投递的日历提醒（不直接修改状态，由 markNotified 落盘）。 */
export function evaluateDueNotifications(
  file: CalendarStoreFile,
  now: number,
  opts: { intervalMode: IntervalRemindMode; notifyOnEnd: boolean; disabledCalendars?: readonly string[] },
): DueNotification[] {
  const due: DueNotification[] = [];
  const repeatMs = intervalModeMs(opts.intervalMode);
  const disabled = new Set(opts.disabledCalendars ?? []);

  for (const ev of file.events) {
    if (ev.calendarId && disabled.has(ev.calendarId)) continue;
    const state = file.states[ev.key] ?? {
      firedCount: 0,
      endNotified: false,
      acked: false,
      endMs: ev.endMs,
    };

    if (!isIntervalEvent(ev)) {
      // 点任务：只提醒一次
      if (state.firedCount === 0 && !state.acked && now >= ev.startMs && now - ev.startMs <= POINT_GRACE_MS) {
        due.push({ event: ev, kind: 'point', firedCount: 1 });
      }
      continue;
    }

    // 区间任务（endMs > startMs）
    if (now >= ev.startMs && now < ev.endMs) {
      if (!state.acked) {
        if (state.firedCount === 0) {
          due.push({ event: ev, kind: 'interval_start', firedCount: 1 });
        } else if (repeatMs > 0 && state.lastFiredAt !== undefined && now - state.lastFiredAt >= repeatMs) {
          due.push({ event: ev, kind: 'interval_repeat', firedCount: state.firedCount + 1 });
        }
      }
    } else if (now >= ev.endMs) {
      if (opts.notifyOnEnd && !state.endNotified && now - ev.endMs <= END_GRACE_MS) {
        due.push({ event: ev, kind: 'interval_end', firedCount: state.firedCount });
      }
    }
  }

  return due;
}

/** 将已投递的通知写入状态，防止重复触发。 */
export function applyNotifications(file: CalendarStoreFile, notifications: DueNotification[], now: number): void {
  for (const n of notifications) {
    const prev = file.states[n.event.key] ?? {
      firedCount: 0,
      endNotified: false,
      acked: false,
      endMs: n.event.endMs,
    };
    prev.endMs = n.event.endMs;
    if (n.kind === 'interval_end') {
      prev.endNotified = true;
    } else {
      prev.firedCount = n.firedCount;
      prev.lastFiredAt = now;
    }
    file.states[n.event.key] = prev;
  }
}

/** 静默某个日程的后续区间提醒。 */
export function ackEvent(file: CalendarStoreFile, keyOrTitle: string): CalendarEvent | undefined {
  const query = keyOrTitle.trim();
  if (!query) return undefined;
  const target = file.events.find((ev) => ev.key === query)
    ?? file.events.find((ev) => ev.uid === query)
    ?? file.events.find((ev) => ev.title.toLowerCase().includes(query.toLowerCase()));
  if (!target) return undefined;

  const prev = file.states[target.key] ?? {
    firedCount: 0,
    endNotified: false,
    acked: false,
    endMs: target.endMs,
  };
  prev.acked = true;
  prev.endMs = target.endMs;
  file.states[target.key] = prev;
  return target;
}

/** 获取未结束或即将开始的日程，按开始时间升序排列。 */
export function upcomingOrActiveEvents(
  file: CalendarStoreFile,
  now: number,
  disabledCalendars?: readonly string[],
): CalendarEvent[] {
  const disabled = new Set(disabledCalendars ?? []);
  return [...file.events]
    .filter((ev) => !(ev.calendarId && disabled.has(ev.calendarId)))
    .filter((ev) => ev.endMs >= now || (!isIntervalEvent(ev) && ev.startMs >= now - 60_000))
    .sort((a, b) => a.startMs - b.startMs);
}
