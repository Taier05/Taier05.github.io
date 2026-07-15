# Gitea部署与迁移配置手册

> 安全提示：本文已移除真实域名、邮箱、管理员账号和密码。不要通过 Helm 命令行长期传递真实密码，因为它可能进入 shell 历史、进程参数和 Release 记录；生产环境应使用受控 Secret 或外部密钥系统，并在升级前备份数据库、仓库数据和 values。

## 背景与目标

本文用于在两类常见环境中部署 Gitea，并完成仓库迁移相关配置：

- Kubernetes 集群中通过 Helm 安装高可用 Gitea
- 单机或轻量环境中通过 Docker Compose 运行 Gitea

同时给出 `migrations` 相关配置，用于控制可迁移来源地址，并提供暴露服务、验收检查与安全建议。

## 环境说明

### Kubernetes 场景

- 已安装并配置 `kubectl`
- 已安装 Helm 3
- 可用存储类：`rook-ceph-block-ssd`
- 已存在 Gateway：`nginx-gateway/shared-gateway`
- 对外访问域名示例：`gitea.example.com`
- Helm Chart 版本：`12.5.0`

### Docker Compose 场景

- 已安装 Docker 与 Docker Compose
- Gitea 镜像：`registry.example.com/platform/gitea:1.25.4`
- 宿主机本地目录用于持久化：`./gitea`

## 方案选择建议

### 推荐方案

生产环境优先使用 Kubernetes + Helm 方案，原因如下：

- 内置持久化配置，适合长期运行
- 可直接启用 `postgresql-ha` 与 `valkey-cluster`
- 更适合通过 Gateway API 接入集群统一流量入口

### 适用场景区分

#### Kubernetes + Helm

适用于以下场景：

- 需要高可用数据库与缓存
- 已运行 Kubernetes 集群
- 需要通过统一网关对外暴露服务
- 需要规范化、可重复的运维交付

#### Docker Compose

适用于以下场景：

- 开发测试
- 单机验证
- 小规模内部使用
- 尚未接入 Kubernetes 的临时部署

## Helm 部署 Gitea

### 添加仓库

```bash
helm repo add gitea https://dl.gitea.com/charts/
helm repo update
```

### 海外环境安装

适用于可直接访问公网镜像仓库的环境。

```bash
helm upgrade --install gitea gitea/gitea -n gitea --create-namespace \
  --version 12.5.0 \
  --set global.storageClass=rook-ceph-block-ssd \
  --set persistence.enabled=true \
  --set persistence.size=200Gi \
  --set gitea.config.migrations.ALLOW_LOCALNETWORKS=true \
  --set-string gitea.config.migrations.ALLOWED_DOMAINS="gitea.example.com\,source-a.example.com\,source-b.example.com" \
  --set-string gitea.config.migrations.BLOCKED_DOMAINS="" \
  --set-string gitea.config.server.ROOT_URL="https://gitea.example.com/" \
  --set-string gitea.config.server.DOMAIN="gitea.example.com" \
  --set-string gitea.config.server.PROTOCOL="http" \
  --set gitea.admin.username='<GITEA_ADMIN_USER>' \
  --set gitea.admin.email='<GITEA_ADMIN_EMAIL>' \
  --set gitea.admin.password='<GITEA_ADMIN_PASSWORD>' \
  --set postgresql-ha.enabled=true \
  --set postgresql-ha.postgresql.replicaCount=3 \
  --set postgresql-ha.persistence.size=100Gi \
  --set valkey-cluster.enabled=true \
  --set valkey-cluster.cluster.nodes=3 \
  --set valkey-cluster.persistence.enabled=true \
  --set valkey-cluster.persistence.size=20Gi
```

### 大陆环境安装

适用于镜像需通过内网仓库分发的环境。

与海外环境相比，主要差异如下：

- 增加 `global.imageRegistry=registry.example.com/platform`
- 增加 `global.security.allowInsecureImages=true`

```bash
helm upgrade --install gitea gitea/gitea -n gitea --create-namespace \
  --version 12.5.0 \
  --set global.storageClass=rook-ceph-block-ssd \
  --set global.imageRegistry=registry.example.com/platform \
  --set global.security.allowInsecureImages=true \
  --set persistence.enabled=true \
  --set persistence.size=200Gi \
  --set gitea.config.migrations.ALLOW_LOCALNETWORKS=true \
  --set-string gitea.config.migrations.ALLOWED_DOMAINS="gitea.example.com\,source-a.example.com\,source-b.example.com" \
  --set-string gitea.config.migrations.BLOCKED_DOMAINS="" \
  --set-string gitea.config.server.ROOT_URL="https://gitea.example.com/" \
  --set-string gitea.config.server.DOMAIN="gitea.example.com" \
  --set-string gitea.config.server.PROTOCOL="http" \
  --set gitea.admin.username='<GITEA_ADMIN_USER>' \
  --set gitea.admin.email='<GITEA_ADMIN_EMAIL>' \
  --set gitea.admin.password='<GITEA_ADMIN_PASSWORD>' \
  --set postgresql-ha.enabled=true \
  --set postgresql-ha.postgresql.replicaCount=3 \
  --set postgresql-ha.persistence.size=100Gi \
  --set valkey-cluster.enabled=true \
  --set valkey-cluster.cluster.nodes=3 \
  --set valkey-cluster.persistence.enabled=true \
  --set valkey-cluster.persistence.size=20Gi
```

### Gateway API 暴露服务

```bash
cat <<'EOF' | kubectl apply -f -
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: gitea
  namespace: gitea
spec:
  parentRefs:
  - name: shared-gateway
    namespace: nginx-gateway
  hostnames:
  - gitea.example.com
  rules:
  - matches:
    - path:
        type: PathPrefix
        value: /
    backendRefs:
    - name: gitea-http
      port: 3000
EOF
```

### 安装后检查

```bash
kubectl -n gitea get pods
kubectl -n gitea get svc
kubectl -n gitea get httproute
```

访问地址示例：

```text
https://gitea.example.com/
```

## Docker Compose 部署 Gitea

以下配置适合单机快速启动：

```yaml
version: "3"

networks:
  gitea:
    external: false

services:
  server:
    image: registry.example.com/platform/gitea:1.25.4
    container_name: gitea
    environment:
      - USER_UID=1000
      - USER_GID=1000
    restart: always
    networks:
      - gitea
    volumes:
      - ./gitea:/data
      - /etc/timezone:/etc/timezone:ro
      - /etc/localtime:/etc/localtime:ro
    ports:
      - "3000:3000"
```

启动方式：

```bash
docker-compose up -d
```

重启方式：

```bash
docker-compose restart
```

## 迁移来源白名单配置

Gitea 在执行仓库迁移时，可通过 `migrations` 段限制允许来源。该配置对以下场景有用：

- 从指定域名迁移仓库
- 从内网地址迁移仓库
- 允许本地网络地址参与迁移

### 配置位置

Docker Compose 部署通常修改：

```bash
vim /docker/gitea/gitea/gitea/conf/app.ini
```

Kubernetes Helm 部署则可通过 `--set gitea.config.migrations.*` 下发。

### 域名白名单示例

适用于迁移来源为固定域名的情况。

```ini
[migrations]
ALLOWED_DOMAINS = source.example.com
ALLOW_LOCALNETWORKS = true
BLOCKED_DOMAINS =
```

### 内网地址白名单示例

适用于迁移来源为固定内网 IP 的情况。

```ini
[migrations]
ALLOWED_DOMAINS = <MIGRATION_SOURCE_IP>
ALLOW_LOCALNETWORKS = true
BLOCKED_DOMAINS =
```

### 选择建议

- 来源为标准域名时，优先填写域名，便于后续地址迁移与证书管理
- 来源为临时内网服务时，可直接填写 IP
- 需要同时支持多个来源时，按逗号分隔多个域名或地址
- `ALLOW_LOCALNETWORKS=true` 仅在确有内网迁移需求时开启

## 推荐配置与注意事项

### 推荐保留项

- 生产环境保留持久化：`persistence.enabled=true`
- 集群场景优先使用 `postgresql-ha` 与 `valkey-cluster`
- 对外访问时明确设置 `ROOT_URL` 与 `DOMAIN`
- 统一通过网关暴露，而不是直接依赖 NodePort

### 安全建议

- 不要在生产环境长期使用命令行明文密码，建议改为 Secret 或密文注入
- `global.security.allowInsecureImages=true` 仅在内网镜像仓库确有需要时启用
- `ALLOWED_DOMAINS` 应尽量精确，不要无约束放开
- 修改 `app.ini` 后应重启服务使配置生效

## 常见问题与排查

### 无法迁移仓库

优先检查以下项目：

- `ALLOWED_DOMAINS` 是否包含来源域名或 IP
- `ALLOW_LOCALNETWORKS` 是否满足内网迁移场景
- `BLOCKED_DOMAINS` 是否误拦截
- `ROOT_URL` 与实际访问地址是否一致

### 服务已启动但页面无法访问

Kubernetes 场景检查：

```bash
kubectl -n gitea get pods
kubectl -n gitea get svc
kubectl -n gitea get httproute
```

Docker Compose 场景检查：

```bash
docker-compose ps
docker-compose logs -f
```

### 时间不一致导致日志或提交时间异常

Docker Compose 场景建议保留以下挂载：

```yaml
- /etc/timezone:/etc/timezone:ro
- /etc/localtime:/etc/localtime:ro
```

## 参考

Gitea 官方文档：

```text
https://docs.gitea.com/
```

## 参考资料

- [Gitea Kubernetes 安装文档](https://docs.gitea.com/installation/install-on-kubernetes)
