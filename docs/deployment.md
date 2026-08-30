# 生产部署与 Nginx 反向代理

本文档适用于单机 Linux：Docker Compose 运行 API、公开站和管理端，宿主机 Nginx 负责域名与 HTTPS。默认只把容器入口发布到 `127.0.0.1:8051`，公网不能绕过 Nginx 直接访问。

## 1. 部署拓扑

```text
浏览器
  -> 宿主 Nginx :443
  -> Web Nginx 127.0.0.1:8051
     -> /                 公开站静态资源
     -> /admin/           Admin Nginx
     -> /api/、/web-api/  Fastify API :8051
```

这个拓扑在 API 前有两层可信代理，因此生产 `.env` 使用 `TRUST_PROXY=2`。外层 Nginx 配置会覆盖访客传入的 `X-Forwarded-For`，再由容器内 Nginx 追加代理地址，API 才能安全取得真实客户端 IP，用于匿名限流、登录保护和审计。

## 2. 前置条件

- 一台已安装 Docker Engine 和 Docker Compose v2 的 Linux 主机。
- 已解析到该主机公网 IP 的域名，例如 `media.example.com`。
- 防火墙仅向公网开放 TCP `80`、`443`；不要开放 `8051`。
- 宿主 Nginx，以及 Certbot 或其他 TLS 证书签发工具。示例使用 Let's Encrypt 路径。
- 至少为 SQLite 数据、镜像和日志预留足够磁盘空间，并建立站外备份。

检查版本：

```bash
docker --version
docker compose version
nginx -v
```

## 3. 准备代码与敏感配置

```bash
git clone https://github.com/x-dr/media-parser-ts.git
cd media-parser-ts
umask 077
cp .env.example .env
mkdir -p .local
chmod 700 .local
chmod 600 .env
```

生成平台凭据加密密钥：

```bash
openssl rand -base64 32
```

将输出只写入 `.env` 的 `APP_ENCRYPTION_KEY`，不要写入命令历史、工单或 Git。这个密钥用于 AES-256-GCM 加密数据库中的平台 Cookie；必须长期保管并随备份一同恢复，否则已有凭据无法解密。

编辑 `.env` 时，生产反向代理至少确认：

```dotenv
MEDIA_PARSER_BIND_ADDRESS=127.0.0.1
MEDIA_PARSER_PORT=8051
MEDIA_PARSER_API_IMAGE=ghcr.io/x-dr/media-parser-ts-api:latest
MEDIA_PARSER_ADMIN_IMAGE=ghcr.io/x-dr/media-parser-ts-admin:latest
MEDIA_PARSER_WEB_IMAGE=ghcr.io/x-dr/media-parser-ts-web:latest
ADMIN_BOOTSTRAP_USERNAME=admin
ADMIN_BOOTSTRAP_PASSWORD=<12–128 个字符的强初始密码>
APP_ENCRYPTION_KEY=<Base64 编码的 32 字节随机密钥>
TRUST_PROXY=2
PUBLIC_WEB_API_KEY=
```

初始密码必须为 12–128 个字符。它仅在空数据库第一次启动时创建管理员，之后不会覆盖数据库中的密码。首次登录会要求修改密码。

### 环境变量完整说明

| 变量 | 默认/示例 | 作用与约束 | Docker Compose 说明 |
| --- | --- | --- | --- |
| `MEDIA_PARSER_BIND_ADDRESS` | `127.0.0.1` | Compose 发布地址；宿主 Nginx 部署应保持回环地址 | 仅用于 Compose 插值 |
| `MEDIA_PARSER_PORT` | `8051` | Compose 发布到宿主机的端口 | 仅用于 Compose 插值 |
| `MEDIA_PARSER_API_IMAGE` | `ghcr.io/x-dr/media-parser-ts-api:latest` | API 镜像；生产环境建议固定版本或 `sha-*` 标签 | 仅用于 Compose 插值 |
| `MEDIA_PARSER_ADMIN_IMAGE` | `ghcr.io/x-dr/media-parser-ts-admin:latest` | 管理后台镜像；应与 API 使用同一发布版本 | 仅用于 Compose 插值 |
| `MEDIA_PARSER_WEB_IMAGE` | `ghcr.io/x-dr/media-parser-ts-web:latest` | 公开站镜像；应与 API 使用同一发布版本 | 仅用于 Compose 插值 |
| `PORT` | `8051` | API 监听端口，范围 `1–65535` | Compose 固定为 `8051` |
| `LOG_LEVEL` | `info` | `fatal/error/warn/info/debug/trace/silent` | 传入 API |
| `DATABASE_PATH` | `/app/data/media-parser.sqlite` | SQLite 文件路径；宿主开发建议 `.local/media-parser.sqlite` | Compose 固定为命名卷中的该路径 |
| `PARSE_TIMEOUT_MS` | `25000` | 一次完整解析超时，`1000–120000` 毫秒 | 传入 API |
| `UPSTREAM_TIMEOUT_MS` | `10000` | 单个上游请求超时，`500–60000` 毫秒 | 传入 API |
| `GLOBAL_PARSE_CONCURRENCY` | `20` | 全服务解析并发，`1–1000` | 传入 API |
| `PUBLIC_WEB_API_KEY` | 空 | 公开网页 BFF 专用 `mp_...` Key；留空时网页解析未就绪 | 仅存在 API 服务端 |
| `PUBLIC_WEB_CONCURRENCY` | `8` | 匿名网页独立全局并发，`1–100` | 传入 API |
| `PUBLIC_WEB_RATE_LIMIT_PER_MINUTE` | `6` | 每个可信访客 IP 每分钟请求数，`1–1000` | 依赖正确的 `TRUST_PROXY` |
| `LOG_RETENTION_DAYS` | `30` | 调用日志保留天数，`1–365` | 传入 API |
| `ADMIN_BOOTSTRAP_USERNAME` | `admin` | 仅空数据库首次建管理员；3–64 位且以字母或数字开头 | 传入 API |
| `ADMIN_BOOTSTRAP_PASSWORD` | 无 | 仅空数据库首次建管理员；12–128 个字符 | 通过 `.env` 传入 API |
| `APP_ENCRYPTION_KEY` | 无 | 必填，Base64 编码的 32 字节当前密钥 | 缺失时 `/api/ready` 返回 503 |
| `APP_ENCRYPTION_KEY_PREVIOUS` | 空 | 轮换期间解密旧凭据的旧密钥 | 平时保持空值 |
| `CORS_ORIGINS` | 空 | 逗号分隔的精确 HTTP(S) Origin；不支持通配符 | 同源部署无需设置 |
| `TRUST_PROXY` | `false` | `false`、可信代理跳数或逗号分隔的可信地址；不能写 `true` | 本文拓扑设为 `2` |
| `DOUBAO_COOKIE` | 空 | 可选豆包登录态 | 更推荐在管理后台托管 |
| `YUANBAO_COOKIE` | 空 | 可选视频号/元宝登录态 | 更推荐在管理后台托管 |
| `KUAISHOU_COOKIE` | 空 | 可选快手登录态 | 更推荐在管理后台托管 |
| `XIAOHONGSHU_COOKIE` | 空 | 可选小红书登录态 | 更推荐在管理后台托管 |
| `PARSER_ENGINE` | `typescript` | `typescript` 或整体回滚模式 `legacy-http` | 通常保持默认 |
| `LEGACY_PYTHON_URL` | 空 | `legacy-http` 时必填的无凭据 HTTP(S) 根 URL | 不支持按平台分流 |

数据库托管的平台凭据优先于同名环境变量。`.env`、`.local/`、数据库及常见密钥文件已被 `.gitignore` 排除，但仍应限制权限并使用独立的密码管理与备份策略。

## 4. 启动与检查容器

```bash
docker compose config
docker compose pull
docker compose up --detach
docker compose ps
docker compose logs --tail=100 api
```

以上命令默认拉取 `ghcr.io/x-dr/media-parser-ts-{api,admin,web}:latest`。为便于回滚，生产环境建议把 `.env` 中三个镜像地址固定为同一次发布的版本标签或 `sha-*` 标签。本地源码构建可改用 `docker compose up --detach --build`。

先从宿主机检查仅回环可达的入口：

```bash
curl --fail http://127.0.0.1:8051/healthz
curl --fail http://127.0.0.1:8051/api/health
curl --fail http://127.0.0.1:8051/api/ready
```

- `/healthz`：容器内入口 Nginx 正常。
- `/api/health`：API 进程存活。
- `/api/ready`：数据库、迁移、加密密钥和 Parser 注册均已就绪。

`docker compose config` 和镜像构建成功不等于服务已部署成功；必须同时检查 `docker compose ps` 与真实 HTTP 响应。

## 5. 配置宿主 Nginx 与 HTTPS

仓库提供首次签发证书用的 [HTTP 配置](../deploy/nginx/media-parser-http.conf.example) 和签发后的 [HTTPS 配置](../deploy/nginx/media-parser.conf.example)。先启用 HTTP 配置并把其中域名替换为实际值：

```bash
sudo mkdir -p /var/www/certbot
sudo cp deploy/nginx/media-parser-http.conf.example /etc/nginx/conf.d/media-parser.conf
sudo editor /etc/nginx/conf.d/media-parser.conf
sudo nginx -t
sudo systemctl reload nginx
```

确认域名的 80 端口可从公网访问后签发证书：

```bash
sudo certbot certonly --webroot -w /var/www/certbot -d media.example.com
```

签发成功后换成 HTTPS 配置，替换其中域名并确认两个证书路径存在：

```bash
sudo cp deploy/nginx/media-parser.conf.example /etc/nginx/conf.d/media-parser.conf
sudo editor /etc/nginx/conf.d/media-parser.conf
sudo nginx -t
sudo systemctl reload nginx
```

如果发行版使用 `/etc/nginx/sites-available`，把配置放入该目录并链接到 `sites-enabled`。配置中的上游端口必须与 `MEDIA_PARSER_PORT` 一致。

公网验证：

```bash
curl --fail https://media.example.com/healthz
curl --fail https://media.example.com/api/health
curl --fail https://media.example.com/api/ready
curl --head https://media.example.com/admin/
```

若前面还有 CDN 或负载均衡器，代理跳数和可信地址会变化。不要直接增加 `TRUST_PROXY`；应先确认每一跳如何覆盖或追加 `X-Forwarded-For`，再设置精确的可信链。

## 6. 首次初始化公开解析页

1. 打开 `https://media.example.com/admin/`，使用 `.env` 中的初始用户名和密码登录。
2. 按提示立即修改管理员密码。
3. 创建用途为 `public-web` 的调用方，设置合理的每分钟限额与并发。
4. 为调用方创建 API Key，并安全保存只展示一次的完整 `mp_...` Key。
5. 把该 Key 写入 `.env` 的 `PUBLIC_WEB_API_KEY`，然后只重建 API 服务：

```bash
docker compose up --detach --no-deps --force-recreate api
curl --fail https://media.example.com/web-api/status
```

外部程序应使用另一个调用方和独立 Key，不要与公开网页共享配额和吊销范围。不要把 Key 放进 `VITE_*`、HTML、浏览器存储或公开日志。

## 7. 日常运维

查看状态与日志：

```bash
docker compose ps
docker compose logs --follow --tail=200 api
docker compose logs --follow --tail=100 web admin
```

更新镜像并重新创建容器：

```bash
docker compose pull
docker compose up --detach
docker compose ps
```

更新后重新执行本机与公网健康检查。不要在未备份数据库、`.env` 和加密密钥时升级。

### 备份

SQLite 位于 `media-parser-data` 命名卷。为获得一致备份，短暂停止容器后复制整个数据目录：

```bash
mkdir -p backups/media-parser-data
docker compose stop
docker compose cp api:/app/data/. backups/media-parser-data/
docker compose start
```

同时单独安全备份 `.env` 和 Nginx 配置。备份包含敏感信息，应加密、限制权限并保存在另一台设备或对象存储中。恢复会覆盖现有数据，操作前应再次停服并确认目标目录，避免误覆盖。

## 8. 常见故障

### API 容器反复重启

```bash
docker compose logs --tail=200 api
```

首次建库通常是 `.env` 缺少 `ADMIN_BOOTSTRAP_PASSWORD`，或密码不满足 12–128 字符。

### `/api/ready` 返回 503

检查 `APP_ENCRYPTION_KEY` 是否为 Base64 编码的 32 字节、SQLite 卷是否可写、迁移是否成功，以及旧平台凭据能否被当前或上一把密钥解密。

### Nginx 返回 502

先在宿主机请求 `http://127.0.0.1:8051/api/health`，再检查 `MEDIA_PARSER_PORT`、Compose 容器状态和宿主 Nginx error log。若回环请求失败，问题在容器侧；若回环成功，问题在宿主 Nginx 的上游地址、TLS 或防火墙配置。

### 所有访客显示同一 IP 或一起触发 429

本文拓扑应使用 `TRUST_PROXY=2`，且宿主 Nginx 必须覆盖而非透传客户端提供的 `X-Forwarded-For`。如果拓扑不同，应重新核对代理链，不能使用不受支持的 `TRUST_PROXY=true`。

### 公开页显示未配置

确认 `PUBLIC_WEB_API_KEY` 是启用且未过期的 `mp_...` 调用方 Key，然后强制重建 API 容器。管理员 `ma_access_...` Token 不能调用解析接口。
