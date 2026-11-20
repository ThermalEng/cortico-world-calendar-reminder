/**
 * 日历提醒 World：
 * - 定期从系统日历（Linux/Windows/macOS）与 CalDAV/ICS 订阅同步日程
 * - 每 15 秒扫描一次到期日程与区间提醒
 * - 点任务提醒一次；区间任务按配置（once/daily/hourly/every_15m）提醒，并可选在结束时提醒「时间到了」
 */
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PushOptions, ToolDef, World, WorldHost, WorldWebUiDecl } from 'cortico/core/types.ts';
import { nowIso } from 'cortico/core/util.ts';
import { CALENDAR_REMINDER_CONFIG_GROUP, type CalendarReminderConfigSection, type IntervalRemindMode } from './config.ts';
import type { NewIcsEventInput } from './ics.ts';
import { normalizeCaldavUrl, syncCaldavAndSubscriptions, writeCaldavEvent } from './sources/caldav.ts';
import { splitPathList, syncSystemCalendars, writeSystemCalendarEvent } from './sources/system.ts';
import { isIntervalEvent, type CalendarEvent, type DiscoveredCalendar, type SyncSourceReport } from './sources/types.ts';
import type { CalendarPanelItem, CalendarPanelState } from './webui.ts';
import {
  ackEvent,
  applyNotifications,
  evaluateDueNotifications,
  pruneStates,
  readStore,
  upcomingOrActiveEvents,
  writeStore,
  type DueNotification,
} from './store.ts';
import { formatEventTime, formatLocal, humanizeDelta } from './time.ts';

const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));
const TICK_MS = 15_000;
const MAX_TITLE = 120;
const MAX_LIST = 20;

export interface CalendarReminderWorldOptions {
  /** `worlds.calendar-reminder` 的活引用。 */
  cfg: CalendarReminderConfigSection;
  timezone: string;
  dataDir: string;
  persist?: (patch: Partial<CalendarReminderConfigSection>) => void;
  now?: () => number;
  /** 可选注入，用于测试或自定义源。 */
  syncSources?: (windowStartMs: number, windowEndMs: number) => Promise<{
    events: CalendarEvent[];
    calendars?: DiscoveredCalendar[];
    reports: SyncSourceReport[];
  }>;
  /** 可选注入，用于测试写入日历。 */
  writeEvent?: (calendarId: string, event: NewIcsEventInput) => Promise<void>;
}

export const CALENDAR_TOOL_DECLS: ReadonlyArray<Omit<ToolDef, 'handler'>> = [
  {
    name: 'calendar_list',
    description: 'List upcoming and currently active calendar events synced from system calendar or CalDAV.',
    tags: ['read'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: {
          type: 'number',
          description: 'Maximum number of events to return (default 20).',
        },
      },
    },
  },
  {
    name: 'calendar_sync',
    description: 'Immediately sync calendar events from system calendar and CalDAV subscriptions.',
    tags: ['write'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: 'calendar_ack',
    description: 'Acknowledge and mute further interval reminders for a specific calendar event.',
    tags: ['write'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        event: {
          type: 'string',
          description: 'Event key, uid, or title keyword from calendar_list.',
        },
      },
      required: ['event'],
    },
  },
  {
    name: 'calendar_add',
    description: 'Create a new calendar event in the user-selected writable calendar(s). Use ONLY when the user explicitly asks to add to a calendar or schedule a calendar event (NOT for general alarms/reminders).',
    tags: ['write'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: {
          type: 'string',
          description: 'Title/summary of the calendar event.',
        },
        start: {
          type: 'string',
          description: 'Start time in ISO 8601 with timezone offset, e.g. 2026-11-21T14:00:00+08:00.',
        },
        end: {
          type: 'string',
          description: 'Optional end time in ISO 8601 with timezone offset; omit for a point event.',
        },
        location: {
          type: 'string',
          description: 'Optional event location.',
        },
        description: {
          type: 'string',
          description: 'Optional event notes or description.',
        },
        all_day: {
          type: 'boolean',
          description: 'Whether this is an all-day event.',
        },
      },
      required: ['title', 'start'],
    },
  },
];

function clip(text: string): string {
  return text.length > MAX_TITLE ? `${text.slice(0, MAX_TITLE)}…` : text;
}

function intervalModeLabel(mode: IntervalRemindMode): string {
  switch (mode) {
    case 'daily':
      return '每天提醒一次';
    case 'hourly':
      return '每小时提醒一次';
    case 'every_15m':
      return '每15分钟提醒一次';
    case 'once':
    default:
      return '只提醒一次';
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : '未知错误';
}

export class CalendarReminderWorld implements World {
  readonly id = 'calendar-reminder';

  private host: WorldHost | undefined;
  private tickTimer: ReturnType<typeof setInterval> | undefined;
  private greetTimer: ReturnType<typeof setTimeout> | undefined;
  private inflightSync: Promise<{ events: CalendarEvent[]; reports: SyncSourceReport[] }> | undefined;
  private lastAttemptAt: number | undefined;
  private lastAttemptFailed = false;
  private lastReports: SyncSourceReport[] = [];
  private storeQueue: Promise<void> = Promise.resolve();
  private dueQueue: Promise<DueNotification[]> = Promise.resolve([]);

  constructor(private readonly opts: CalendarReminderWorldOptions) {}

  private withStoreLock<T>(fn: () => Promise<T> | T): Promise<T> {
    const run = this.storeQueue.then(fn, fn);
    this.storeQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  private syncIntervalMs(): number {
    const mins = Number.isFinite(this.opts.cfg.syncIntervalMinutes)
      ? Math.max(1, Math.min(1440, Math.round(this.opts.cfg.syncIntervalMinutes)))
      : 15;
    return mins * 60_000;
  }

  envPromptVars(): Record<string, string> {
    const now = this.now();
    const { file } = readStore(this.opts.dataDir);
    const active = upcomingOrActiveEvents(file, now, this.opts.cfg.disabledCalendars);
    const next = active[0];
    return {
      'calendar.now': formatLocal(now, this.opts.timezone),
      'calendar.summary': active.length === 0
        ? '近期没有待提醒日程'
        : `当前有 ${active.length} 条近期或进行中日程（区间策略：${intervalModeLabel(this.opts.cfg.intervalMode)}）`,
      'calendar.next': next
        ? `${clip(next.title)} (${formatEventTime(next.startMs, next.endMs, this.opts.timezone)}, ${humanizeDelta(next.startMs - now)})`
        : '没有下一条日程',
    };
  }

  tools(): ToolDef[] {
    return [
      this.listTool(),
      this.syncTool(),
      this.ackTool(),
      this.addTool(),
    ];
  }

  private buildPanelState(): CalendarPanelState {
    const { file } = readStore(this.opts.dataDir);
    const disabled = new Set(this.opts.cfg.disabledCalendars ?? []);
    const writableSet = new Set(this.opts.cfg.writableCalendars ?? []);
    const calendars: CalendarPanelItem[] = file.calendars.map((c) => {
      const canWrite = c.writable ?? (c.source !== 'ics');
      return {
        ...c,
        enabled: !disabled.has(c.id),
        writable: canWrite,
        allowWrite: canWrite && writableSet.has(c.id),
      };
    });
    const lastSyncText = file.lastSyncAt
      ? `上次同步：${formatLocal(file.lastSyncAt, this.opts.timezone)}`
      : '尚未同步';
    const errors = this.lastReports
      .filter((r) => Boolean(r.error))
      .map((r) => `${r.source}: ${r.error}`);
    return { lastSyncText, calendars, errors };
  }

  webUi(): WorldWebUiDecl {
    const now = this.now();
    const { file } = readStore(this.opts.dataDir);
    const active = upcomingOrActiveEvents(file, now, this.opts.cfg.disabledCalendars);
    const lastSyncText = file.lastSyncAt
      ? `上次同步：${formatLocal(file.lastSyncAt, this.opts.timezone)}`
      : '尚未同步';
    const errorCount = this.lastReports.filter((r) => Boolean(r.error)).length;

    return {
      badges: [
        { label: '近期日程', value: active.length, tone: active.length > 0 ? 'on' : 'plain' },
        { label: '同步频率', value: `${Math.max(1, Math.round(this.opts.cfg.syncIntervalMinutes || 15))}m`, tone: 'plain' },
      ],
      lamps: [
        {
          label: '日历调度',
          state: this.tickTimer ? 'online' : 'offline',
          hint: this.tickTimer
            ? `每 15 秒检查到期日程；${lastSyncText}${errorCount > 0 ? `（${errorCount} 个源异常）` : ''}。`
            : 'World 未激活，不会主动同步或提醒。',
        },
      ],
      panels: [{ id: 'calendars', title: '日历选择与同步', getMethods: ['state'] }],
      invoke: async (panel, method, args) => {
        if (panel !== 'calendars') throw new Error(`Unknown panel: ${panel}`);
        if (method === 'state') {
          return this.buildPanelState();
        }
        if (method === 'sync') {
          await this.syncNow();
          await this.checkAndPushDue();
          return this.buildPanelState();
        }
        if (method === 'toggle') {
          const calId = typeof args[0] === 'string' ? args[0] : '';
          const enabled = Boolean(args[1]);
          if (!calId) throw new Error('Missing calendar id');
          const next = new Set(this.opts.cfg.disabledCalendars ?? []);
          if (enabled) next.delete(calId);
          else next.add(calId);
          const disabledCalendars = [...next];
          this.opts.cfg.disabledCalendars = disabledCalendars;
          this.opts.persist?.({ disabledCalendars });
          return this.buildPanelState();
        }
        if (method === 'toggleWrite') {
          const calId = typeof args[0] === 'string' ? args[0] : '';
          const allowWrite = Boolean(args[1]);
          if (!calId) throw new Error('Missing calendar id');
          const next = new Set(this.opts.cfg.writableCalendars ?? []);
          if (allowWrite) next.add(calId);
          else next.delete(calId);
          const writableCalendars = [...next];
          this.opts.cfg.writableCalendars = writableCalendars;
          this.opts.persist?.({ writableCalendars });
          return this.buildPanelState();
        }
        throw new Error(`Unknown method: ${method}`);
      },
      config: [CALENDAR_REMINDER_CONFIG_GROUP],
      promptDocs: [
        {
          key: 'worlds.calendar-reminder.envPrompt',
          title: '日历提醒 · 环境提示词',
          description: '日历提醒 World 进 system 前缀的那一段。',
          path: ENV_PROMPT_FILE,
          role: 'envPrompt',
          vars: [
            { name: 'calendar.now', description: '部署时区的当前时间。' },
            { name: 'calendar.summary', description: '近期日程数量与当前区间提醒策略。' },
            { name: 'calendar.next', description: '最近一条日程的标题、时间与剩余时间。' },
          ],
        },
      ],
    };
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    const { file, recovered } = readStore(this.opts.dataDir);
    if (recovered) {
      host.log.warn(`日历存储读取失败，已重建：${this.opts.dataDir}/calendar-reminder`);
    }

    this.tickTimer = setInterval(() => {
      void this.tick().catch((err: unknown) => host.log.warn(`日历扫描失败: ${describeError(err)}`));
    }, TICK_MS);
    this.tickTimer.unref?.();

    // 启动时先同步一次日历
    await this.syncNow().catch((err: unknown) => host.log.warn(`日历初始同步失败: ${describeError(err)}`));

    const afterSync = readStore(this.opts.dataDir).file;
    const active = upcomingOrActiveEvents(afterSync, this.now(), this.opts.cfg.disabledCalendars);
    try {
      await this.greet(host, active);
    } catch (err: unknown) {
      host.log.info(`就绪事件没投出去，2 秒后补投: ${describeError(err)}`);
      this.greetTimer = setTimeout(() => {
        const latest = upcomingOrActiveEvents(readStore(this.opts.dataDir).file, this.now(), this.opts.cfg.disabledCalendars);
        void this.greet(host, latest).catch(() => undefined);
      }, 2000);
      this.greetTimer.unref?.();
    }

    await this.checkAndPushDue().catch((err: unknown) => host.log.warn(`日历提醒检查失败: ${describeError(err)}`));
  }

  async stop(): Promise<void> {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = undefined;
    if (this.greetTimer) clearTimeout(this.greetTimer);
    this.greetTimer = undefined;
    this.host = undefined;
  }

  private async greet(host: WorldHost, active: CalendarEvent[]): Promise<void> {
    const text = active.length === 0
      ? '日历提醒 World 已挂载，当前近期没有待提醒日程。'
      : `日历提醒 World 已挂载，近期有 ${active.length} 条日程，最近一条是「${clip(active[0]!.title)}」(${formatEventTime(active[0]!.startMs, active[0]!.endMs, this.opts.timezone)})。`;
    await host.pushEvent(
      {
        type: 'calendar.ready',
        ts: nowIso(this.opts.timezone),
        source: this.id,
        origin: 'internal',
        senderKey: this.id,
        text,
      },
      { trigger: 'flush' },
    );
  }

  /** 周期心跳：按热改的 syncIntervalMinutes 判断是否需要同步，然后检查到期提醒。 */
  async tick(): Promise<void> {
    const now = this.now();
    const { file } = readStore(this.opts.dataDir);
    const refTime = this.lastAttemptAt ?? file.lastSyncAt;
    const elapsed = refTime === undefined ? Infinity : now - refTime;
    const interval = this.lastAttemptFailed
      ? Math.min(this.syncIntervalMs(), 60_000)
      : this.syncIntervalMs();
    if (elapsed >= interval && !this.inflightSync) {
      await this.syncNow();
    }
    await this.checkAndPushDue();
  }

  /** 执行一次日历同步并落盘；若有并发同步正在进行，先等待其结束后再按最新配置执行一次同步。 */
  async syncNow(): Promise<{ events: CalendarEvent[]; reports: SyncSourceReport[] }> {
    while (this.inflightSync) {
      await this.inflightSync.catch(() => undefined);
    }
    const run = this.runSyncNow();
    this.inflightSync = run;
    try {
      return await run;
    } finally {
      if (this.inflightSync === run) {
        this.inflightSync = undefined;
      }
    }
  }

  private async runSyncNow(): Promise<{ events: CalendarEvent[]; reports: SyncSourceReport[] }> {
    const now = this.now();
    this.lastAttemptAt = now;
    const lookaheadDays = Number.isFinite(this.opts.cfg.lookaheadDays)
      ? Math.max(1, Math.min(30, Math.round(this.opts.cfg.lookaheadDays)))
      : 7;
    // 回看 1 天以覆盖跨天或正在进行中的区间日程
    const windowStartMs = now - 24 * 60 * 60_000;
    const windowEndMs = now + lookaheadDays * 24 * 60 * 60_000;

    const { file } = readStore(this.opts.dataDir);
    let events: CalendarEvent[];
    let calendars: DiscoveredCalendar[];
    let reports: SyncSourceReport[];
    let anyError = false;
    const currentCaldavUrl = normalizeCaldavUrl(this.opts.cfg.caldavUrl);
    const currentCaldavUsername = this.opts.cfg.caldavUsername.trim();
    let caldavSucceeded = false;

    if (this.opts.syncSources) {
      const res = await this.opts.syncSources(windowStartMs, windowEndMs);
      reports = res.reports;
      anyError = reports.some((r) => Boolean(r.error));
      if (anyError) {
        events = file.events;
        calendars = file.calendars;
      } else {
        events = res.events;
        calendars = res.calendars ?? [];
        caldavSucceeded = Boolean(currentCaldavUrl);
      }
    } else {
      const [sysRes, caldavRes] = await Promise.all([
        syncSystemCalendars({
          systemCalendarEnabled: this.opts.cfg.systemCalendarEnabled,
          localIcsPaths: this.opts.cfg.localIcsPaths,
          windowStartMs,
          windowEndMs,
          defaultTimezone: this.opts.timezone,
        }),
        syncCaldavAndSubscriptions({
          urlsRaw: this.opts.cfg.caldavUrl,
          username: this.opts.cfg.caldavUsername,
          password: this.opts.cfg.caldavPassword,
          windowStartMs,
          windowEndMs,
          defaultTimezone: this.opts.timezone,
        }),
      ]);
      const sysFailed = sysRes.reports.some((r) => Boolean(r.error));
      const caldavFailed = caldavRes.reports.some((r) => Boolean(r.error));
      anyError = sysFailed || caldavFailed;
      caldavSucceeded = !caldavFailed && Boolean(currentCaldavUrl);
      const caldavChanged = (file.lastCaldavUrl !== undefined && file.lastCaldavUrl !== currentCaldavUrl)
        || (file.lastCaldavUsername !== undefined && file.lastCaldavUsername !== currentCaldavUsername);

      const keptSysEvents = sysFailed ? file.events.filter((e) => e.source === 'system') : sysRes.events;
      const keptSysCals = sysFailed ? file.calendars.filter((c) => c.source === 'system') : sysRes.calendars;
      const keptCaldavEvents = (caldavFailed && !caldavChanged && currentCaldavUrl)
        ? file.events.filter((e) => e.source === 'caldav' || e.source === 'ics')
        : caldavRes.events;
      const keptCaldavCals = (caldavFailed && !caldavChanged && currentCaldavUrl)
        ? file.calendars.filter((c) => c.source === 'caldav' || c.source === 'ics')
        : caldavRes.calendars;

      const dedup = new Map<string, CalendarEvent>();
      for (const ev of [...keptSysEvents, ...keptCaldavEvents]) dedup.set(ev.key, ev);
      events = [...dedup.values()].sort((a, b) => a.startMs - b.startMs);

      const calDedup = new Map<string, DiscoveredCalendar>();
      for (const c of [...keptSysCals, ...keptCaldavCals]) calDedup.set(c.id, c);
      calendars = [...calDedup.values()];
      reports = [...sysRes.reports, ...caldavRes.reports];
    }

    this.lastAttemptFailed = anyError;
    this.lastReports = reports;
    for (const rep of reports) {
      if (rep.error) {
        this.host?.log.warn(`日历源同步异常 [${rep.source}]: ${rep.error}`);
      }
    }

    // 迁移 1.1.0 旧版 system:<name>（含分组 ID）到新的稳定 ID（支持相对路径与 ~/ 解析）
    const home = homedir();
    const customPathPrefixes = splitPathList(this.opts.cfg.localIcsPaths).map((p) => (
      (p.startsWith('~/') ? join(home, p.slice(2)) : resolve(p)).replace(/\/+$/, '')
    ));
    const isCustomLocalCal = (calId: string) => customPathPrefixes.some((clean) => (
      calId === `system:file:${clean}`
      || calId === `system:dir:${clean}`
      || calId.startsWith(`system:file:${clean}/`)
    ));
    const migrateIds = (ids: string[] | undefined): { next: string[]; changed: boolean } => {
      if (!ids || ids.length === 0) return { next: [], changed: false };
      let changed = false;
      const out = new Set<string>();
      for (const id of ids) {
        if (id.startsWith('system:')
          && !id.startsWith('system:file:')
          && !id.startsWith('system:dir:')
          && !id.startsWith('system:mac:')
          && !id.startsWith('system:outlook:')
          && !id.startsWith('system:winrt:')) {
          const legacyName = id.slice('system:'.length);
          let matches: DiscoveredCalendar[] = [];
          if (legacyName === '本地 ICS') {
            matches = calendars.filter((c) => c.source === 'system' && isCustomLocalCal(c.id));
          } else if (legacyName === 'Linux 系统日历') {
            matches = calendars.filter((c) => c.source === 'system' && !isCustomLocalCal(c.id));
          } else {
            matches = calendars.filter((c) => c.source === 'system' && c.name === legacyName);
          }
          if (matches.length > 0) {
            for (const m of matches) out.add(m.id);
            changed = true;
            continue;
          }
        }
        out.add(id);
      }
      return { next: [...out], changed };
    };
    const migratedDisabled = migrateIds(this.opts.cfg.disabledCalendars);
    const migratedWritable = migrateIds(this.opts.cfg.writableCalendars);
    if (migratedDisabled.changed || migratedWritable.changed) {
      if (migratedDisabled.changed) this.opts.cfg.disabledCalendars = migratedDisabled.next;
      if (migratedWritable.changed) this.opts.cfg.writableCalendars = migratedWritable.next;
      this.opts.persist?.({
        ...(migratedDisabled.changed ? { disabledCalendars: migratedDisabled.next } : {}),
        ...(migratedWritable.changed ? { writableCalendars: migratedWritable.next } : {}),
      });
    }

    // 仅在 storeLock 内重读最新 states 并合并，避免覆盖并发投递的提醒状态；旧版事件状态键仅消费一次
    await this.withStoreLock(() => {
      const latest = readStore(this.opts.dataDir).file;
      for (const ev of events) {
        if (!latest.states[ev.key]) {
          const legacyKey = `${ev.source}:${ev.uid}:${ev.startMs}`;
          if (latest.states[legacyKey]) {
            latest.states[ev.key] = { ...latest.states[legacyKey]! };
            delete latest.states[legacyKey];
          }
        }
      }
      latest.events = events;
      latest.calendars = calendars;
      if (caldavSucceeded) {
        latest.lastCaldavUrl = currentCaldavUrl;
        latest.lastCaldavUsername = currentCaldavUsername;
      } else if (!currentCaldavUrl) {
        delete latest.lastCaldavUrl;
        delete latest.lastCaldavUsername;
      }
      if (!anyError) {
        latest.lastSyncAt = now;
      }
      pruneStates(latest, now);
      writeStore(this.opts.dataDir, latest);
    });
    return { events, reports };
  }

  /** 检查到期提醒并逐条推送；串行化执行，仅在单条投递成功后才落盘。 */
  async checkAndPushDue(): Promise<DueNotification[]> {
    const run = this.dueQueue.then(() => this.runCheckAndPushDue(), () => this.runCheckAndPushDue());
    this.dueQueue = run.catch(() => []);
    return run;
  }

  private async runCheckAndPushDue(): Promise<DueNotification[]> {
    const host = this.host;
    if (!host) return [];
    const now = this.now();
    const due = await this.withStoreLock(() => {
      const { file } = readStore(this.opts.dataDir);
      return evaluateDueNotifications(file, now, {
        intervalMode: this.opts.cfg.intervalMode,
        notifyOnEnd: this.opts.cfg.notifyOnEnd,
        disabledCalendars: this.opts.cfg.disabledCalendars,
      });
    });
    if (due.length === 0) return [];

    const delivered: DueNotification[] = [];
    const pushOpts: PushOptions = { trigger: this.opts.cfg.trigger };
    for (const item of due) {
      const { event } = item;
      const timeRange = formatEventTime(event.startMs, event.endMs, this.opts.timezone);
      const locationPart = event.location ? `，地点：${event.location}` : '';
      const sourcePart = event.calendarName ? ` [${event.calendarName}]` : '';

      try {
        if (item.kind === 'interval_end') {
          await host.pushEvent(
            {
              type: 'calendar.ended',
              ts: nowIso(this.opts.timezone),
              source: this.id,
              origin: 'internal',
              senderKey: this.id,
              text: `区间日程时间到了（已结束）：「${clip(event.title)}」（${timeRange}${locationPart}）${sourcePart}。`,
              meta: {
                eventKey: event.key,
                uid: event.uid,
                kind: item.kind,
                startMs: event.startMs,
                endMs: event.endMs,
              },
            },
            pushOpts,
          );
        } else {
          const prefix = item.kind === 'point'
            ? '日程提醒'
            : item.kind === 'interval_start'
              ? '区间日程开始'
              : `区间日程持续提醒（第 ${item.firedCount} 次）`;
          const hint = isIntervalEvent(event) && this.opts.cfg.intervalMode !== 'once'
            ? '；如需停止本条区间重复提醒可调用 calendar_ack。'
            : '。';
          await host.pushEvent(
            {
              type: 'calendar.due',
              ts: nowIso(this.opts.timezone),
              source: this.id,
              origin: 'internal',
              senderKey: this.id,
              text: `${prefix}：「${clip(event.title)}」（${timeRange}${locationPart}）${sourcePart}${hint}`,
              meta: {
                eventKey: event.key,
                uid: event.uid,
                kind: item.kind,
                firedCount: item.firedCount,
                startMs: event.startMs,
                endMs: event.endMs,
              },
            },
            pushOpts,
          );
        }
        await this.withStoreLock(() => {
          const latest = readStore(this.opts.dataDir).file;
          applyNotifications(latest, [item], now);
          writeStore(this.opts.dataDir, latest);
        });
        delivered.push(item);
      } catch (error) {
        host.log.warn(`日历提醒投递失败（将在下轮重试）[${clip(event.title)}]: ${describeError(error)}`);
      }
    }

    return delivered;
  }

  private listTool(): ToolDef {
    return {
      ...CALENDAR_TOOL_DECLS[0]!,
      handler: async (args) => {
        const now = this.now();
        const limit = typeof args.limit === 'number' && Number.isFinite(args.limit)
          ? Math.max(1, Math.min(50, Math.round(args.limit)))
          : MAX_LIST;
        const { file } = readStore(this.opts.dataDir);
        const list = upcomingOrActiveEvents(file, now, this.opts.cfg.disabledCalendars);
        if (list.length === 0) {
          return '当前近期没有待提醒日程。';
        }
        const lines = [`近期与进行中日程（共 ${list.length} 条）：`];
        for (const ev of list.slice(0, limit)) {
          const kindLabel = isIntervalEvent(ev) ? '区间' : '点任务';
          const status = ev.startMs <= now && ev.endMs > now ? '进行中' : humanizeDelta(ev.startMs - now);
          const loc = ev.location ? ` @ ${ev.location}` : '';
          lines.push(`- [${kindLabel}] ${clip(ev.title)} | ${formatEventTime(ev.startMs, ev.endMs, this.opts.timezone)} (${status})${loc} [key:${ev.key}]`);
        }
        if (list.length > limit) {
          lines.push(`…还有 ${list.length - limit} 条未列出。`);
        }
        return lines.join('\n');
      },
    };
  }

  private syncTool(): ToolDef {
    return {
      ...CALENDAR_TOOL_DECLS[1]!,
      handler: async () => {
        const { events, reports } = await this.syncNow();
        await this.checkAndPushDue();
        const summary = reports.length === 0
          ? '未启用任何日历源（请在配置中开启系统日历或填写 CalDAV 地址）。'
          : reports.map((r) => (r.error ? `${r.source}: 失败(${r.error})` : `${r.source}: ${r.count} 条`)).join('；');
        return `日历同步完成，共缓存 ${events.length} 条日程。来源明细：${summary}`;
      },
    };
  }

  private ackTool(): ToolDef {
    return {
      ...CALENDAR_TOOL_DECLS[2]!,
      handler: async (args) => {
        const query = typeof args.event === 'string' ? args.event.trim() : '';
        if (!query) return '请提供要静默的日程 key、uid 或标题关键词。';
        const matched = await this.withStoreLock(() => {
          const { file } = readStore(this.opts.dataDir);
          const hit = ackEvent(file, query);
          if (hit) writeStore(this.opts.dataDir, file);
          return hit;
        });
        if (!matched) return `未找到匹配的日程「${query}」，可用 calendar_list 查看。`;
        return `已静默日程「${clip(matched.title)}」(${formatEventTime(matched.startMs, matched.endMs, this.opts.timezone)}) 的后续区间重复提醒。`;
      },
    };
  }

  private addTool(): ToolDef {
    return {
      ...CALENDAR_TOOL_DECLS[3]!,
      handler: async (args) => {
        const targets = this.opts.cfg.writableCalendars ?? [];
        if (targets.length === 0) {
          return '未写入：尚未勾选任何可写入的目标日历，请先在日历提醒的「日历选择与同步」面板中勾选「写入」复选框。';
        }
        const title = typeof args.title === 'string' ? args.title.trim() : '';
        if (!title) return '未写入：日程标题不能为空。';

        const startRaw = typeof args.start === 'string' ? args.start.trim() : '';
        if (!startRaw || !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/.test(startRaw)) {
          return '未写入：start 必须是带时区偏移的 ISO 8601 时间，例如 2026-11-21T14:00:00+08:00。';
        }
        const startMs = Date.parse(startRaw);
        if (!Number.isFinite(startMs)) return `未写入：start 不是合法时间（${startRaw}）。`;

        let endMs = startMs;
        if (typeof args.end === 'string' && args.end.trim()) {
          const endRaw = args.end.trim();
          if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/.test(endRaw)) {
            return '未写入：end 必须是带时区偏移的 ISO 8601 时间，例如 2026-11-21T15:00:00+08:00。';
          }
          const parsedEnd = Date.parse(endRaw);
          if (!Number.isFinite(parsedEnd)) return `未写入：end 不是合法时间（${endRaw}）。`;
          if (parsedEnd < startMs) return '未写入：结束时间不能早于开始时间。';
          endMs = parsedEnd;
        }

        // 写入前按当前配置刷新并校验目标日历是否仍然存在且可写
        if (!this.opts.syncSources) {
          await this.syncNow().catch(() => undefined);
        }

        const eventInput: NewIcsEventInput = {
          uid: `coopanion-${randomUUID()}`,
          title,
          startMs,
          endMs,
          allDay: args.all_day === true,
          location: typeof args.location === 'string' ? args.location.trim() || undefined : undefined,
          description: typeof args.description === 'string' ? args.description.trim() || undefined : undefined,
          timezone: this.opts.timezone,
        };

        const { file } = readStore(this.opts.dataDir);
        const calMap = new Map(file.calendars.map((c) => [c.id, c]));
        const okList: string[] = [];
        const errList: string[] = [];

        for (const calId of targets) {
          const discovered = calMap.get(calId);
          const label = discovered?.name ?? calId;
          try {
            if (!discovered || discovered.writable === false) {
              throw new Error('该日历已从当前配置移除或不支持写入');
            }
            if (calId.startsWith('caldav:')) {
              const configured = normalizeCaldavUrl(this.opts.cfg.caldavUrl);
              if (!configured) {
                throw new Error('CalDAV 地址已清空');
              }
              if (file.lastCaldavUrl !== configured || (file.lastCaldavUsername ?? '') !== this.opts.cfg.caldavUsername.trim()) {
                throw new Error('CalDAV 配置或账号已变更，请重新同步并勾选当前账号下的日历');
              }
              if (this.opts.writeEvent) {
                await this.opts.writeEvent(calId, eventInput);
              } else {
                await writeCaldavEvent({
                  calendarId: calId,
                  username: this.opts.cfg.caldavUsername,
                  password: this.opts.cfg.caldavPassword,
                  event: eventInput,
                });
              }
            } else if (calId.startsWith('system:')) {
              if (this.opts.writeEvent) {
                await this.opts.writeEvent(calId, eventInput);
              } else {
                await writeSystemCalendarEvent({
                  calendarId: calId,
                  event: eventInput,
                });
              }
            } else {
              throw new Error('只读日历不支持写入');
            }
            okList.push(label);
          } catch (error) {
            errList.push(`${label}: ${describeError(error)}`);
          }
        }

        if (okList.length > 0) {
          await this.syncNow().catch(() => undefined);
        }

        if (errList.length === 0) {
          return `已写入日历（${okList.join('、')}）：「${clip(title)}」(${formatEventTime(startMs, endMs, this.opts.timezone)})。`;
        }
        if (okList.length > 0) {
          return `部分写入成功（${okList.join('、')}），失败：${errList.join('；')}。`;
        }
        return `写入日历失败：${errList.join('；')}。`;
      },
    };
  }
}
