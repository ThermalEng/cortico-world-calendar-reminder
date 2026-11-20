/** 时间解析、时区转换与人类可读格式化工具。 */

const WINDOWS_TO_IANA: Record<string, string> = {
  'China Standard Time': 'Asia/Shanghai',
  'Taipei Standard Time': 'Asia/Taipei',
  'Tokyo Standard Time': 'Asia/Tokyo',
  'Korea Standard Time': 'Asia/Seoul',
  'Singapore Standard Time': 'Asia/Singapore',
  'UTC': 'UTC',
  'Coordinated Universal Time': 'UTC',
  'GMT Standard Time': 'Europe/London',
  'W. Europe Standard Time': 'Europe/Berlin',
  'Central European Standard Time': 'Europe/Warsaw',
  'Romance Standard Time': 'Europe/Paris',
  'Eastern Standard Time': 'America/New_York',
  'Central Standard Time': 'America/Chicago',
  'Mountain Standard Time': 'America/Denver',
  'Pacific Standard Time': 'America/Los_Angeles',
  'AUS Eastern Standard Time': 'Australia/Sydney',
};

/** 规范化时区名；不合法时回退到 fallbackTimezone。 */
export function resolveTimezone(raw: string | undefined, fallbackTimezone: string): string {
  const candidate = raw?.trim().replace(/^"|"$/g, '') ?? '';
  const mapped = WINDOWS_TO_IANA[candidate] ?? candidate;
  if (mapped) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: mapped });
      return mapped;
    } catch {
      // Ignore unknown TZID and fall back.
    }
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: fallbackTimezone });
    return fallbackTimezone;
  } catch {
    return 'UTC';
  }
}

/** 把某时区下的墙钟时间转换为 UTC 毫秒时间戳（支持 DST 两次校准）。 */
export function zonedToEpochMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string,
): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const partsToUtc = (ms: number): number => {
    const parts = fmt.formatToParts(new Date(ms));
    const map: Record<string, number> = {};
    for (const p of parts) {
      if (p.type !== 'literal') map[p.type] = Number(p.value);
    }
    const h = map.hour === 24 ? 0 : (map.hour ?? 0);
    return Date.UTC(map.year ?? year, (map.month ?? month) - 1, map.day ?? day, h, map.minute ?? minute, map.second ?? second);
  };

  const targetUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  let guess = targetUtc;
  for (let i = 0; i < 2; i++) {
    const observed = partsToUtc(guess);
    const diff = targetUtc - observed;
    if (diff === 0) break;
    guess += diff;
  }
  return guess;
}

/** 用部署时区把毫秒时间点显示成 YYYY-MM-DD HH:mm。 */
export function formatLocal(ms: number, timezone: string): string {
  const tz = resolveTimezone(timezone, 'UTC');
  const fmt = new Intl.DateTimeFormat('sv-SE', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return fmt.format(new Date(ms)).replace('T', ' ');
}

/** 格式化区间或时间点：点任务只显示开始时间，区间任务显示 start ~ end。 */
export function formatEventTime(startMs: number, endMs: number, timezone: string): string {
  const startStr = formatLocal(startMs, timezone);
  if (endMs <= startMs) return startStr;
  const endStr = formatLocal(endMs, timezone);
  if (startStr.slice(0, 10) === endStr.slice(0, 10)) {
    return `${startStr} ~ ${endStr.slice(11)}`;
  }
  return `${startStr} ~ ${endStr}`;
}

/** 人类可读的剩余时间；已到点给「已到点」。 */
export function humanizeDelta(ms: number): string {
  if (ms <= 0) return '已到点';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return '不到 1 分钟后';
  if (minutes < 60) return `${minutes} 分钟后`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest === 0 ? `${hours} 小时后` : `${hours} 小时 ${rest} 分钟后`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours === 0 ? `${days} 天后` : `${days} 天 ${restHours} 小时后`;
}
