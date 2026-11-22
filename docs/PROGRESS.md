# Media Parser Node.js + TypeScript 重构与上游同步进度

> 设计依据：`docs/nodejs-typescript-refactor-design.md`
>
> 最后更新：2026-11-22（Asia/Shanghai，同步上游 `ucmao/media-parser@fd5c5e9`）

## 当前结论

- 已同步上游 `ucmao/media-parser` 截至 `2026-11-19`（`fd5c5e9`）的全部 **50 个平台 Parser**、存量平台协议修复、返回字段契约、9 平台凭据支持与动态代理池能力。
- 保留 `media-parser-ts` 独立架构：Fastify 5、严格 TypeScript、SQLite WAL、单管理员双 Token、调用方与 Bearer `mp_...` API Key 管理、AES-256-GCM 凭据加密、公开解析网页与管理后台。
- 新增兼容路由 `GET /api/v1/parse` 与 `POST /api/v1/parse`（支持 JSON、URL-encoded 表单及查询参数读取链接，继续强制 `Authorization: Bearer mp_...` 请求头鉴权）。

## 2026-11-22 上游同步范围

### 1. 新增 19 个平台（31 → 50 平台）
- 微信公众号、今日头条、得物、网易LOFTER、配音秀
- QQ音乐、网易云音乐、酷狗音乐
- 腾讯元宝、海螺AI、星绘AI、松果时刻
- 拼多多（含本地 `anti_content.js` 签名器包装）
- 番茄小说、红果短剧、红果漫剧（识别 30 秒试看并回源提取完整分集）
- 快影、央视（CCTV）、央视频（含 `cKey 8.1` AES-128-ECB 协议与资讯内嵌媒体）

### 2. 存量平台核心协议与抗风控升级
- **抖音 / 西瓜视频**：新增分享页 SSR 兜底、托管 `DOUYIN_COOKIE` 与 `UIFID` 请求头穿透 Argus 网关、过滤冲突 SecSDK 票据、`playwm` 清洗升级 1080P 画质仲裁、新版实况动轨、静态原图封面优先、放映厅 `/lvdetail/` 长片与短剧、字幕提取及私密/删除作品短路识别。
- **小红书**：视频与短链去水印、SSR JS 构造表达式兼容、LivePhoto 增强及私密/删除状态识别。
- **哔哩哔哩**：机房 IP 412 拦截修复、AV 号、动态/Opus 图文与番剧/PGC 支持。
- **闲鱼**：MTOP 签名接口、宝贝介绍视频与高清图集提取。
- **微博 / 最右 / 皮皮搞笑 / 皮皮虾 / 快手 / 剪映 / 汽水音乐 / 即梦AI / 小云雀AI / 通义千问 / 豆包 / 知乎 / 视频号**：补齐微博与最右 LivePhoto、皮皮搞笑图集、快手 GraphQL 兜底、剪映模板无水印与 CapCut 域名、汽水音乐 VIP 试听标记（`is_preview` / `full_duration`）及多源容灾。

### 3. 数据契约、凭据与动态代理池
- **返回结构**：新增 `data.desc`（无 `title` 时回退 `desc`）、`hasMedia` 纳入 `audioUrl`、`cover_url` 缺失时回退图集首图、字幕同时输出 `start`/`end`（秒）与 `start_ms`/`end_ms`（毫秒）。
- **精细化错误码**：支持 `MEDIA_DELETED_OR_PRIVATE`、`NO_MEDIA_IN_CONTENT`、`DOUYIN_COOKIE_REQUIRED`、`XIAOHONGSHU_COOKIE_REQUIRED`、`KUAISHOU_COOKIE_REQUIRED`、`WECHAT_CHANNELS_COOKIE_REQUIRED`、`PINDUODUO_COOKIE_REQUIRED`、`PARSE_TIMEOUT`、`PROXY_UNAVAILABLE`、`PROXY_RETRY_EXHAUSTED`。
- **9 平台托管凭据**：豆包、腾讯元宝/视频号、快手、小红书、抖音、拼多多、微博、即梦AI、知乎（支持环境变量别名与后台加密覆盖）。
- **动态代理与 IP 池**：新增零外部依赖 HTTP/HTTPS `CONNECT` 隧道代理客户端与 `ProxyManager`（支持 `auto` 15 分钟平台级风控代理窗口、单请求最多换 3 个代理 IP 重试，以及 `always` 轮换池模式，全程保留 `OutboundPolicy` SSRF/私网拦截）。
