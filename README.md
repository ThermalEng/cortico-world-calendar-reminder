# cortico-world-calendar-reminder（日历提醒）

为 Coopanion / Cortico 开发的跨平台日历提醒 World 插件。支持从**系统日历（Linux / Windows / macOS）**与 **CalDAV / ICS 订阅**提取日程，并在到点时主动唤醒会话提醒。

## 功能特性

- **三端系统日历提取**：
  - **macOS**：通过 JXA 调用 `EventKit`（`EKEventStore`）读取系统日历。
  - **Windows**：通过 PowerShell 读取 WinRT `AppointmentManager`（Windows 日历）及已运行的经典 Outlook COM 日历。
  - **Linux**：自动扫描 Evolution / GNOME Calendar、KDE KOrganizer、vdirsyncer / khal 等标准 `.ics` 日历目录，并支持自定义本地 `.ics` 路径。
- **CalDAV / ICS 订阅**：
  - 支持标准 CalDAV（`REPORT calendar-query` 及 `PROPFIND` 自动发现）以及 `.ics` / `webcal://` 订阅链接。
- **点任务 vs 区间任务**：
  - **点任务**（无结束时间或起止时间相同）：到点只提醒一次。
  - **区间任务**（`end > start`）：支持配置提醒频率：
    - `once`：只提醒一次
    - `daily`：每天提醒一次
    - `hourly`：每小时提醒一次
    - `every_15m`：每 15 分钟提醒一次
  - **结束时提醒开关**（`notifyOnEnd`）：区间任务到达结束时间时提醒一次「时间到了」。
- **自定义同步频率**：支持通过 `syncIntervalMinutes` 自定义同步间隔（分钟），全部配置均支持热改。

## 开发与测试

```bash
npm install
npm run typecheck
npm test
```
