---
name: dsh-api-capture
description: 用 dsh 抓包核对桌面客户端实际发出的接口：capture_status / capture_start 开实时捕获 → 复现 → capture_query 窄条件查询（慢请求、错误、某个 host、某个 ViewModel 发起的）→ 需要时 http_request 主动重放；并能在收尾裁决里证明"本次调用过接口"。Use to see which APIs the client called, debug slow or failing requests, or prove an API was exercised. Triggers：抓包、调了什么接口、接口慢、请求报错、看看接口返回。
---

# 抓包核对接口

1. `capture_status`：引擎在不在跑、trace 日志多大、调用方归因是否可用。
2. 要看"正在发生的"请求：`capture_start`（不要手搓 POST）。结果里有 `warnings` 说日志不存在时，先解决日志，再谈抓包。
3. 让用户复现，或用 UI 工具复现操作。
4. `capture_query` 用窄条件：`host` / `status` / `minDurationMs` / `errors` / `caller` / `bodyQ` / `fromTs`。先不带 `includeBody` 看摘要，定位到具体几条再带 `includeBody` 看正文。
5. 每次都看结果里的 `freshness`（引擎是否在跑、最新一条多久前）和 `callerAttribution`——引擎没在跑时看到的是**历史数据**。
6. 主动验证接口用 `http_request`：非 2xx 是正常结果（按 status 判断业务）；`ok:false` 才是请求没发出去。会改远端状态的方法（POST / PUT / DELETE）先问用户。
7. 要在收尾裁决里证明"本次调用过接口"：先 `capture_append({runId})` 落一条带本 runId 的记录，再用 `verify_report` 的 `kind=api`。
8. 结束用 `capture_stop`（之后查到的又是历史数据）。
