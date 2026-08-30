# media-parser-ts 开发、调试与运行

`media-parser-ts` 是独立的 Node.js 24 + TypeScript 媒体解析服务。它提供公开解析 API、匿名网页 BFF、管理员 API、SQLite 持久化、平台配置、运行日志，以及基于 React 19 + Ant Design 6 的同源公开页和后台管理端。

## 项目结构

项目使用 pnpm workspace 按可独立构建和维护的应用边界组织：

```text
media-parser-ts/
├── api/                 # Fastify API、领域逻辑、SQLite、测试与 OpenAPI
│   ├── src/
│   ├── tests/
│   ├── scripts/
│   ├── openapi/
│   └── Dockerfile       # Node 24 Alpine API 镜像
├── admin/               # 管理后台、Nginx 配置和独立 Dockerfile
├── web/                 # 公开站、入口 Nginx 配置和独立 Dockerfile
├── compose.yaml         # api + admin + web 编排
├── package.json         # 工作区统一入口和兼容脚本
└── pnpm-workspace.yaml
```

依赖由各应用自己的 `package.json` 声明；根 `package.json` 只保留跨项目编排、Lint、共享类型宿主和 API 开发入口。本地 `pnpm start` 仍可由 API 同源加载已有的前端构建产物；容器部署则由 Web Nginx 作为唯一入口联动三个独立镜像。

## 1. 环境要求

- Node.js `>=24 <25`
- Corepack
- pnpm `11.21.0`（由 `packageManager` 锁定）
- Linux 构建环境需要能编译 `better-sqlite3`；`api/Dockerfile` 已包含 Alpine 构建工具

```bash
cd /root/media-parser-ts
corepack enable
pnpm install --frozen-lockfile
```

不要使用其他 Node 主版本生成新的 lockfile。

## 2. 首次本地配置

开发脚本会自动读取项目根目录中存在的 `.env`。先复制模板：

```bash
cp .env.example .env
mkdir -p .local
chmod 700 .local
```

然后编辑 `.env`，本地开发至少调整以下项目：

```dotenv
PORT=8051
LOG_LEVEL=debug
DATABASE_PATH=.local/media-parser.sqlite
ADMIN_BOOTSTRAP_USERNAME=admin
ADMIN_BOOTSTRAP_PASSWORD_FILE=.local/admin-password
APP_ENCRYPTION_KEY=<Base64 编码的 32 字节随机密钥>
```

在 `.local/admin-password` 中写入一次性管理员初始密码，并把文件权限设为 `0600`。密码至少应使用 12 个字符；首次登录后 API 会要求立即改密。

`APP_ENCRYPTION_KEY` 用于 AES-256-GCM 加密平台凭据。它必须是 Base64 编码的 32 字节随机值，并应由密码管理器或系统密钥设施生成和保管。不要提交 `.env`、密码文件、Cookie、API Key 或 SQLite 数据库。

首次启动时，如果数据库中还没有管理员，服务才会读取引导用户名和密码文件。已经初始化的数据库不会用环境变量覆盖管理员。

## 3. 开发运行

仅启动 API，并在 TypeScript 文件变化时自动重启：

```bash
pnpm dev
```

另开一个终端启动后台管理端开发服务器：

```bash
pnpm dev:admin
```

浏览器访问 `http://127.0.0.1:5173/admin/`。Vite 会把 `/api` 代理到 `127.0.0.1:8051`。后台管理会话只保存在当前页面内存中，不写入浏览器存储；刷新页面后需要重新登录。

启动匿名公开页开发服务器：

```bash
pnpm dev:web
```

浏览器访问 `http://127.0.0.1:5174/`。Vite 会把 `/api` 和 `/web-api` 代理到 `127.0.0.1:8051`。公开页不要求访客输入 API Key，也不使用人机验证码；服务端仍要求配置独立的 `PUBLIC_WEB_API_KEY`，并对访客 IP 和匿名全局并发分别限流。分享文本、解析结果或媒体 URL 不写入浏览器存储。

调试解析接口请直接使用 `curl`、API 客户端或自动化测试。

### 健康检查

```bash
curl --fail http://127.0.0.1:8051/api/health
curl --fail http://127.0.0.1:8051/api/ready
```

- `/api/health` 为进程存活检查。
- `/api/ready` 还会检查数据库迁移、写入能力、加密密钥和 31 个 Parser 注册；未就绪时返回 `503`。

## 4. 创建本地 API Key

`POST /api/parse` 必须携带独立 API Key，管理员 Access Token 不能代替它。完整 API Key 只会在创建时返回一次。

本地服务启动后，可直接运行保留在 Python 基线工作区中的初始化脚本：

```bash
bash /root/mediatool/11.sh
```

脚本会安全解析 `.env`，从 `ADMIN_BOOTSTRAP_PASSWORD_FILE` 指向的文件读取管理员密码；首次登录时会自动生成强密码、完成改密并以 `0600` 权限回写同一文件。随后它复用或创建本地调试调用方，并将完整 API Key 保存到 `.local/test-api-key`，不会把密码、Token 或完整 Key 输出到终端。重复运行时，如果文件中的 Key 在数据库中仍启用且未吊销，脚本不会重复创建。

下面是对应的手动 API 流程，适合排查脚本或接入其他客户端。

推荐按 `api/openapi/openapi.yaml` 完成以下管理 API 流程：

1. `POST /api/admin/v1/auth/login`：用引导用户名和密码登录。
2. 如果响应中 `must_change_password=true`，调用 `PUT /api/admin/v1/auth/password`。新密码至少 12 个字符；改密后要改用响应里的新 Access Token。
3. `POST /api/admin/v1/clients`：创建调用方，取响应中的 `data.id`。
4. `POST /api/admin/v1/clients/{clientId}/keys`：创建 Key，并立即安全保存响应中仅出现一次的 `data.api_key`。

管理员 API 使用：

```http
Authorization: Bearer ma_access_...
Content-Type: application/json
```

公开解析 API 使用：

```bash
curl --fail-with-body http://127.0.0.1:8051/api/parse \
  --request POST \
  --header 'Content-Type: application/json' \
  --header "Authorization: Bearer ${MEDIA_PARSER_API_KEY}" \
  --data '{"text":"这里替换为分享文本或链接"}'
```

把真实 Key 放在未提交的环境变量中，不要直接写进命令历史、脚本、截图或日志。

公开页必须另建一个用途明确的调用方（例如 `public-web`）和专用 Key，把完整值仅注入服务端 `PUBLIC_WEB_API_KEY`。不要复用管理员 Token，不要把 Key 放进 `VITE_*`、HTML、JavaScript 或浏览器运行时配置。建议同时在后台为该 Key 设置合适的每分钟限频与最大并发。

## 5. 调试

### 运行日志

在 `.env` 中设置 `LOG_LEVEL=debug` 后运行 `pnpm dev`。Fastify 输出结构化 JSON 日志，并对 Authorization、Cookie、密码、Token、API Key 和凭据值做脱敏。

定位一次请求时优先记录：

- HTTP 状态与公开响应中的 `error_code`
- Fastify 请求 ID
- 结构化日志中的 `error_category`
- 平台、耗时和上游状态，不复制凭据或完整授权头

### Node Inspector

```bash
pnpm debug
```

进程默认在 `127.0.0.1:9229` 等待调试器连接，但不会暂停首行。VS Code 可使用下面的 Attach 配置：

```json
{
  "type": "node",
  "request": "attach",
  "name": "Attach media-parser-ts",
  "port": 9229,
  "restart": true,
  "skipFiles": ["<node_internals>/**"]
}
```

### 常用检查

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:watch
pnpm build
pnpm check
```

运行单个测试文件：

```bash
pnpm --filter @media-parser/api exec vitest run tests/contract/public-api.test.ts
```

普通测试使用 Mock 或 Fastify inject，不证明真实平台当前可用。真实双栈验证会访问外部平台，只有在你拥有合法样例、Node API Key 和所需授权凭据时才运行：

```bash
LIVE_NODE_API_URL=http://127.0.0.1:8051 \
LIVE_PYTHON_API_URL=http://127.0.0.1:5000 \
LIVE_NODE_API_KEY="$MEDIA_PARSER_API_KEY" \
pnpm test:live
```

`test:live` 会对 31 个默认样例比较 Node/Python 成功率，但不进入 `pnpm check`。

## 6. 配置参考

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8051` | HTTP 监听端口 |
| `LOG_LEVEL` | `info` | `fatal/error/warn/info/debug/trace/silent` |
| `DATABASE_PATH` | `/app/data/media-parser.sqlite` | SQLite 文件；本地建议使用 `.local/media-parser.sqlite` |
| `PARSE_TIMEOUT_MS` | `25000` | 单次完整解析超时，范围 1–120 秒 |
| `UPSTREAM_TIMEOUT_MS` | `10000` | 单个上游请求超时，范围 0.5–60 秒 |
| `GLOBAL_PARSE_CONCURRENCY` | `20` | 全局解析并发上限 |
| `PUBLIC_WEB_API_KEY` | 无 | 匿名网页 BFF 使用的专用 `mp_...` Key；只保存在服务端 |
| `PUBLIC_WEB_CONCURRENCY` | `8` | 匿名网页独立全局并发上限，范围 1–100 |
| `PUBLIC_WEB_RATE_LIMIT_PER_MINUTE` | `6` | 每个可信访客 IP 每分钟公开解析次数，范围 1–1000 |
| `LOG_RETENTION_DAYS` | `30` | 调用日志保留天数，范围 1–365 天 |
| `ADMIN_BOOTSTRAP_USERNAME` | 无 | 仅首次建库创建管理员时使用 |
| `ADMIN_BOOTSTRAP_PASSWORD_FILE` | 无 | 初始密码文件路径，不是密码本身 |
| `APP_ENCRYPTION_KEY` | 无 | 当前 Base64 32 字节平台凭据密钥；就绪检查要求配置 |
| `APP_ENCRYPTION_KEY_PREVIOUS` | 无 | 轮换期间用于解密旧数据的上一把密钥 |
| `CORS_ORIGINS` | 空 | 逗号分隔的精确 HTTP(S) Origin，不支持通配符 |
| `TRUST_PROXY` | `false` | `false`、可信代理跳数或可信地址列表 |
| `PARSER_ENGINE` | `typescript` | `typescript` 或全局回滚模式 `legacy-http` |
| `LEGACY_PYTHON_URL` | 无 | `legacy-http` 模式必填的 Python 服务根 URL |
| `DOUBAO_COOKIE` | 空 | 可选豆包 Cookie；数据库托管凭据优先 |
| `YUANBAO_COOKIE` | 空 | 可选视频号/元宝 Cookie |
| `KUAISHOU_COOKIE` | 空 | 可选快手 Cookie |
| `XIAOHONGSHU_COOKIE` | 空 | 可选小红书 Cookie |

环境 Cookie 只适合受控部署。需要动态维护时，应通过管理员平台凭据 API 写入加密数据库；查询接口只返回掩码。

## 7. 生产构建与运行

本地验证编译产物：

```bash
pnpm build
pnpm start
```

`pnpm start` 不自动读取 `.env`。生产环境应由 systemd、容器平台或密钥管理设施注入环境变量和只读密码文件。生产进程监听 `0.0.0.0:${PORT}`。

生产构建会并行生成 `api/dist/`、`admin/dist/` 和 `web/dist/`。启动后从 `http://127.0.0.1:8051/` 访问匿名公开页，从 `http://127.0.0.1:8051/admin/` 访问后台；深层后台路由由 Fastify 回退到管理端入口。公开 BFF 只有在 `PUBLIC_WEB_API_KEY` 可用时才报告就绪，浏览器响应和构建产物都不包含完整 Key。

Docker 构建：

```bash
docker compose build
docker compose up --detach
docker compose ps
```

三个镜像也可以单独构建：

```bash
docker build --file api/Dockerfile --tag media-parser-api:local .
docker build --file admin/Dockerfile --tag media-parser-admin:local .
docker build --file web/Dockerfile --tag media-parser-web:local .
```

全部构建阶段使用 `node:24-alpine` 和共享 pnpm 缓存。API 运行层使用 Node Alpine，只包含生产依赖、编译结果和 OpenAPI；Admin/Web 运行层使用 `nginx:alpine`，不包含 Node、前端工具链、测试或 TypeScript 源码。所有容器均以非 root 用户运行。

Compose 只发布 Web Nginx 的 `${MEDIA_PARSER_PORT:-8051}`，内部路由如下：

| 请求路径 | 目标 |
| --- | --- |
| `/`、`/assets/` | Web Nginx 静态资源与 SPA 回退 |
| `/admin/` | Web Nginx 转发到 Admin Nginx |
| `/api/`、`/web-api/` | Web Nginx 转发到 Fastify API |
| `/healthz` | Web Nginx 自身健康检查 |

API 不直接发布宿主端口。Compose 固定设置 `TRUST_PROXY=1`，只信任入口 Nginx 这一跳，并传递 `X-Forwarded-For`，从而让匿名限流获得真实访客地址；不要在 API 前再增加未纳入信任边界的代理层。SQLite 使用命名卷 `media-parser-data`，管理员密码从 `${ADMIN_BOOTSTRAP_PASSWORD_SOURCE:-.local/admin-password}` 以只读 secret 挂载，宿主文件应为 `0600`。

部署后验证统一入口：

```bash
curl --fail http://127.0.0.1:8051/healthz
curl --fail http://127.0.0.1:8051/api/health
curl --fail http://127.0.0.1:8051/api/ready
```

部署前至少验证：

1. `/api/health` 返回 `200`。
2. `/api/ready` 返回 `200`，并显示预期迁移版本。
3. 使用专用测试 Key 完成一条已授权平台请求。
4. `SIGTERM` 能在 10 秒宽限期内结束请求并关闭 SQLite。
5. 只有 Web Nginx 暴露宿主端口，代理拓扑与 `TRUST_PROXY=1` 一致。

## 8. 常见问题

### 启动时报“数据库中没有管理员”

首次建库缺少 `ADMIN_BOOTSTRAP_USERNAME` 或 `ADMIN_BOOTSTRAP_PASSWORD_FILE`，或者密码文件路径不可读。补齐后重新启动；不要把密码直接放入该变量。

### `/api/ready` 返回 503

先看服务日志。常见原因是 `APP_ENCRYPTION_KEY` 缺失/格式错误、旧凭据无法用当前或上一把密钥解密、SQLite 不可写，或 Parser 注册不完整。

### 解析返回 401

检查使用的是 `mp_...` API Key，而不是管理员 Token；同时确认调用方和 Key 均启用、未过期、未吊销。

### 解析返回 429

可能触发 Key 的每分钟限频、Key 最大并发或服务全局并发上限。遵循响应中的 `Retry-After`，不要无间隔重试。

### 页面能打开，但媒体不能预览

部分平台会限制浏览器跨域播放、Referer、临时 URL 或媒体格式。先用完整 JSON 中的链接和服务日志判断解析是否成功；页面预览失败不等于 Parser 失败。

## 9. 相关资料

- API 契约：[`api/openapi/openapi.yaml`](api/openapi/openapi.yaml)
- 重构设计：[`docs/nodejs-typescript-refactor-design.md`](docs/nodejs-typescript-refactor-design.md)
- 当前验收进度：[`docs/PROGRESS.md`](docs/PROGRESS.md)
