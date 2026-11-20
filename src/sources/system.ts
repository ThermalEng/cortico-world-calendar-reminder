/**
 * 跨平台系统日历提取（Linux / Windows / macOS）与本地 .ics 路径读写。
 * 纯 Node.js >=22 实现，不依赖原生 C++ 插件，三端开箱可用。
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, readdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { buildIcsCalendar, buildVEventBlock, parseIcs, type NewIcsEventInput } from '../ics.ts';
import type { CalendarEvent, DiscoveredCalendar, SyncSourceReport } from './types.ts';

const execFileAsync = promisify(execFile);
const CMD_TIMEOUT_MS = 20_000;

/** 按文件路径串行化本地 .ics 的读-改-写，防止并发写入丢日程。 */
const fileWriteLocks = new Map<string, Promise<void>>();

async function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const prev = fileWriteLocks.get(filePath) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((r) => { release = r; });
  const tail = prev.then(() => next);
  fileWriteLocks.set(filePath, tail);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (fileWriteLocks.get(filePath) === tail) {
      fileWriteLocks.delete(filePath);
    }
  }
}

async function writeFileAtomic(targetPath: string, content: string): Promise<void> {
  let finalTarget = targetPath;
  let existingMode: number | undefined;
  if (existsSync(targetPath)) {
    finalTarget = await realpath(targetPath);
    existingMode = (await stat(finalTarget)).mode & 0o777;
  }
  const tmp = join(
    dirname(finalTarget),
    `.${basename(finalTarget)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  await writeFile(tmp, content, 'utf8');
  if (existingMode !== undefined) {
    await chmod(tmp, existingMode);
  }
  await rename(tmp, finalTarget);
}

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

function extractCalName(icsText: string, fallbackName: string): string {
  const m = /^X-WR-CALNAME(?:;[^:]*)?:(.+)$/im.exec(icsText);
  if (m && m[1]?.trim()) return m[1].trim();
  return fallbackName;
}

function friendlyIcsDisplayName(filePath: string, icsText: string, sourceLabel: string): string {
  const base = basename(filePath, '.ics');
  const fallback = base && base !== 'calendar' && base !== 'std' ? base : sourceLabel;
  if (filePath.includes('evolution/calendar')) return extractCalName(icsText, 'Evolution 本地日历');
  if (filePath.includes('korganizer')) return extractCalName(icsText, 'KOrganizer 本地日历');
  return extractCalName(icsText, fallback);
}

async function readIcsFiles(
  paths: string[],
  opts: SystemCalendarOptions,
  sourceLabel: string,
  groupCustomDirs = false,
): Promise<{ events: CalendarEvent[]; calendars: DiscoveredCalendar[]; report: SyncSourceReport }> {
  const seenFiles = new Set<string>();
  const fileEntries: Array<{ file: string; dirId?: string; dirName?: string }> = [];
  const dirCalendars = new Map<string, DiscoveredCalendar>();

  for (const p of paths) {
    const resolved = p.startsWith('~/') ? join(opts.homeDir ?? homedir(), p.slice(2)) : resolve(p);
    let isDir = false;
    try {
      isDir = (await stat(resolved)).isDirectory();
    } catch {
      continue;
    }
    const found = await collectIcsFiles(resolved);
    if (isDir && groupCustomDirs) {
      const dirId = `system:dir:${resolved}`;
      const dirName = basename(resolved) || sourceLabel;
      if (!dirCalendars.has(dirId)) {
        dirCalendars.set(dirId, { id: dirId, name: dirName, source: 'system', count: 0, writable: true });
      }
      for (const file of found) {
        if (!seenFiles.has(file)) {
          seenFiles.add(file);
          fileEntries.push({ file, dirId, dirName });
        }
      }
    } else {
      for (const file of found) {
        if (!seenFiles.has(file)) {
          seenFiles.add(file);
          fileEntries.push({ file });
        }
      }
    }
  }

  const events: CalendarEvent[] = [];
  const calendars: DiscoveredCalendar[] = [...dirCalendars.values()];

  for (const entry of fileEntries) {
    try {
      const content = await readFile(entry.file, 'utf8');
      const calId = entry.dirId ?? `system:file:${entry.file}`;
      const calName = entry.dirName ?? friendlyIcsDisplayName(entry.file, content, sourceLabel);
      const parsed = parseIcs(content, {
        windowStartMs: opts.windowStartMs,
        windowEndMs: opts.windowEndMs,
        defaultTimezone: opts.defaultTimezone,
        source: 'system',
        calendarId: calId,
        calendarName: calName,
      });
      events.push(...parsed);
      if (entry.dirId) {
        const dirCal = dirCalendars.get(entry.dirId);
        if (dirCal) dirCal.count += parsed.length;
      } else {
        calendars.push({
          id: calId,
          name: calName,
          source: 'system',
          count: parsed.length,
          writable: true,
        });
      }
    } catch {
      // Skip unreadable individual ICS file.
    }
  }

  return { events, calendars, report: { source: sourceLabel, count: events.length } };
}

/** macOS: 通过 JXA 调用 EventKit (EKEventStore) 读取系统日历与完整日历列表。 */
async function readMacSystemCalendar(
  opts: SystemCalendarOptions,
): Promise<{ events: CalendarEvent[]; calendars: DiscoveredCalendar[]; report: SyncSourceReport }> {
  const jxa = `
ObjC.import('EventKit');
ObjC.import('Foundation');

function run() {
  var store = $.EKEventStore.alloc.init;
  var status = $.EKEventStore.authorizationStatusForEntityType($.EKEntityTypeEvent);
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
      return JSON.stringify({ error: 'macOS 日历权限未授予，请在「系统设置 -> 隐私与安全性 -> 日历」中允许访问。', events: [], calendars: [] });
    }
  } else if (status === 1 || status === 2 || status === 4) {
    return JSON.stringify({ error: 'macOS 日历权限被拒绝，请在「系统设置 -> 隐私与安全性 -> 日历」中允许访问。', events: [], calendars: [] });
  }

  var calendars = [];
  var ekCals = store.calendarsForEntityType($.EKEntityTypeEvent);
  var calCount = ekCals ? ekCals.count : 0;
  for (var c = 0; c < calCount; c++) {
    var cal = ekCals.objectAtIndex(c);
    var cid = cal.calendarIdentifier ? ObjC.unwrap(cal.calendarIdentifier) : ('cal-' + c);
    calendars.push({
      id: 'system:mac:' + cid,
      name: cal.title ? ObjC.unwrap(cal.title) : 'macOS 日历',
      writable: Boolean(cal.allowsContentModifications)
    });
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
    var evCalId = ev.calendar && ev.calendar.calendarIdentifier ? ('system:mac:' + ObjC.unwrap(ev.calendar.calendarIdentifier)) : 'system:mac:default';
    out.push({
      uid: ev.eventIdentifier ? ObjC.unwrap(ev.eventIdentifier) : ('mac-' + i + '-' + startMs),
      calendarId: evCalId,
      title: ev.title ? ObjC.unwrap(ev.title) : '（无标题日程）',
      description: ev.notes ? ObjC.unwrap(ev.notes) : undefined,
      location: ev.location ? ObjC.unwrap(ev.location) : undefined,
      calendarName: ev.calendar && ev.calendar.title ? ObjC.unwrap(ev.calendar.title) : 'macOS 日历',
      startMs: startMs,
      endMs: endMs,
      allDay: Boolean(ev.allDay)
    });
  }
  return JSON.stringify({ events: out, calendars: calendars });
}
`;
  try {
    const { stdout } = await execFileAsync('osascript', ['-l', 'JavaScript', '-e', jxa], {
      timeout: CMD_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    });
    const parsed = JSON.parse(stdout.trim() || '{}') as {
      error?: string;
      calendars?: Array<{ id: string; name: string; writable: boolean }>;
      events?: Array<{
        uid: string;
        calendarId: string;
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
      return { events: [], calendars: [], report: { source: 'macOS 系统日历', count: 0, error: parsed.error } };
    }
    const events: CalendarEvent[] = (parsed.events ?? []).map((ev) => ({
      key: `${ev.calendarId}:${ev.uid}:${ev.startMs}`,
      uid: ev.uid,
      calendarId: ev.calendarId,
      title: ev.title || '（无标题日程）',
      description: ev.description,
      location: ev.location,
      source: 'system',
      calendarName: ev.calendarName ?? 'macOS 日历',
      startMs: ev.startMs,
      endMs: ev.endMs,
      allDay: ev.allDay,
    }));
    const counts = new Map<string, number>();
    for (const ev of events) counts.set(ev.calendarId, (counts.get(ev.calendarId) ?? 0) + 1);
    const calendars: DiscoveredCalendar[] = (parsed.calendars ?? []).map((c) => ({
      id: c.id,
      name: c.name,
      source: 'system',
      count: counts.get(c.id) ?? 0,
      writable: c.writable,
    }));
    return { events, calendars, report: { source: 'macOS 系统日历', count: events.length } };
  } catch (error) {
    return {
      events: [],
      calendars: [],
      report: {
        source: 'macOS 系统日历',
        count: 0,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

const WINDOWS_READ_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$utf8 = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8

$events = [System.Collections.Generic.List[object]]::new()
$calendars = [System.Collections.Generic.List[object]]::new()
$startUtc = [DateTimeOffset]::Parse($env:COOPANION_CAL_START)
$hours = [int]$env:COOPANION_CAL_HOURS
$endUtc = $startUtc.AddHours($hours)

# 1) WinRT Windows.ApplicationModel.Appointments (只读展示)
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
    $findOp = $store.FindAppointmentsAsync($startUtc, [TimeSpan]::FromHours($hours))
    $appts = Await-WinRT $findOp ([System.Collections.Generic.IReadOnlyList[Windows.ApplicationModel.Appointments.Appointment]])
    $seenWinRt = @{}
    foreach ($a in $appts) {
      $cid = if ($a.CalendarId) { "system:winrt:" + [string]$a.CalendarId } else { "system:winrt:default" }
      if (-not $seenWinRt.ContainsKey($cid)) {
        $seenWinRt[$cid] = $true
        $calendars.Add([pscustomobject]@{ id = $cid; name = 'Windows 日历'; writable = $false })
      }
      $sMs = [long]$a.StartTime.ToUnixTimeMilliseconds()
      $eMs = $sMs + [long]$a.Duration.TotalMilliseconds
      $events.Add([pscustomobject]@{
        uid = if ($a.LocalId) { [string]$a.LocalId } else { "winrt-$sMs" }
        calendarId = $cid
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

# 2) Classic Outlook COM (支持读取与按 Folder EntryID 写入)
try {
  $outlook = [Runtime.InteropServices.Marshal]::GetActiveObject('Outlook.Application')
  if ($outlook) {
    $ns = $outlook.GetNamespace('MAPI')
    $cal = $ns.GetDefaultFolder(9)
    $folderId = if ($cal.EntryID) { "system:outlook:" + [string]$cal.EntryID } else { "system:outlook:default" }
    $folderName = if ($cal.Name) { "Outlook · " + [string]$cal.Name } else { "Outlook 日历" }
    $calendars.Add([pscustomobject]@{ id = $folderId; name = $folderName; writable = $true })
    $items = $cal.Items
    $items.IncludeRecurrences = $true
    $items.Sort('[Start]')
    $filter = "[Start] >= '" + $startUtc.LocalDateTime.ToString('g') + "' AND [Start] <= '" + $endUtc.LocalDateTime.ToString('g') + "'"
    $restricted = $items.Restrict($filter)
    foreach ($it in $restricted) {
      $sMs = [long]([DateTimeOffset]::new($it.Start)).ToUnixTimeMilliseconds()
      $eMs = [long]([DateTimeOffset]::new($it.End)).ToUnixTimeMilliseconds()
      $events.Add([pscustomobject]@{
        uid = if ($it.GlobalAppointmentID) { [string]$it.GlobalAppointmentID } elseif ($it.EntryID) { [string]$it.EntryID } else { "outlook-$sMs" }
        calendarId = $folderId
        title = if ($it.Subject) { [string]$it.Subject } else { '（无标题日程）' }
        description = if ($it.Body) { [string]$it.Body } else { $null }
        location = if ($it.Location) { [string]$it.Location } else { $null }
        calendarName = $folderName
        startMs = $sMs
        endMs = $eMs
        allDay = [bool]$it.AllDayEvent
      })
    }
  }
} catch {}

[pscustomobject]@{ calendars = @($calendars); events = @($events) } | ConvertTo-Json -Depth 5 -Compress
`;

/** Windows: 通过固定 PowerShell 脚本读取 WinRT 与 Outlook COM 日历。 */
async function readWindowsSystemCalendar(
  opts: SystemCalendarOptions,
): Promise<{ events: CalendarEvent[]; calendars: DiscoveredCalendar[]; report: SyncSourceReport }> {
  const startIso = new Date(opts.windowStartMs).toISOString();
  const hours = Math.max(1, Math.ceil((opts.windowEndMs - opts.windowStartMs) / 3_600_000));
  const encoded = Buffer.from(WINDOWS_READ_SCRIPT, 'utf16le').toString('base64');
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded],
      {
        timeout: CMD_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, COOPANION_CAL_START: startIso, COOPANION_CAL_HOURS: String(hours) },
      },
    );
    const trimmed = stdout.trim();
    if (!trimmed) {
      return { events: [], calendars: [], report: { source: 'Windows 系统日历', count: 0 } };
    }
    const raw = JSON.parse(trimmed) as {
      calendars?: Array<{ id: string; name: string; writable: boolean }>;
      events?: Array<{
        uid: string;
        calendarId: string;
        title: string;
        description?: string | null;
        location?: string | null;
        calendarName?: string;
        startMs: number;
        endMs: number;
        allDay: boolean;
      }>;
    };
    const events: CalendarEvent[] = (Array.isArray(raw.events) ? raw.events : []).map((ev) => ({
      key: `${ev.calendarId}:${ev.uid}:${ev.startMs}`,
      uid: ev.uid,
      calendarId: ev.calendarId,
      title: ev.title || '（无标题日程）',
      description: ev.description ?? undefined,
      location: ev.location ?? undefined,
      source: 'system',
      calendarName: ev.calendarName ?? 'Windows 日历',
      startMs: ev.startMs,
      endMs: ev.endMs,
      allDay: Boolean(ev.allDay),
    }));
    const counts = new Map<string, number>();
    for (const ev of events) counts.set(ev.calendarId, (counts.get(ev.calendarId) ?? 0) + 1);
    const calendars: DiscoveredCalendar[] = (Array.isArray(raw.calendars) ? raw.calendars : []).map((c) => ({
      id: c.id,
      name: c.name,
      source: 'system',
      count: counts.get(c.id) ?? 0,
      writable: Boolean(c.writable),
    }));
    return { events, calendars, report: { source: 'Windows 系统日历', count: events.length } };
  } catch (error) {
    return {
      events: [],
      calendars: [],
      report: {
        source: 'Windows 系统日历',
        count: 0,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/** Linux: 读取 Evolution/GNOME、KDE/KOrganizer、vdirsyncer/khal 等标准本地 .ics 目录。 */
async function readLinuxSystemCalendar(
  opts: SystemCalendarOptions,
): Promise<{ events: CalendarEvent[]; calendars: DiscoveredCalendar[]; report: SyncSourceReport }> {
  const home = opts.homeDir ?? homedir();
  const standardDirs = [
    join(home, '.local/share/evolution/calendar'),
    join(home, '.local/share/korganizer'),
    join(home, '.local/share/apps/korganizer'),
    join(home, '.local/share/calendars'),
    join(home, '.calendars'),
  ];
  return readIcsFiles(standardDirs, opts, 'Linux 系统日历', false);
}

/** 统一入口：按平台提取系统日历 + 额外本地 ICS 路径，并去重合并。 */
export async function syncSystemCalendars(opts: SystemCalendarOptions): Promise<SystemCalendarResult> {
  const events: CalendarEvent[] = [];
  const calendars = new Map<string, DiscoveredCalendar>();
  const reports: SyncSourceReport[] = [];
  const platform = opts.platform ?? process.platform;

  if (opts.systemCalendarEnabled) {
    let res: { events: CalendarEvent[]; calendars: DiscoveredCalendar[]; report: SyncSourceReport };
    if (platform === 'darwin') {
      res = await readMacSystemCalendar(opts);
    } else if (platform === 'win32') {
      res = await readWindowsSystemCalendar(opts);
    } else {
      res = await readLinuxSystemCalendar(opts);
    }
    events.push(...res.events);
    for (const c of res.calendars) calendars.set(c.id, c);
    reports.push(res.report);
  }

  const customPaths = splitPathList(opts.localIcsPaths);
  if (customPaths.length > 0) {
    const customRes = await readIcsFiles(customPaths, opts, '本地 ICS', true);
    events.push(...customRes.events);
    for (const c of customRes.calendars) calendars.set(c.id, c);
    reports.push(customRes.report);
  }

  const dedup = new Map<string, CalendarEvent>();
  for (const ev of events) dedup.set(ev.key, ev);
  return { events: [...dedup.values()], calendars: [...calendars.values()], reports };
}

const MAC_WRITE_JXA = `
ObjC.import('EventKit');
ObjC.import('Foundation');

function run() {
  var env = $.NSProcessInfo.processInfo.environment;
  var raw = env.objectForKey('COOPANION_CAL_EVENT_JSON');
  if (!raw || raw.isNil()) return JSON.stringify({ error: '缺少事件参数' });
  var data = JSON.parse(ObjC.unwrap(raw));
  var store = $.EKEventStore.alloc.init;
  var cal = store.calendarWithIdentifier(data.calendarIdentifier);
  if (!cal || cal.isNil()) {
    return JSON.stringify({ error: '未找到指定 macOS 日历：' + data.calendarIdentifier });
  }
  if (!cal.allowsContentModifications) {
    return JSON.stringify({ error: '指定的 macOS 日历为只读，无法写入' });
  }
  var ev = $.EKEvent.eventWithEventStore(store);
  ev.title = data.title;
  ev.startDate = $.NSDate.dateWithTimeIntervalSince1970(data.startMs / 1000);
  ev.endDate = $.NSDate.dateWithTimeIntervalSince1970(Math.max(data.startMs, data.endMs) / 1000);
  ev.allDay = Boolean(data.allDay);
  if (data.location) ev.location = data.location;
  if (data.description) ev.notes = data.description;
  ev.calendar = cal;
  var err = Ref();
  var ok = store.saveEventSpanCommitError(ev, $.EKSpanThisEvent, true, err);
  if (!ok) return JSON.stringify({ error: err[0] ? ObjC.unwrap(err[0].localizedDescription) : 'macOS 写入日历失败' });
  return JSON.stringify({ ok: true });
}
`;

const WINDOWS_WRITE_SCRIPT = `
$ErrorActionPreference = 'Stop'
$json = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:COOPANION_CAL_EVENT_B64))
$data = $json | ConvertFrom-Json
$outlook = [Runtime.InteropServices.Marshal]::GetActiveObject('Outlook.Application')
if (-not $outlook) { throw '当前未运行经典 Outlook 客户端，无法写入日历' }
$ns = $outlook.GetNamespace('MAPI')
if ($data.folderId -eq 'default') {
  $cal = $ns.GetDefaultFolder(9)
} else {
  $cal = $ns.GetFolderFromID($data.folderId)
}
if (-not $cal) { throw ('未找到指定的 Outlook 日历：' + $data.folderId) }
$appt = $cal.Items.Add(1)
$appt.Subject = [string]$data.title
$appt.Start = ([DateTimeOffset]::FromUnixTimeMilliseconds([long]$data.startMs)).LocalDateTime
$appt.Duration = [int]$data.durationMin
$appt.AllDayEvent = [bool]$data.allDay
if ($data.location) { $appt.Location = [string]$data.location }
if ($data.description) { $appt.Body = [string]$data.description }
$appt.Save()
`;

/** 将新日程写入指定 ID 的系统日历（严格匹配 calendarId，找不到直接报错，不静默回退）。 */
export async function writeSystemCalendarEvent(opts: {
  calendarId: string;
  event: NewIcsEventInput;
  platform?: NodeJS.Platform;
}): Promise<void> {
  const platform = opts.platform ?? process.platform;

  if (opts.calendarId.startsWith('system:file:')) {
    const targetFile = opts.calendarId.slice('system:file:'.length);
    if (!targetFile.toLowerCase().endsWith('.ics') || !existsSync(targetFile)) {
      throw new Error(`找不到目标本地 ICS 文件：${targetFile}`);
    }
    const realTarget = await realpath(targetFile);
    await withFileLock(realTarget, async () => {
      const content = await readFile(realTarget, 'utf8');
      const endIdx = content.lastIndexOf('END:VCALENDAR');
      const vevent = buildVEventBlock(opts.event);
      const updated = endIdx >= 0
        ? `${content.slice(0, endIdx).replace(/\s*$/, '')}\r\n${vevent}\r\nEND:VCALENDAR\r\n`
        : buildIcsCalendar(opts.event);
      await writeFileAtomic(realTarget, updated);
    });
    return;
  }

  if (opts.calendarId.startsWith('system:dir:')) {
    const targetDir = opts.calendarId.slice('system:dir:'.length);
    if (!existsSync(targetDir) || !(await stat(targetDir)).isDirectory()) {
      throw new Error(`找不到目标本地日历目录：${targetDir}`);
    }
    const targetFile = join(targetDir, `${opts.event.uid}.ics`);
    await writeFileAtomic(targetFile, buildIcsCalendar(opts.event));
    return;
  }

  if (platform === 'darwin' && opts.calendarId.startsWith('system:mac:')) {
    const calIdentifier = opts.calendarId.slice('system:mac:'.length);
    const payload = JSON.stringify({
      calendarIdentifier: calIdentifier,
      title: opts.event.title,
      startMs: opts.event.startMs,
      endMs: opts.event.endMs,
      allDay: Boolean(opts.event.allDay),
      location: opts.event.location ?? '',
      description: opts.event.description ?? '',
    });
    const { stdout } = await execFileAsync('osascript', ['-l', 'JavaScript', '-e', MAC_WRITE_JXA], {
      timeout: CMD_TIMEOUT_MS,
      env: { ...process.env, COOPANION_CAL_EVENT_JSON: payload },
    });
    const parsed = JSON.parse(stdout.trim() || '{}') as { ok?: boolean; error?: string };
    if (!parsed.ok) throw new Error(parsed.error ?? 'macOS 写入日历失败');
    return;
  }

  if (platform === 'win32' && opts.calendarId.startsWith('system:outlook:')) {
    const folderId = opts.calendarId.slice('system:outlook:'.length);
    const payload = Buffer.from(JSON.stringify({
      folderId,
      title: opts.event.title,
      startMs: opts.event.startMs,
      durationMin: Math.max(0, Math.round((opts.event.endMs - opts.event.startMs) / 60_000)),
      allDay: Boolean(opts.event.allDay),
      location: opts.event.location ?? '',
      description: opts.event.description ?? '',
    }), 'utf8').toString('base64');
    const encoded = Buffer.from(WINDOWS_WRITE_SCRIPT, 'utf16le').toString('base64');
    await execFileAsync(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded],
      {
        timeout: CMD_TIMEOUT_MS,
        env: { ...process.env, COOPANION_CAL_EVENT_B64: payload },
      },
    );
    return;
  }

  throw new Error(`该系统日历不支持写入或目标无法解析：${opts.calendarId}`);
}
