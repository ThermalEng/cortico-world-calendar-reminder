import type { ConfigGroup } from 'cortico/core/types.ts';

/** 到点提醒的投递方式;含义见 PushOptions.trigger。 */
export type CalendarTrigger = 'flush' | 'preempt' | 'interrupt';

/**
 * 区间任务（start < end）的提醒频率策略：
 * - once: 只在开始时提醒一次
 * - daily: 开始时提醒，之后在区间内每天提醒一次
 * - hourly: 开始时提醒，之后在区间内每小时提醒一次
 * - every_15m: 开始时提醒，之后在区间内每 15 分钟提醒一次
 */
export type IntervalRemindMode = 'once' | 'daily' | 'hourly' | 'every_15m';

/** config.json 的 worlds.calendar-reminder 段。 */
export interface CalendarReminderConfigSection {
  enabled: boolean;
  /** 到点提醒的投递方式，热改。 */
  trigger: CalendarTrigger;
  /** 区间任务提醒频率，热改。 */
  intervalMode: IntervalRemindMode;
  /** 区间任务结束时是否提醒时间到了，热改。 */
  notifyOnEnd: boolean;
  /** 日历同步频率（分钟），热改。 */
  syncIntervalMinutes: number;
  /** 是否读取系统日历（Linux / Windows / macOS），热改。 */
  systemCalendarEnabled: boolean;
  /** 额外本地 .ics 文件或目录路径，逗号或换行分隔，热改。 */
  localIcsPaths: string;
  /** 单个 CalDAV 服务器/日历地址或 .ics/webcal 订阅链接，热改。 */
  caldavUrl: string;
  /** CalDAV 用户名，热改。 */
  caldavUsername: string;
  /** CalDAV 密码或应用专用密码，热改。 */
  caldavPassword: string;
  /** 向前同步的天数窗口，热改。 */
  lookaheadDays: number;
  /** 在面板中取消勾选的日历 ID 列表，热改。 */
  disabledCalendars: string[];
  /** 在面板中勾选允许写入的日历 ID 列表，热改。 */
  writableCalendars: string[];
}

export const CALENDAR_REMINDER_DEFAULTS: CalendarReminderConfigSection = {
  enabled: false,
  trigger: 'flush',
  intervalMode: 'once',
  notifyOnEnd: true,
  syncIntervalMinutes: 15,
  systemCalendarEnabled: true,
  localIcsPaths: '',
  caldavUrl: '',
  caldavUsername: '',
  caldavPassword: '',
  lookaheadDays: 7,
  disabledCalendars: [],
  writableCalendars: [],
};

/** 区间提醒频率对应的毫秒间隔；once 返回 0。 */
export function intervalModeMs(mode: IntervalRemindMode): number {
  switch (mode) {
    case 'daily':
      return 24 * 60 * 60 * 1000;
    case 'hourly':
      return 60 * 60 * 1000;
    case 'every_15m':
      return 15 * 60 * 1000;
    case 'once':
    default:
      return 0;
  }
}

/** World 配置的 JSON Schema 声明。 */
export const CALENDAR_REMINDER_CONFIG_GROUP: ConfigGroup = {
  id: 'world:calendar-reminder',
  owner: 'world:calendar-reminder',
  schema: {
    type: 'object',
    title: '日历提醒',
    properties: {
      'worlds.calendar-reminder.intervalMode': {
        type: 'string',
        title: '区间任务提醒选项',
        description: '点任务只提醒一次；有起止区间的日程可选择：只提醒一次 / 每天提醒一次 / 每小时提醒一次 / 每15分钟提醒一次。',
        enum: ['once', 'daily', 'hourly', 'every_15m'],
        'x-hot': true,
      },
      'worlds.calendar-reminder.notifyOnEnd': {
        type: 'boolean',
        title: '区间任务结束时提醒',
        description: '开启后，区间任务到达结束时间时会提醒一次「时间到了」。',
        'x-hot': true,
      },
      'worlds.calendar-reminder.syncIntervalMinutes': {
        type: 'number',
        title: '日历同步频率（分钟）',
        description: '每隔多少分钟从系统日历与 CalDAV 同步一次日程（1 ~ 1440）。',
        minimum: 1,
        maximum: 1440,
        'x-hot': true,
      },
      'worlds.calendar-reminder.systemCalendarEnabled': {
        type: 'boolean',
        title: '启用系统日历',
        description: '自动从本机系统日历提取日程（支持 Linux / Windows / macOS）。',
        'x-hot': true,
      },
      'worlds.calendar-reminder.localIcsPaths': {
        type: 'string',
        title: '本地 ICS 路径（可选）',
        description: '额外扫描的本地 .ics 文件或目录路径，多个用逗号或换行分隔。',
        'x-hot': true,
      },
      'worlds.calendar-reminder.caldavUrl': {
        type: 'string',
        title: 'CalDAV / ICS 订阅地址',
        description: '支持 CalDAV、webcal、webdav、ics 地址（可省略 https://）。',
        'x-hot': true,
      },
      'worlds.calendar-reminder.caldavUsername': {
        type: 'string',
        title: 'CalDAV 用户名',
        description: 'CalDAV 认证用户名（公开 ICS 订阅可留空）。',
        'x-hot': true,
      },
      'worlds.calendar-reminder.caldavPassword': {
        type: 'string',
        title: 'CalDAV 密码 / 应用密码',
        description: 'CalDAV 认证密码或应用专用密码。',
        'x-hot': true,
      },
      'worlds.calendar-reminder.lookaheadDays': {
        type: 'number',
        title: '同步未来天数',
        description: '每次同步拉取未来多少天内的日程（1 ~ 30）。',
        minimum: 1,
        maximum: 30,
        'x-hot': true,
      },
      'worlds.calendar-reminder.trigger': {
        type: 'string',
        title: '到点投递方式',
        description: 'flush 等当前一轮结束；preempt 取消尚未产出的模型轮；interrupt 直接停当前轮。',
        enum: ['flush', 'preempt', 'interrupt'],
        'x-hot': true,
      },
    },
  },
};
