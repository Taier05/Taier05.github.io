# 在 Kubernetes 中部署 Harbor 私有镜像仓库

## 背景与目标

本文用于在 Kubernetes 集群中通过 Helm 部署 Harbor 私有镜像仓库，并使用 Ingress 暴露 HTTPS 访问入口。部署完成后，可用于镜像推送、拉取、漏洞扫描以及基础监控。

本文档对应的部署方案具备以下特征：

- 使用 Helm 安装 Harbor
- 使用 `Ingress + TLS Secret` 对外提供访问
- 使用 `nfs-storage` 作为持久化存储类
- 启用 Trivy 漏洞扫描与 Metrics 指标
- 使用华为云 SWR 镜像源拉取 Harbor 组件镜像

## 环境说明

部署前需确认以下条件已经满足：

- 已安装并可正常使用 `kubectl`
- 已安装并可正常使用 `helm`
- Kubernetes 集群中已存在可用的 Ingress Controller，且 Ingress Class 为 `nginx`
- 集群中已存在存储类 `nfs-storage`
- 当前目录下存在 TLS 证书文件：
  - `example.com.key`
  - `example.com.pem`
- 域名 `harbor.example.com` 已解析到 Ingress 入口地址，或内网环境已通过 `hosts` 做解析

## 部署参数设计

本方案使用的核心部署参数如下：

- 命名空间：`harbor`
- Helm Chart 仓库：`https://helm.goharbor.io`
- Chart 版本：`1.18.2`
- Harbor 对外地址：`https://harbor.example.com`
- TLS Secret：`exampleapp-tls`
- Ingress Class：`nginx`
- 管理员账号：`admin`
- 持久化存储类：`nfs-storage`

持久化容量规划如下：

- Registry：`100Gi`
- Jobservice 日志：`10Gi`
- Database：`10Gi`
- Redis：`10Gi`
- Trivy：`10Gi`

## 部署步骤

### 1. 添加 Harbor Helm 仓库

```bash
helm repo add harbor https://helm.goharbor.io
helm repo update
```

### 2. 创建命名空间

```bash
kubectl create ns harbor
```

如果命名空间可能已存在，可改用更稳妥的方式：

```bash
kubectl get ns harbor >/dev/null 2>&1 || kubectl create ns harbor
```

### 3. 创建 TLS Secret

```bash
kubectl -n harbor create secret tls exampleapp-tls \
  --key example.com.key \
  --cert example.com.pem
```

如需重复执行部署，建议先确认 Secret 是否已存在，避免命令直接失败。

### 4. 安装 Harbor

```bash
helm install harbor harbor/harbor -n harbor --create-namespace --version 1.18.2 \
  --set expose.type=ingress \
  --set expose.ingress.hosts.core=harbor.example.com \
  --set expose.ingress.className=nginx \
  --set expose.tls.enabled=true \
  --set expose.tls.certSource=secret \
  --set expose.tls.secret.secretName=exampleapp-tls \
  --set externalURL=https://harbor.example.com \
  --set harborAdminPassword='<HARBOR_ADMIN_PASSWORD>' \
  --set persistence.enabled=true \
  --set persistence.persistentVolumeClaim.registry.storageClass=nfs-storage \
  --set persistence.persistentVolumeClaim.registry.size=100Gi \
  --set persistence.persistentVolumeClaim.jobservice.jobLog.storageClass=nfs-storage \
  --set persistence.persistentVolumeClaim.jobservice.jobLog.size=10Gi \
  --set persistence.persistentVolumeClaim.database.storageClass=nfs-storage \
  --set persistence.persistentVolumeClaim.database.size=10Gi \
  --set persistence.persistentVolumeClaim.redis.storageClass=nfs-storage \
  --set persistence.persistentVolumeClaim.redis.size=10Gi \
  --set persistence.persistentVolumeClaim.trivy.storageClass=nfs-storage \
  --set persistence.persistentVolumeClaim.trivy.size=10Gi \
  --set nginx.image.repository=swr.cn-south-1.myhuaweicloud.com/yalex/nginx-photon \
  --set nginx.image.tag=v2.14.2 \
  --set portal.image.repository=swr.cn-south-1.myhuaweicloud.com/yalex/harbor-portal \
  --set portal.image.tag=v2.14.2 \
  --set core.image.repository=swr.cn-south-1.myhuaweicloud.com/yalex/harbor-core \
  --set core.image.tag=v2.14.2 \
  --set jobservice.image.repository=swr.cn-south-1.myhuaweicloud.com/yalex/harbor-jobservice \
  --set jobservice.image.tag=v2.14.2 \
  --set registry.registry.image.repository=swr.cn-south-1.myhuaweicloud.com/yalex/registry-photon \
  --set registry.registry.image.tag=v2.14.2 \
  --set registry.controller.image.repository=swr.cn-south-1.myhuaweicloud.com/yalex/harbor-registryctl \
  --set registry.controller.image.tag=v2.14.2 \
  --set trivy.image.repository=swr.cn-south-1.myhuaweicloud.com/yalex/trivy-adapter-photon \
  --set trivy.image.tag=v2.14.2 \
  --set database.internal.image.repository=swr.cn-south-1.myhuaweicloud.com/yalex/harbor-db \
  --set database.internal.image.tag=v2.14.2 \
  --set redis.internal.image.repository=swr.cn-south-1.myhuaweicloud.com/yalex/redis-photon \
  --set redis.internal.image.tag=v2.14.2 \
  --set exporter.image.repository=swr.cn-south-1.myhuaweicloud.com/yalex/harbor-exporter \
  --set exporter.image.tag=v2.14.2 \
  --set metrics.enabled=true
```

## 推荐访问方式

### 方案一：标准 Ingress HTTPS 访问

适用场景：

- 域名已正确解析到 Ingress 入口
- 443 端口可直接访问
- Docker 客户端可以直接访问 `https://harbor.example.com`

推荐登录方式：

```bash
echo '<HARBOR_ADMIN_PASSWORD>' | docker login harbor.example.com \
  -u admin \
  --password-stdin
```

说明：

- 这是与 `externalURL=https://harbor.example.com` 一致的访问方式
- 相比 `docker login -p`，`--password-stdin` 更安全，避免明文密码出现在命令历史中

### 方案二：内网端口映射访问

适用场景：

- 内网环境通过 `hosts` 解析访问 Harbor
- Ingress 或上游负载均衡未使用默认 443，而是映射到了自定义端口
- 实际访问入口为 `harbor.example.com:32760`

登录示例：

```bash
echo '<HARBOR_ADMIN_PASSWORD>' | docker login harbor.example.com:32760 \
  -u admin \
  --password-stdin
```

说明：

- 原始部署命令使用的是 Ingress 暴露模式，但登录示例带有 `:32760` 端口
- 这通常意味着环境中还存在额外的四层转发、NodePort 或内网网关映射
- 如果浏览器访问地址和 Docker 登录地址不一致，应以实际入口地址为准

## 部署后检查

### 查看 Helm Release

```bash
helm list -n harbor
```

### 查看 Harbor Pod 状态

```bash
kubectl get pods -n harbor
```

### 查看 Ingress

```bash
kubectl get ingress -n harbor
```

### 查看 PVC 绑定情况

```bash
kubectl get pvc -n harbor
```

### 查看 TLS Secret

```bash
kubectl get secret -n harbor exampleapp-tls
```

## 推荐的镜像推送验证

登录成功后，可使用以下流程验证仓库是否可用：

```bash
docker pull busybox:latest
docker tag busybox:latest harbor.example.com/library/busybox:latest
docker push harbor.example.com/library/busybox:latest
```

如果实际访问使用的是自定义端口，则镜像地址应改为：

```bash
docker tag busybox:latest harbor.example.com:32760/library/busybox:latest
docker push harbor.example.com:32760/library/busybox:latest
```

## 配置说明与选择建议

### 使用华为云 SWR 镜像源

该部署方案未直接使用默认 Harbor 官方镜像，而是显式指定了各组件镜像仓库地址。适用场景通常包括：

- 集群所在网络访问 Docker Hub 或其他公共镜像源受限
- 需要使用国内镜像源提升拉取速度
- 需要统一控制 Harbor 各组件镜像来源

建议：

- 若当前网络环境稳定访问官方镜像源，可以考虑后续切回官方默认配置，以减少自定义镜像源维护成本
- 若生产环境长期位于受限网络，保留当前镜像源配置更稳妥

### 持久化配置

当前方案启用了 Harbor 核心组件持久化，适合作为长期运行的私有仓库。

建议重点确认以下内容：

- `nfs-storage` 是否支持 `ReadWriteOnce`/`ReadWriteMany` 等当前 PVC 所需访问模式
- NFS 后端性能是否满足镜像推送与扫描需求
- Registry 的 `100Gi` 容量是否符合实际镜像规模

### Metrics 与 Trivy

当前配置已启用：

- `metrics.enabled=true`
- Trivy 组件持久化与镜像配置

适用场景：

- 需要接入 Prometheus/Grafana 进行运行状态监控
- 需要对镜像进行基础漏洞扫描

如果环境对资源较敏感，可结合实际情况评估是否保留 Trivy。

## 常见问题与排查方式

### 1. Helm 安装成功但 Pod 长时间未就绪

排查方向：

- 查看 Pod 事件
- 查看 PVC 是否绑定成功
- 查看镜像是否拉取失败

常用命令：

```bash
kubectl describe pod -n harbor <pod-name>
kubectl get events -n harbor --sort-by=.lastTimestamp
kubectl get pvc -n harbor
```

### 2. 域名无法访问 Harbor

排查方向：

- 检查域名解析是否指向正确入口
- 检查 Ingress Controller 是否正常
- 检查 Ingress Class 是否为 `nginx`

常用命令：

```bash
kubectl get ingress -n harbor
kubectl describe ingress -n harbor
kubectl get pods -A | grep -i ingress
```

### 3. Docker 登录失败

排查方向：

- 登录地址是否与实际访问入口一致
- TLS 证书是否与访问域名匹配
- 是否误用了自定义端口

建议优先确认：

- 浏览器访问的是 `https://harbor.example.com` 还是 `https://harbor.example.com:32760`
- `externalURL` 与客户端实际访问入口是否一致

### 4. 证书 Secret 创建失败

排查方向：

- 证书文件路径是否正确
- 证书与私钥是否匹配
- 执行命令时所在目录是否包含证书文件

### 5. 重复执行安装命令失败

原因通常包括：

- 命名空间已存在
- TLS Secret 已存在
- Helm Release `harbor` 已存在

处理建议：

- 首次部署使用 `helm install`
- 后续变更配置建议改用 `helm upgrade --install`

示例：

```bash
helm upgrade --install harbor harbor/harbor -n harbor --create-namespace --version 1.18.2
```

## 安全与运维建议

- 不建议在正式环境长期使用示例中的固定管理员密码，应在部署后立即修改
- 不建议继续使用 `docker login -p` 方式传递密码
- 建议将 Harbor 域名、证书、存储类、密码等参数统一沉淀到独立 `values.yaml` 中，减少长命令维护成本
- 若后续需要多环境复用，优先改造成 `helm upgrade --install -f values.yaml` 方式

## 建议的后续优化

1. 将当前 `--set` 参数整理为 `values.yaml`
2. 将管理员密码改为通过 Secret 或 CI/CD 变量注入
3. 为 Harbor 接入外部数据库与 Redis，以提升生产环境可维护性
4. 为 Ingress 增加访问控制、证书自动续期和审计策略
