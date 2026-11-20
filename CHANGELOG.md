# Changelog

## 1.1.1 (2026-11-20)

- 修复三端系统日历写入目标识别：读写共用稳定日历 ID（Linux `system:file:<path>` / `system:dir:<path>`、macOS `system:mac:<identifier>`、Windows `system:outlook:<entryId>`），目标不可解析时明确报错而不静默回退；并自动迁移 1.1.0 旧版系统日历 ID。
- 修复 Windows PowerShell 与 macOS JXA 写入脚本通过环境变量传参，避免日程文本插值问题。
- 修复本地 `.ics` 并发写入竞态与原子替换：按文件串行化锁，并通过解析符号链接与保留原文件权限实现原子落盘。
- 修复同步与提醒并发状态竞争：串行化到期提醒扫描并在 `syncNow` 落盘时合并最新已发送状态；写入前按当前配置校验目标日历是否仍然有效。
- 修复到期提醒推送与同步缓存可靠性：逐条推送并确认落盘（单条失败不吞掉同批后续并支持下轮重试）；CalDAV `calendar-multiget` 或集合查询失败时正确上抛异常以保留上次缓存。
- 修复 WebUI 面板勾选复选框后卡死禁用状态的问题，并支持发现空本地日历、空自定义目录与空 CalDAV 日历集合。
- 完善 ICS 解析与去重：事件去重键纳入 `calendarId` 避免跨日历互相覆盖；支持 `RECURRENCE-ID` 改期覆盖原实例；跨夏令时全天事件按事件时区次日 0 点计算区间；CalDAV `PUT` 保留查询参数。

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
