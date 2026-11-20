/**
 * 跨平台系统日历提取（Linux / Windows / macOS）与本地 .ics 路径扫描。
 * 纯 Node.js >=22 实现，不依赖原生 C++ 插件，三端开箱可用。
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { buildIcsCalendar, buildVEventBlock, parseIcs, type NewIcsEventInput } from '../ics.ts';
import type { CalendarEvent, DiscoveredCalendar, SyncSourceReport } from './types.ts';

const execFileAsync = promisify(execFile);
const CMD_TIMEOUT_MS = 20_000;

export interface SystemCalendarOptions {
  systemCalendarEnabled: boolean;
  localIcsPaths: string;
  windowStartMs: number;
  windowEndMs: number;
  defaultTimezone: string;
  platform?: NodeJS.Platform;
  homeDir?: string;
}

export interface SystemCalendarResult {
  events: CalendarEvent[];
  calendars: DiscoveredCalendar[];
  reports: SyncSourceReport[];
}

export function splitPathList(raw: string): string[] {
  return raw
    .split(/[\n,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 递归收集路径下的 .ics 文件（最多 3 层，防止大目录卡顿）。 */
async function collectIcsFiles(targetPath: string, depth = 0): Promise<string[]> {
  if (depth > 3) return [];
  let st;
  try {
    st = await stat(targetPath);
  } catch {
    return [];
  }
  if (st.isFile()) {
    return targetPath.toLowerCase().endsWith('.ics') ? [targetPath] : [];
  }
  if (!st.isDirectory()) return [];
  let entries;
  try {
    entries = await readdir(targetPath, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(targetPath, entry.name);
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.ics')) {
      files.push(full);
    } else if (entry.isDirectory() && !entry.name.startsWith('.')) {
      files.push(...await collectIcsFiles(full, depth + 1));
    }
  }
  return files;
}

async function readIcsFiles(
  paths: string[],
  opts: SystemCalendarOptions,
  sourceLabel: string,
): Promise<{ events: CalendarEvent[]; report: SyncSourceReport }> {
  const seenFiles = new Set<string>();
  const allFiles: string[] = [];
  for (const p of paths) {
    const resolved = p.startsWith('~/') ? join(opts.homeDir ?? homedir(), p.slice(2)) : resolve(p);
    for (const file of await collectIcsFiles(resolved)) {
      if (!seenFiles.has(file)) {
        seenFiles.add(file);
        allFiles.push(file);
      }
    }
  }
  const events: CalendarEvent[] = [];
  for (const file of allFiles) {
    try {
      const content = await readFile(file, 'utf8');
      events.push(...parseIcs(content, {
        windowStartMs: opts.windowStartMs,
        windowEndMs: opts.windowEndMs,
        defaultTimezone: opts.defaultTimezone,
        source: 'system',
        calendarName: sourceLabel,
      }));
    } catch {
      // Skip unreadable individual ICS file.
    }
  }
  return { events, report: { source: sourceLabel, count: events.length } };
}

/** macOS: 通过 JXA 调用 EventKit (EKEventStore) 读取系统日历。 */
async function readMacSystemCalendar(opts: SystemCalendarOptions): Promise<{ events: CalendarEvent[]; report: SyncSourceReport }> {
  const jxa = `
ObjC.import('EventKit');
ObjC.import('Foundation');

function run() {
  var store = $.EKEventStore.alloc.init;
  var status = $.EKEventStore.authorizationStatusForEntityType($.EKEntityTypeEvent);
  // 0 = NotDetermined, 1 = Restricted, 2 = Denied, 3 = FullAccess/Authorized, 4 = WriteOnly
  if (status === 0) {
    var done = false;
    var granted = false;
    if (store.respondsToSelector('requestFullAccessToEventsWithCompletion:')) {
      store.requestFullAccessToEventsWithCompletion(function(ok) { granted = ok; done = true; });
    } else {
      store.requestAccessToEntityTypeCompletion($.EKEntityTypeEvent, function(ok) { granted = ok; done = true; });
    }
    var deadline = Date.now() + 10000;
    while (!done && Date.now() < deadline) {
      $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.1));
    }
    if (!granted) {
      return JSON.stringify({ error: 'macOS 日历权限未授予，请在「系统设置 -> 隐私与安全性 -> 日历」中允许访问。', events: [] });
    }
  } else if (status === 1 || status === 2 || status === 4) {
    return JSON.stringify({ error: 'macOS 日历权限被拒绝，请在「系统设置 -> 隐私与安全性 -> 日历」中允许访问。', events: [] });
  }

  var start = $.NSDate.dateWithTimeIntervalSince1970(${Math.floor(opts.windowStartMs / 1000)});
  var end = $.NSDate.dateWithTimeIntervalSince1970(${Math.ceil(opts.windowEndMs / 1000)});
  var predicate = store.predicateForEventsWithStartDateEndDateCalendars(start, end, $());
  var ekEvents = store.eventsMatchingPredicate(predicate);
  var out = [];
  var count = ekEvents ? ekEvents.count : 0;
  for (var i = 0; i < count; i++) {
    var ev = ekEvents.objectAtIndex(i);
    var startMs = Math.round(ev.startDate.timeIntervalSince1970 * 1000);
    var endMs = ev.endDate ? Math.round(ev.endDate.timeIntervalSince1970 * 1000) : startMs;
    out.push({
      uid: ev.eventIdentifier ? ObjC.unwrap(ev.eventIdentifier) : ('mac-' + i + '-' + startMs),
      title: ev.title ? ObjC.unwrap(ev.title) : '（无标题日程）',
      description: ev.notes ? ObjC.unwrap(ev.notes) : undefined,
      location: ev.location ? ObjC.unwrap(ev.location) : undefined,
      calendarName: ev.calendar && ev.calendar.title ? ObjC.unwrap(ev.calendar.title) : 'macOS 日历',
      startMs: startMs,
      endMs: endMs,
      allDay: Boolean(ev.allDay)
    });
  }
  return JSON.stringify({ events: out });
}
`;
  try {
    const { stdout } = await execFileAsync('osascript', ['-l', 'JavaScript', '-e', jxa], {
      timeout: CMD_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    });
    const parsed = JSON.parse(stdout.trim() || '{}') as {
      error?: string;
      events?: Array<{
        uid: string;
        title: string;
        description?: string;
        location?: string;
        calendarName?: string;
        startMs: number;
        endMs: number;
        allDay: boolean;
      }>;
    };
    if (parsed.error) {
      return { events: [], report: { source: 'macOS 系统日历', count: 0, error: parsed.error } };
    }
    const events: CalendarEvent[] = (parsed.events ?? []).map((ev) => {
      const calName = ev.calendarName ?? 'macOS 日历';
      return {
        key: `system:${ev.uid}:${ev.startMs}`,
        uid: ev.uid,
        calendarId: `system:${calName}`,
        title: ev.title || '（无标题日程）',
        description: ev.description,
        location: ev.location,
        source: 'system',
        calendarName: calName,
        startMs: ev.startMs,
        endMs: ev.endMs,
        allDay: ev.allDay,
      };
    });
    return { events, report: { source: 'macOS 系统日历', count: events.length } };
  } catch (error) {
    return {
      events: [],
      report: {
        source: 'macOS 系统日历',
        count: 0,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/** Windows: 通过 PowerShell 查询 WinRT AppointmentManager 与经典 Outlook COM 日历。 */
async function readWindowsSystemCalendar(opts: SystemCalendarOptions): Promise<{ events: CalendarEvent[]; report: SyncSourceReport }> {
  const startIso = new Date(opts.windowStartMs).toISOString();
  const hours = Math.max(1, Math.ceil((opts.windowEndMs - opts.windowStartMs) / 3_600_000));
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$utf8 = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8

$results = [System.Collections.Generic.List[object]]::new()
$startUtc = [DateTimeOffset]::Parse('${startIso}')
$endUtc = $startUtc.AddHours(${hours})

# 1) WinRT Windows.ApplicationModel.Appointments (Windows 10/11 系统日历)
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
  $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'
  })[0]
  function Await-WinRT($op, $type) {
    $method = $asTaskGeneric.MakeGenericMethod($type)
    $task = $method.Invoke($null, @($op))
    $task.Wait(10000) | Out-Null
    return $task.Result
  }
  $null = [Windows.ApplicationModel.Appointments.AppointmentManager, Windows.ApplicationModel.Appointments, ContentType=WindowsRuntime]
  $null = [Windows.ApplicationModel.Appointments.AppointmentStore, Windows.ApplicationModel.Appointments, ContentType=WindowsRuntime]
  $null = [Windows.ApplicationModel.Appointments.AppointmentStoreAccessType, Windows.ApplicationModel.Appointments, ContentType=WindowsRuntime]
  $storeOp = [Windows.ApplicationModel.Appointments.AppointmentManager]::RequestStoreAsync([Windows.ApplicationModel.Appointments.AppointmentStoreAccessType]::AllCalendarsReadOnly)
  $store = Await-WinRT $storeOp ([Windows.ApplicationModel.Appointments.AppointmentStore])
  if ($store) {
    $findOp = $store.FindAppointmentsAsync($startUtc, [TimeSpan]::FromHours(${hours}))
    $appts = Await-WinRT $findOp ([System.Collections.Generic.IReadOnlyList[Windows.ApplicationModel.Appointments.Appointment]])
    foreach ($a in $appts) {
      $sMs = [long]$a.StartTime.ToUnixTimeMilliseconds()
      $eMs = $sMs + [long]$a.Duration.TotalMilliseconds
      $results.Add([pscustomobject]@{
        uid = if ($a.LocalId) { [string]$a.LocalId } else { "winrt-$sMs" }
        title = if ($a.Subject) { [string]$a.Subject } else { '（无标题日程）' }
        description = if ($a.Details) { [string]$a.Details } else { $null }
        location = if ($a.Location) { [string]$a.Location } else { $null }
        calendarName = 'Windows 日历'
        startMs = $sMs
        endMs = $eMs
        allDay = [bool]$a.AllDay
      })
    }
  }
} catch {}

# 2) Classic Outlook COM (若已安装且可用)
try {
  $outlook = [Runtime.InteropServices.Marshal]::GetActiveObject('Outlook.Application')
  if ($outlook) {
    $ns = $outlook.GetNamespace('MAPI')
    $cal = $ns.GetDefaultFolder(9)
    $items = $cal.Items
    $items.IncludeRecurrences = $true
    $items.Sort('[Start]')
    $filter = "[Start] >= '" + $startUtc.LocalDateTime.ToString('g') + "' AND [Start] <= '" + $endUtc.LocalDateTime.ToString('g') + "'"
    $restricted = $items.Restrict($filter)
    foreach ($it in $restricted) {
      $sMs = [long]([DateTimeOffset]::new($it.Start)).ToUnixTimeMilliseconds()
      $eMs = [long]([DateTimeOffset]::new($it.End)).ToUnixTimeMilliseconds()
      $results.Add([pscustomobject]@{
        uid = if ($it.GlobalAppointmentID) { [string]$it.GlobalAppointmentID } elseif ($it.EntryID) { [string]$it.EntryID } else { "outlook-$sMs" }
        title = if ($it.Subject) { [string]$it.Subject } else { '（无标题日程）' }
        description = if ($it.Body) { [string]$it.Body } else { $null }
        location = if ($it.Location) { [string]$it.Location } else { $null }
        calendarName = 'Outlook 日历'
        startMs = $sMs
        endMs = $eMs
        allDay = [bool]$it.AllDayEvent
      })
    }
  }
} catch {}

ConvertTo-Json -InputObject @($results) -Depth 4 -Compress
`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded],
      { timeout: CMD_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
    );
    const trimmed = stdout.trim();
    if (!trimmed) {
      return { events: [], report: { source: 'Windows 系统日历', count: 0 } };
    }
    const raw = JSON.parse(trimmed) as Array<{
      uid: string;
      title: string;
      description?: string | null;
      location?: string | null;
      calendarName?: string;
      startMs: number;
      endMs: number;
      allDay: boolean;
    }>;
    const events: CalendarEvent[] = (Array.isArray(raw) ? raw : []).map((ev) => {
      const calName = ev.calendarName ?? 'Windows 日历';
      return {
        key: `system:${ev.uid}:${ev.startMs}`,
        uid: ev.uid,
        calendarId: `system:${calName}`,
        title: ev.title || '（无标题日程）',
        description: ev.description ?? undefined,
        location: ev.location ?? undefined,
        source: 'system',
        calendarName: calName,
        startMs: ev.startMs,
        endMs: ev.endMs,
        allDay: Boolean(ev.allDay),
      };
    });
    return { events, report: { source: 'Windows 系统日历', count: events.length } };
  } catch (error) {
    return {
      events: [],
      report: {
        source: 'Windows 系统日历',
        count: 0,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/** Linux: 读取 Evolution/GNOME、KDE/KOrganizer、vdirsyncer/khal 等标准本地 .ics 目录。 */
async function readLinuxSystemCalendar(opts: SystemCalendarOptions): Promise<{ events: CalendarEvent[]; report: SyncSourceReport }> {
  const home = opts.homeDir ?? homedir();
  const standardDirs = [
    join(home, '.local/share/evolution/calendar'),
    join(home, '.local/share/korganizer'),
    join(home, '.local/share/apps/korganizer'),
    join(home, '.local/share/calendars'),
    join(home, '.calendars'),
  ];
  return readIcsFiles(standardDirs, opts, 'Linux 系统日历');
}

/** 统一入口：按平台提取系统日历 + 额外本地 ICS 路径，并去重合并。 */
export async function syncSystemCalendars(opts: SystemCalendarOptions): Promise<SystemCalendarResult> {
  const events: CalendarEvent[] = [];
  const reports: SyncSourceReport[] = [];
  const platform = opts.platform ?? process.platform;

  if (opts.systemCalendarEnabled) {
    let res: { events: CalendarEvent[]; report: SyncSourceReport };
    if (platform === 'darwin') {
      res = await readMacSystemCalendar(opts);
    } else if (platform === 'win32') {
      res = await readWindowsSystemCalendar(opts);
    } else {
      res = await readLinuxSystemCalendar(opts);
    }
    events.push(...res.events);
    reports.push(res.report);
  }

  const customPaths = splitPathList(opts.localIcsPaths);
  if (customPaths.length > 0) {
    const customRes = await readIcsFiles(customPaths, opts, '本地 ICS');
    events.push(...customRes.events);
    reports.push(customRes.report);
  }

  const dedup = new Map<string, CalendarEvent>();
  for (const ev of events) dedup.set(ev.key, ev);
  const calMap = new Map<string, DiscoveredCalendar>();
  for (const ev of dedup.values()) {
    const existing = calMap.get(ev.calendarId);
    if (existing) existing.count++;
    else calMap.set(ev.calendarId, { id: ev.calendarId, name: ev.calendarName ?? '系统日历', source: 'system', count: 1, writable: true });
  }
  return { events: [...dedup.values()], calendars: [...calMap.values()], reports };
}

/** 将新日程写入系统日历（macOS EventKit / Windows WinRT|Outlook / Linux 本地 .ics）。 */
export async function writeSystemCalendarEvent(opts: {
  calendarId: string;
  localIcsPaths?: string;
  event: NewIcsEventInput;
  platform?: NodeJS.Platform;
  homeDir?: string;
}): Promise<void> {
  const platform = opts.platform ?? process.platform;
  const calName = opts.calendarId.startsWith('system:') ? opts.calendarId.slice('system:'.length) : opts.calendarId;

  if (platform === 'darwin') {
    const jxa = `
ObjC.import('EventKit');
function run() {
  var store = $.EKEventStore.alloc.init;
  var ev = $.EKEvent.eventWithEventStore(store);
  ev.title = ${JSON.stringify(opts.event.title)};
  ev.startDate = $.NSDate.dateWithTimeIntervalSince1970(${opts.event.startMs / 1000});
  ev.endDate = $.NSDate.dateWithTimeIntervalSince1970(${Math.max(opts.event.startMs, opts.event.endMs) / 1000});
  ev.allDay = ${Boolean(opts.event.allDay)};
  ${opts.event.location ? `ev.location = ${JSON.stringify(opts.event.location)};` : ''}
  ${opts.event.description ? `ev.notes = ${JSON.stringify(opts.event.description)};` : ''}
  var targetCal = store.defaultCalendarForNewEvents;
  var cals = store.calendarsForEntityType($.EKEntityTypeEvent);
  for (var i = 0; i < (cals ? cals.count : 0); i++) {
    var c = cals.objectAtIndex(i);
    if (ObjC.unwrap(c.title) === ${JSON.stringify(calName)}) { targetCal = c; break; }
  }
  ev.calendar = targetCal;
  var err = Ref();
  var ok = store.saveEventSpanCommitError(ev, $.EKSpanThisEvent, true, err);
  if (!ok) return JSON.stringify({ error: err[0] ? ObjC.unwrap(err[0].localizedDescription) : 'macOS 写入日历失败' });
  return JSON.stringify({ ok: true });
}`;
    const { stdout } = await execFileAsync('osascript', ['-l', 'JavaScript', '-e', jxa], { timeout: CMD_TIMEOUT_MS });
    const parsed = JSON.parse(stdout.trim() || '{}') as { ok?: boolean; error?: string };
    if (!parsed.ok) throw new Error(parsed.error ?? 'macOS 写入日历失败');
    return;
  }

  if (platform === 'win32') {
    const startIso = new Date(opts.event.startMs).toISOString();
    const durationMin = Math.max(0, Math.round((opts.event.endMs - opts.event.startMs) / 60_000));
    const script = `
$ErrorActionPreference = 'Stop'
$start = [DateTimeOffset]::Parse('${startIso}').LocalDateTime
$title = ${JSON.stringify(opts.event.title)}
$loc = ${JSON.stringify(opts.event.location ?? '')}
$desc = ${JSON.stringify(opts.event.description ?? '')}
try {
  $outlook = [Runtime.InteropServices.Marshal]::GetActiveObject('Outlook.Application')
  if ($outlook) {
    $appt = $outlook.CreateItem(1)
    $appt.Subject = $title
    $appt.Start = $start
    $appt.Duration = ${durationMin}
    $appt.AllDayEvent = $${Boolean(opts.event.allDay)}
    if ($loc) { $appt.Location = $loc }
    if ($desc) { $appt.Body = $desc }
    $appt.Save()
    return
  }
} catch {}
throw '当前未检测到可写入的 Windows Outlook 客户端'
`;
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    await execFileAsync(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded],
      { timeout: CMD_TIMEOUT_MS },
    );
    return;
  }

  // Linux: 写入本地 .ics 文件（优先自定义 localIcsPaths，其次 Evolution / KOrganizer 默认路径）
  const home = opts.homeDir ?? homedir();
  const candidates = [
    ...splitPathList(opts.localIcsPaths ?? '').map((p) => (p.startsWith('~/') ? join(home, p.slice(2)) : resolve(p))),
    join(home, '.local/share/evolution/calendar/system/calendar.ics'),
    join(home, '.local/share/apps/korganizer/std.ics'),
  ];
  for (const target of candidates) {
    if (!existsSync(target)) continue;
    const st = await stat(target);
    if (st.isDirectory()) {
      await writeFile(join(target, `${opts.event.uid}.ics`), buildIcsCalendar(opts.event), 'utf8');
      return;
    }
    if (st.isFile() && target.toLowerCase().endsWith('.ics')) {
      const content = await readFile(target, 'utf8');
      const endIdx = content.lastIndexOf('END:VCALENDAR');
      const vevent = buildVEventBlock(opts.event);
      const updated = endIdx >= 0
        ? `${content.slice(0, endIdx).replace(/\s*$/, '')}\r\n${vevent}\r\nEND:VCALENDAR\r\n`
        : buildIcsCalendar(opts.event);
      await writeFile(target, updated, 'utf8');
      return;
    }
  }
  throw new Error('未找到可写入的本地 Linux 日历 .ics 文件');
}
