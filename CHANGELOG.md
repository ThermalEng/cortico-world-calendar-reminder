# Changelog

## 1.0.0 (2026-11-20)

- 初始正式版本发布。
- 支持从系统日历（Linux / Windows / macOS）与本地 `.ics` 路径提取日程。
- 支持 CalDAV（含 `PROPFIND` 自动发现、`calendar-query` + `calendar-multiget` 两步拉取、`/.well-known/caldav` 回退）及 `.ics` / `webcal://` / `caldav://` / `webdav://` 订阅（支持省略 `https://`）。
- 区分点任务（单次提醒）与区间任务（支持只提醒一次 / 每天 / 每小时 / 每 15 分钟），支持区间结束时提醒开关（`notifyOnEnd`）与自定义同步频率（`syncIntervalMinutes`）。
- 新增 WebUI「日历选择与同步」面板，支持多日历复选框启停与手动立即同步。
- 支持深色 / 浅色双主题 SVG 图标。
