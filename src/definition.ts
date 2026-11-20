import { describeTools, type WorldDefinition } from 'cortico/world.ts';
import { CALENDAR_REMINDER_DEFAULTS, type CalendarReminderConfigSection } from './config.ts';
import { CALENDAR_TOOL_DECLS, CalendarReminderWorld } from './world.ts';

export const CALENDAR_REMINDER: WorldDefinition<CalendarReminderConfigSection> = {
  id: 'calendar-reminder',
  label: '日历提醒',
  defaults: () => ({ ...CALENDAR_REMINDER_DEFAULTS }),
  create: (ctx) => new CalendarReminderWorld({
    cfg: ctx.cfg,
    timezone: ctx.timezone,
    dataDir: ctx.dataDir,
    persist: (patch) => ctx.persist(patch),
  }),
  describe: {
    tools: describeTools(CALENDAR_TOOL_DECLS, {
      calendar_list: {
        zh: '按时间顺序列出近期与进行中的日历事件。',
        en: 'List upcoming and active calendar events in chronological order.',
      },
      calendar_sync: {
        zh: '立即从系统日历与 CalDAV 订阅同步日程。',
        en: 'Immediately sync calendar events from OS calendar and CalDAV subscriptions.',
      },
      calendar_ack: {
        zh: '静默指定区间日程的后续重复提醒。',
        en: 'Mute further interval reminders for a specific calendar event.',
      },
      calendar_add: {
        zh: '向已勾选的可写日历写入一条新日程（仅在用户明确要求写入日历/日程时使用，普通提醒请用闹钟）。',
        en: 'Write a new event to selected writable calendar(s) (use only when explicitly asked for a calendar/schedule event).',
      },
    }),
    events: [
      {
        type: 'calendar.ready',
        description: {
          zh: '日历提醒 World 挂载并完成首次同步，附带近期日程摘要。',
          en: 'Calendar Reminder World mounted and completed initial sync.',
        },
      },
      {
        type: 'calendar.due',
        description: {
          zh: '点任务到点，或区间任务开始/按设定频率重复提醒。',
          en: 'A point event came due, or an interval event started/repeated.',
        },
      },
      {
        type: 'calendar.ended',
        description: {
          zh: '开启结束提醒时，区间任务到达结束时间。',
          en: 'An interval event reached its end time (when notifyOnEnd is enabled).',
        },
      },
    ],
  },
};
