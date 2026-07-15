# RedisInsight 内网部署与访问控制手册

## 背景与目标

RedisInsight 可用于 Redis 实例的可视化连接、数据查看与运维操作。本文提供两种常用部署方式：

- 方案一：快速部署，适合仅在受控内网环境中临时或直接使用。
- 方案二：通过 Nginx 增加基础认证，适合需要对访问入口进行口令保护的场景。

## 环境说明

- 容器运行时：Docker
- 可选编排方式：Docker Compose
- 默认访问端口：
  - RedisInsight 服务容器内端口：`5540`
  - 对外访问端口：`8001`

## 方案一：直接部署 RedisInsight

适用场景：

- 纯内网环境
- 临时查看 Redis 数据
- 不需要额外入口认证

部署命令：

```bash
# 无密码+可视化界面  可内网部署 --- 直接部署
docker run -d --name redisinsight -p 8001:5540 redis/redisinsight:latest
```

访问方式：

```text
# 访问 http://ip:8001
```

Redis 连接参考：

```text
# 连接参考
redis://:<REDIS_PASSWORD>@<IP_ADDRESS>:6382
redis://:<REDIS_PASSWORD>@<IP_ADDRESS>:6382
redis://:<REDIS_PASSWORD>@<IP_ADDRESS>:6382
redis://:<REDIS_PASSWORD>@<IP_ADDRESS>:6382
redis://:<REDIS_PASSWORD>@<IP_ADDRESS>:6382
redis://:<REDIS_PASSWORD>@<IP_ADDRESS>:6382

redis://:<REDIS_PASSWORD>@<IP_ADDRESS>:6382
redis://:<REDIS_PASSWORD>@<IP_ADDRESS>:6382
redis://:<REDIS_PASSWORD>@<IP_ADDRESS>:6382
```

说明：

- `redis://:<REDIS_PASSWORD>@IP:端口` 是带密码连接 Redis 的标准 URI 形式。
- 如果 Redis 实例位于不同网段，需要提前确认部署 RedisInsight 的主机具备对应路由和防火墙放通策略。
- 该方案本身未增加 Web 入口认证，适合放在可信内网或仅通过堡垒机、VPN、端口白名单等方式访问。

## 方案二：通过 Nginx 增加访问认证

适用场景：

- 需要对 RedisInsight Web 页面增加登录保护
- 希望将 RedisInsight 容器隐藏在反向代理之后
- 内网共享使用，但不希望任何能访问端口的人直接进入管理界面

推荐目录结构初始化命令：

```bash
# 配置密码+可视化界面
mkdir -p /docker/redis-ui
cd /docker/redis-ui
```

### Docker Compose 配置

文件名：`docker-compose.yml`

```yaml
version: '3.8'
services:
  redisinsight:
    image: swr.cn-south-1.myhuaweicloud.com/yalex/redisinsight:2.70
    volumes:
      - redisinsight_data:/data
    networks:
      - redis_net

  nginx:
    image: swr.cn-south-1.myhuaweicloud.com/yalex/nginx:1.27.4
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf:ro
      - ./htpasswd:/etc/nginx/.htpasswd:ro
    ports:
      - "8001:80"
    depends_on:
      - redisinsight
    networks:
      - redis_net

volumes:
  redisinsight_data:

networks:
  redis_net:
    driver: bridge
```

说明：

- `redisinsight_data:/data` 用于持久化 RedisInsight 的本地数据。
- `nginx` 与 `redisinsight` 位于同一自定义网络 `redis_net`，可直接通过服务名转发。
- 对外仍暴露 `8001` 端口，但实际入口为 Nginx。

### Nginx 配置

文件名：`nginx.conf`

```nginx
events {}
http {
    server {
        listen 80;
        location / {
            proxy_pass http://redisinsight:5540;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            auth_basic "Restricted Access";
            auth_basic_user_file /etc/nginx/.htpasswd;
        }
    }
}
```

说明：

- `proxy_pass http://redisinsight:5540;` 将请求转发到 RedisInsight 容器。
- `auth_basic` 与 `auth_basic_user_file` 用于启用 HTTP Basic Auth。
- 如果后续需要记录真实来源地址，当前配置中的 `X-Real-IP` 已可满足基础场景。

### 生成访问认证文件

文件名：`htpasswd`

```bash
# htpasswd
htpasswd -c <WEB_PASSWORD> redisadmin # 会提示你输入密码  redisadmin的密码
```

说明：

- 首次创建使用 `-c`。
- 如果需要继续添加用户，不要重复使用 `-c`，否则会覆盖已有账户。

### 启动服务

```bash
docker-compose up -d
```

说明：

- 如果环境使用新版 Docker Compose 插件，也可使用 `docker compose up -d`。
- 启动完成后，访问 `http://IP:8001`，浏览器会先弹出基础认证登录框，通过后进入 RedisInsight 页面。

## 两种方案的区别与选择建议

### 方案一：直接暴露 RedisInsight

特点：

- 部署最简单
- 启动速度快
- 适合个人临时使用或受限内网环境

限制：

- Web 入口没有额外认证保护
- 对访问控制依赖网络边界

### 方案二：Nginx + Basic Auth

特点：

- 页面访问前增加用户名密码校验
- 更适合团队共用或长期保留
- 可以继续扩展 HTTPS、访问日志、白名单等能力

限制：

- 配置略复杂
- 需要同时维护 `nginx.conf` 和 `htpasswd`

选择建议：

- 仅限可信内网且强调快速上线时，优先使用方案一。
- 需要最基础的访问隔离能力时，优先使用方案二。
- 如果环境对安全要求更高，应在方案二基础上继续增加 HTTPS、来源 IP 限制或仅通过堡垒机访问。

## 注意事项

- 文中 Redis 连接示例使用了明文密码，实际生产环境应避免将密码直接保存在公开脚本或共享文档中。
- 如果镜像仓库访问受限，可优先确认当前网络是否能拉取对应镜像。
- `redis/redisinsight:latest` 便于快速体验，但版本会随时间变化；长期环境更建议固定明确版本号。
- 使用华为云镜像地址的 Compose 方案更偏向可控版本部署，稳定性通常优于直接使用 `latest`。
- 若 Redis 开启了访问控制列表、TLS 或特殊网络策略，需要在 RedisInsight 中按实际参数补充连接配置。

## 常见问题与排查

### 无法打开 `http://IP:8001`

检查项：

- 宿主机 `8001` 端口是否已被占用
- Docker 容器是否正常运行
- 宿主机防火墙、安全组是否已放行 `8001`

可用排查命令：

```bash
docker ps
docker logs redisinsight
docker logs nginx
```

### RedisInsight 页面能打开，但无法连接 Redis

检查项：

- Redis IP 与端口是否可达
- Redis 密码是否正确
- Redis 是否只监听本地地址
- 中间网络设备是否限制跨网段访问

### Basic Auth 无法登录

检查项：

- `htpasswd` 文件是否成功生成并正确挂载
- 是否误用了 `htpasswd -c` 覆盖原有账户
- <WEB_PASSWORD> 配置文件是否与容器中的挂载路径一致

## 推荐落地方式

长期使用时，建议优先采用“固定版本 RedisInsight + Nginx 基础认证 + 数据卷持久化”的部署方式。这样既保留了可视化运维能力，也具备更稳定的版本控制和更清晰的访问入口管理。
