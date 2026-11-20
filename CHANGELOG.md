# Changelog

## 1.1.0 (2026-11-20)

- 新增写入日历功能：`calendar_add` 工具支持向已勾选的可写日历（CalDAV / 系统日历 / 本地 ICS）写入新日程。
- WebUI「日历选择与同步」面板新增「写入」复选框，可单独控制允许写入的目标日历（只读 ICS 订阅自动禁用写入）。
- 优化 `ENV_PROMPT.md` 提示词约束：明确区分「闹钟/一般提醒」与「日历/日程」，仅在用户明确要求日历或日程时才调用 `calendar_add`。

## 1.0.0 (2026-11-20)

- 初始正式版本发布。
- 支持从系统日历（Linux / Windows / macOS）与本地 `.ics` 路径提取日程。
- 支持 CalDAV（含 `PROPFIND` 自动发现、`calendar-query` + `calendar-multiget` 两步拉取、`/.well-known/caldav` 回退）及 `.ics` / `webcal://` / `caldav://` / `webdav://` 订阅（支持省略 `https://`）。
- 区分点任务（单次提醒）与区间任务（支持只提醒一次 / 每天 / 每小时 / 每 15 分钟），支持区间结束时提醒开关（`notifyOnEnd`）与自定义同步频率（`syncIntervalMinutes`）。
- 新增 WebUI「日历选择与同步」面板，支持多日历复选框启停与手动立即同步。
- 支持深色 / 浅色双主题 SVG 图标。
