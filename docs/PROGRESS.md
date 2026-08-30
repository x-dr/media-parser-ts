# Media Parser Node.js + TypeScript 重构进度

> 设计依据：`docs/nodejs-typescript-refactor-design.md`
>
> 最后更新：2026-08-30（Asia/Shanghai）

## 当前结论

- 独立项目已迁移到 `/root/media-parser-ts`；Python 基线仍位于 `/root/mediatool/media-parser`，保持只读且未修改。
- 31 个 TypeScript Parser、Fastify API、SQLite、管理员/API Key、凭据、日志、受控测试、OpenAPI、Docker、开发测试页和全局 `legacy-http` 回滚适配器均已实现。
- 本地严格编译、Lint、105 项 Node 测试、生产构建和 Docker 镜像验证通过；Python 基线仍为 119/119 通过。
- **尚不满足生产切换门槛**：未执行 Python/Node 全量 fixture 对照、31 个真实网络样例、负载测试和实际整体切换/回滚演练。
- Mock、编译和镜像自检不等同于真实授权上游可用性；任何 Cookie/Token 均未写入本文件或测试输出。

## 总体进度

| 阶段 | 状态 | 已完成 | 未完成门槛 |
| --- | --- | --- | --- |
| 0. 基线与风险清理 | 已完成 | 冻结 31 平台/31 样例/119 测试基线；迁移未复制快手硬编码 Cookie，未迁移 TLS 绕过 | 无 |
| 1. 工程与管理基础设施 | 已实现，待验收 | Node 24、strict TS、Fastify 5、SQLite、管理员双 Token、API Key、凭据、日志/统计/导出、平台启停/测试 | 需补齐完整管理并发和持久化集成矩阵 |
| 2. HTTP 安全边界与低/中复杂度 Parser | 已实现，待对照 | 请求级 Cookie Jar、SSRF/DNS/重定向/体积/超时/取消边界；低中复杂度 Parser 已迁移 | 全量 Python/Node fixture 深度对照未运行 |
| 3. 高风险 Parser | 已实现，待实网 | 抖音/西瓜本地签名、快手、豆包 AES/回退、微博、视频号、腾讯频道隔离挑战均已迁移 | 授权凭据与 31 个真实样例未验证 |
| 4. 部署、切换与回滚 | 部分完成 | 非 root 多阶段镜像、健康/就绪、优雅退出、OpenAPI、全局 `legacy-http` 已实现；镜像构建/自检通过 | 未启动验收服务，未做负载、反代切换和回滚演练 |

## 已完成

### 基线与工程

- [x] 完整读取 1007 行设计文档并按阶段建立本进度台账。
- [x] Python 基线确认 31 个 Parser、31 个真实样例、119 项 unittest 全部通过。
- [x] 建立独立 ESM 项目，锁定 Node.js 24、pnpm、Fastify、Got、Tough Cookie、better-sqlite3、Cheerio、Vitest 和 ESLint 版本。
- [x] 启用严格空值、未检查索引、精确可选属性、未使用符号等 TypeScript 检查并生成冻结 lockfile。

### API、鉴权与持久化

- [x] `GET /api/health`、`GET /api/ready`、带 Bearer API Key 的 `POST /api/parse` 和旧响应 Presenter。
- [x] 单管理员引导、首次强制改密、异步 scrypt、15 分钟 Access Token、7 天 Refresh Token、轮换、重用检测、family 吊销、退出和登录失败限流。
- [x] API Client/Key 创建、只返回一次明文、SHA-256 哈希、掩码、禁用、过期、吊销、每分钟限流、每 Key 并发和全局并发；释放操作幂等。
- [x] SQLite STRICT 表、WAL、外键、迁移事务、平台同步和读写就绪检查。
- [x] 已鉴权解析调用的 pending-before-upstream 完整日志、详情、游标列表、30 天范围 JSONL 流式导出、统计、审计与分批保留清理。
- [x] 平台启停、AES-256-GCM 唯一 IV/AAD、数据库优先于环境变量、掩码、旧 Key 解密重包和就绪解密检查。
- [x] 受控平台测试：默认登记样例或自定义 text、全服务单并发、同平台 60 秒冷却、结果持久化，响应不包含凭据。

### HTTP 与安全边界

- [x] 初始 URL/每次重定向平台约束，HTTP(S)、异常端口、URL 凭据、IP 字面量、私网/环回/链路本地/组播/元数据地址拦截。
- [x] DNS 连接时再次校验、最大重定向、请求/解析总超时、响应体限制、显式取消、TLS 默认校验、通用自动重试为 0。
- [x] 每个解析请求独立 `HttpSession`/Cookie Jar；Parser 不直接读取环境变量。
- [x] 腾讯频道远程挑战在无环境变量、无网络权限、内存/脚本/输出/时间/并发受限的独立 Node 子进程执行，主进程 `vm` 不作为唯一边界。
- [x] Pino 结构化日志隐藏 Authorization、Cookie、Token、密码、Key 和凭据值。

### Parser 与兼容

- [x] 31 个稳定英文平台 ID、域名、媒体类型、允许凭据、默认样例与 Parser 注册一一对应；就绪检查强制注册完整。
- [x] 31 个 TypeScript Parser 均将 I/O 放在可等待的 `parse()` 中，构造函数不发请求。
- [x] 西瓜显式复用抖音协议模块；夸克 AI 显式复用通义千问内容模块。
- [x] 原样保留版本控制内可信 `a_bogus.js`/`x_bogus.js`，增加可注入时钟/随机源的窄 TypeScript 包装；未关闭 TLS。
- [x] 豆包使用 `node:crypto` 实现 Base64 URL-safe、双 SHA-512、AES-128-CBC/PKCS#7，并通过 Python 生成的固定字节向量。
- [x] 未复制 Python 快手解析器中的硬编码 Cookie；快手、豆包、视频号、小红书只接收声明过的请求级托管凭据。
- [x] 为 Python 原先缺独立测试的 AcFun、抖音、好看视频、梨视频、皮皮搞笑、微视、小红书补齐脱网 fixture 测试。
- [x] 兼容 `video_url`/`video_list` 主项提升、去重顺序、可选字幕、图集/实况结构、仅 `http://` 升级 HTTPS 和旧 `video_id` 提取优先级。

### 构建、文档与回滚

- [x] OpenAPI 3.1 文档覆盖公开 API 和管理员认证、Client/Key、平台、日志、导出和统计路由。
- [x] 增加本地开发/调试/运行 README 和同源测试页；页面仅由 `dev:test-page` 挂载，不进入生产 `dist` 或 Docker 镜像，且不持久化 API Key。
- [x] Node 24 多阶段 Dockerfile，冻结安装、原生 SQLite 编译、生产依赖裁剪、UID/GID 10001 非 root、`/app/data` 卷、8051 端口和健康检查。
- [x] `SIGTERM`/`SIGINT` 停止接收新请求；10 秒后取消解析/挑战、关闭剩余连接，再关闭 SQLite。
- [x] `PARSER_ENGINE=legacy-http` 为全局开关：Node 保留鉴权、限流、并发、平台启停和完整日志，整体转发到仅配置的 Python 地址；不存在按平台分流。
- [x] `pnpm run test:live` 显式比较 Node/Python 31 平台成功率，不进入普通测试，输出不含 Key 或 Cookie。

## 待完成

- [ ] 将 Python 119 项测试逐项建立“行为已覆盖”映射；当前 Node 为 105 项测试，不能仅按数量宣称 119 项行为全部迁移。
- [ ] 保存脱敏上游响应 fixture，运行 31 平台 Python/Node 相同请求序列的字段、空值、列表顺序深度对照。
- [ ] 在同一出口、相近时间显式运行 31 个真实样例；匿名能力与授权 Cookie 能力分开记录，Node 成功率不得低于 Python。
- [ ] 运行 TLS 错误、DNS 重绑定、跨域多跳重定向、客户端断开、超大响应、SQLite 故障和高并发负载的集成测试。
- [ ] 在 8052 验收地址完成管理员首次改密、创建调用方/Key、安全分发和调用方契约验证。
- [ ] 备份实际 SQLite，完成反向代理整体切换及 `legacy-http` 全局回滚演练；未获授权前不启动、部署或改动流量。
- [ ] 稳定运行 7 天后再移除 legacy 回滚适配器；不自动删除 Python 项目或历史数据。

## 验证记录

| 日期 | 范围 | 命令 | 结果 |
| --- | --- | --- | --- |
| 2026-08-29 | Python 基线 | `../.venv/bin/python -m unittest discover -s tests -v` | 119/119 通过 |
| 2026-08-29 | Python pytest 尝试 | `../.venv/bin/python -m pytest -q` | 未运行：虚拟环境未安装 pytest；已使用项目 unittest |
| 2026-08-30 | Node 静态与本地测试 | `pnpm run check` | ESLint、strict TypeScript、16 个测试文件/105 项测试全部通过 |
| 2026-08-30 | 生产编译 | `pnpm run build` | 通过；隔离 runner 与原样本地签名 JS 均进入 `dist/` |
| 2026-08-30 | 开发测试页 | `pnpm lint`、`pnpm typecheck`、临时回环 HTTP 冒烟 | 页面/样式/脚本、`/api/health`、`/api/ready` 均可访问；就绪检查为 200 |
| 2026-08-30 | Docker 构建 | `docker build --tag media-parser-ts:refactor-check .` | 通过；Node 24 多阶段镜像构建成功 |
| 2026-08-30 | 镜像运行时自检 | 一次性 `docker run --rm` | UID 10001、better-sqlite3、签名 JS、挑战 runner、OpenAPI 均通过 |
| 2026-08-30 | 隔离挑战自检 | `docker run --rm --network none ... ChallengeExecutor` | 通过；无网络容器内子进程仅返回测试 token/cookie 名称 |
| 2026-08-30 | 容器服务冒烟 | 一次性 `docker run --rm --network none` 内部启动/请求/关闭 | `/api/health`、`/api/ready` 均为 200，应用正常关闭；未发布宿主端口 |

## 尚未验证或环境边界

- 未执行任何真实平台上游请求，未读取或输出任何真实 Cookie/API Key/管理员口令。
- 未启动长期服务、未开放端口、未创建生产数据库、未部署、未切换流量。
- 宿主沙箱不允许 Vitest 监听本地 TCP 端口，也会影响宿主内嵌套子进程 stdin 自检；相同挑战执行链已在 `--network none` 的生产镜像内验证通过。
- 工作区根目录不是有效 Git 仓库；`media-parser/` 自身 Git 工作树仍为干净状态。未提交、推送或删除任何用户数据。
