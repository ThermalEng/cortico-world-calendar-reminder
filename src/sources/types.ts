/** 统一日历事件模型与数据源接口。 */

export type CalendarSourceKind = 'system' | 'caldav' | 'ics';

export interface CalendarEvent {
  /** 稳定去重键：`<source>:<uid>:<occurrenceStartMs>` */
  key: string;
  /** 原始事件 UID */
  uid: string;
  /** 所属日历 ID（用于复选框启用/停用过滤） */
  calendarId: string;
  /** 日程标题 */
  title: string;
  /** 日程备注 / 描述 */
  description?: string;
  /** 地点 */
  location?: string;
  /** 来源类型 */
  source: CalendarSourceKind;
  /** 来源标签（如 "系统日历" / "CalDAV" / 日历名） */
  calendarName?: string;
  /** 开始时间（UTC 毫秒） */
  startMs: number;
  /** 结束时间（UTC 毫秒）；若 <= startMs 则视为点任务 */
  endMs: number;
  /** 是否全天日程 */
  allDay: boolean;
}

export interface DiscoveredCalendar {
  id: string;
  name: string;
  source: CalendarSourceKind;
  count: number;
}

/** 判断是否为区间任务（结束时间严格晚于开始时间）。 */
export function isIntervalEvent(event: Pick<CalendarEvent, 'startMs' | 'endMs'>): boolean {
  return event.endMs > event.startMs;
}

export interface SyncSourceReport {
  source: string;
  count: number;
  error?: string;
}
