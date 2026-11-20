/** 包入口：默认导出 `WorldDefinition`，加载器按 `cortico.kind === 'world'` 识别。 */
import { CALENDAR_REMINDER } from './definition.ts';

export default CALENDAR_REMINDER;
export { CALENDAR_REMINDER };
export type { CalendarReminderConfigSection, CalendarTrigger, IntervalRemindMode } from './config.ts';
export { CalendarReminderWorld } from './world.ts';
