# Helm 与 ChartMuseum 私有仓库部署操作手册

> 安全提示：示例已移除内部仓库地址。生产 ChartMuseum 应启用 TLS 与 Basic/Bearer 认证、限制上传和删除权限，并使用具备备份能力的持久化存储；不要长期使用 runAsUser 0 或 777 权限。执行 helm uninstall 前确认 Release、命名空间、PVC 保留策略和回滚需求。

## 背景与目标

在 Kubernetes 环境中，Helm 用于统一管理应用 Chart 的打包、分发、安装、升级与回滚。为降低外网依赖、提升交付稳定性，可结合 ChartMuseum 搭建内部 Helm 仓库，提供统一的 Chart 存储与发布入口。

本文档给出 Helm 安装、仓库管理、Chart 拉取与打包、ChartMuseum 私有仓库部署，以及常见操作与注意事项。适用于以下场景：

- 需要在内网或受限网络环境中使用 Helm
- 需要维护企业内部 Chart 仓库
- 需要同时支持 Docker 单机部署和 Kubernetes 集群部署
- 需要同步上游镜像到自有镜像仓库后再落地使用

## 环境说明

- 操作系统：Linux
- Helm：建议使用 Helm 3
- Kubernetes：适用于已具备 Ingress 能力的集群
- 私有镜像仓库示例：`registry.example.com/charts`
- ChartMuseum 服务端口：`8080`
- Kubernetes 命名空间示例：`infra`

## Helm 安装

优先使用官方二进制安装方式，便于明确版本与升级策略。

```bash
tar -zxvf helm-v3.8.2-linux-amd64.tar.gz
mv linux-amd64/helm /usr/local/bin/helm
helm version
echo "source <(helm completion bash)" >> ~/.bashrc
source ~/.bashrc
```

也可使用官方安装脚本：

```bash
curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash
helm version --short
```

参考文档：<https://helm.sh/zh/docs/intro/install/>

## Helm 仓库管理

### 添加仓库

```bash
helm repo add bitnami https://charts.bitnami.com/bitnami
helm repo add aliyun https://kubernetes.oss-cn-hangzhou.aliyuncs.com/charts
helm repo add internal-charts http://charts.example.com/
```

说明：

- `bitnami` 适合作为常用基础组件 Chart 来源
- `aliyun` 可作为部分环境下的替代源
- `internal-charts` 为内部 ChartMuseum 仓库示例

### 删除仓库

```bash
helm repo remove aliyun
```

### 查看仓库与可用 Chart

```bash
helm repo list
helm search repo
helm search repo nginx
helm search repo harbor/harbor -l
helm search repo bitnami/elasticsearch -l
helm search repo prometheus-community/kube-prometheus-stack -l
helm search repo vm/victoria-metrics-single -l
```

建议在安装前先查看可用版本，再明确指定版本，避免上游更新导致部署结果漂移。

## Chart 拉取与本地准备

### 拉取 Chart 到本地目录

```bash
helm pull bitnami/elasticsearch --version 21.3.24 --untar
helm pull bitnami/kafka --version 31.4.0 --untar
helm pull harbor/harbor --version 1.18.2 --untar
helm pull prometheus-community/kube-prometheus-stack --version 81.3.0 --untar
helm pull vm/victoria-metrics-single --version 0.29.0 --untar
```

说明：

- `--untar` 会直接解压到当前目录，便于修改 `values.yaml`
- 历史命令中存在带 `v` 前缀的版本写法，实际使用时应以仓库中可查询到的真实版本号为准

### 查看 Chart 默认配置

```bash
helm show values bitnami/wordpress
```

## Chart 安装、升级与回滚

### 安装 Chart

```bash
helm install mysql-01 bitnami/mysql
```

如果需要自动生成 Release 名称：

```bash
helm install bitnami/mysql --generate-name
```

### 使用自定义配置安装

示例 `values.yaml`：

```yaml
mariadb:
  auth:
    database: user0db
    username: user0
```

安装命令：

```bash
helm install -f values.yaml my-wordpress bitnami/wordpress
```

也可通过 `--set` 传参：

```bash
helm install my-app bitnami/wordpress \
  --set servers[0].port=80,servers[0].host=example
```

对应配置结构：

```yaml
servers:
  - port: 80
    host: example
```

建议：

- 简单参数覆盖可使用 `--set`
- 配置项较多时使用独立 `values.yaml` 更易维护

### 查看已安装 Release

```bash
helm ls
```

### 卸载 Release

```bash
helm uninstall mysql-1612624192 -n default
```

### 升级 Release

```bash
helm upgrade -f panda.yaml happy-panda bitnami/wordpress
```

### 查看历史版本与回滚

```bash
helm history nginx-1728386725
helm rollback happy-panda 1
```

## 自定义 Chart 开发与打包

### 创建 Chart 骨架

```bash
helm create wordpress
```

默认目录结构如下：

```text
wordpress/
├── charts
├── Chart.yaml
├── templates
│   ├── deployment.yaml
│   ├── _helpers.tpl
│   ├── hpa.yaml
│   ├── ingress.yaml
│   ├── NOTES.txt
│   ├── serviceaccount.yaml
│   ├── service.yaml
│   └── tests
│       └── test-connection.yaml
└── values.yaml
```

### 打包 Chart

```bash
helm package .
```

如果当前目录为 Chart 根目录，执行后将生成 `.tgz` 包，可用于推送到私有仓库。

## ChartMuseum 部署方案

ChartMuseum 适合作为 Helm 私有仓库服务端。本文保留两种可用方案：

- Docker 部署：适合单机快速验证、测试环境或临时仓库
- Kubernetes 部署：适合集群内长期运行，并通过 PVC 持久化

### 方案一：Docker 部署

适用场景：

- 无需依赖 Kubernetes
- 需要快速启动一个私有 Helm 仓库
- 本地开发、测试或小规模使用

部署命令：

```bash
mkdir -p /docker/charts
chmod -R 777 /docker/charts

docker run -d \
  -p 8080:8080 \
  -e DEBUG=1 \
  -e STORAGE=local \
  -e STORAGE_LOCAL_ROOTDIR=/charts \
  --name=chartmuseum \
  -v /docker/charts:/charts \
  registry.example.com/charts/chartmuseum:latest
```

验证：

```bash
curl localhost:8080/api/charts
```

说明：

- 本地目录 `/docker/charts` 用于持久化 Chart 数据
- `DEBUG=1` 便于初期排错，生产环境可按需关闭
- `chmod 777` 虽便于快速启动，但生产环境建议按实际运行用户收敛目录权限

### 方案二：Kubernetes 部署

适用场景：

- 需要在集群内长期运行 ChartMuseum
- 需要通过 PV/PVC 持久化数据
- 需要通过 Ingress 对外提供访问入口

推荐配置示例：

```yaml
---
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: chartmuseum-local
provisioner: kubernetes.io/no-provisioner
volumeBindingMode: WaitForFirstConsumer
---
apiVersion: v1
kind: PersistentVolume
metadata:
  name: chartmuseum-pv
spec:
  capacity:
    storage: 20Gi
  accessModes:
    - ReadWriteOnce
  persistentVolumeReclaimPolicy: Retain
  storageClassName: chartmuseum-local
  local:
    path: /pvc/chartmuseum_data
  nodeAffinity:
    required:
      nodeSelectorTerms:
        - matchExpressions:
            - key: kubernetes.io/hostname
              operator: In
              values:
                - node-1
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: chartmuseum-pvc
  namespace: infra
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: chartmuseum-local
  resources:
    requests:
      storage: 20Gi
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: chartmuseum
  namespace: infra
spec:
  replicas: 1
  selector:
    matchLabels:
      app: chartmuseum
  template:
    metadata:
      labels:
        app: chartmuseum
    spec:
      terminationGracePeriodSeconds: 30
      containers:
        - name: chartmuseum
          image: registry.example.com/charts/chartmuseum:v0.13.1
          args:
            - --storage=local
            - --storage-local-rootdir=/charts
          securityContext:
            runAsUser: 0
          resources:
            requests:
              memory: "128Mi"
              cpu: "100m"
          ports:
            - containerPort: 8080
              name: server
          readinessProbe:
            tcpSocket:
              port: 8080
          volumeMounts:
            - name: datadir
              mountPath: /charts
      volumes:
        - name: datadir
          persistentVolumeClaim:
            claimName: chartmuseum-pvc
---
apiVersion: v1
kind: Service
metadata:
  name: chartmuseum
  namespace: infra
spec:
  selector:
    app: chartmuseum
  ports:
    - name: server
      port: 8080
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: chartmuseum
  namespace: infra
spec:
  ingressClassName: nginx
  rules:
    - host: charts.example.com
      http:
        paths:
          - path: /
            pathType: ImplementationSpecific
            backend:
              service:
                name: chartmuseum
                port:
                  number: 8080
```

部署前需要确认：

- `node-1` 必须替换为实际存储所在节点的主机名
- `/pvc/chartmuseum_data` 必须在目标节点上提前创建
- `infra` 命名空间必须已存在
- Ingress 控制器已就绪，且域名 `charts.example.com` 已正确解析

说明：

- 当前方案使用本地盘 `local PV`，适合单节点绑定场景
- 若需要跨节点高可用，建议改造为网络存储或对象存储方案
- `persistentVolumeReclaimPolicy: Retain` 可避免误删 PVC 时直接清空数据

## Chart 推送与发布

### 安装推送插件

```bash
helm plugin install https://github.com/chartmuseum/helm-push.git
```

### 打包并推送 Chart

```bash
helm package ./mychart
helm cm-push mychart-1.0.0.tgz myrepo
helm repo update
```

说明：

- `myrepo` 需提前通过 `helm repo add` 配置为 ChartMuseum 仓库
- 推送完成后执行 `helm repo update`，客户端才能及时拉到最新索引

### 使用 HTTP 接口直接上传

```bash
curl --data-binary "@mychart-0.1.0.tgz" http://localhost:8080/api/charts
```

适用场景：

- 不希望安装 Helm 插件
- 需要在 CI/CD 中直接使用 HTTP 接口上传

## 镜像同步与受限网络处理

在网络受限或集群无法直接访问公共镜像源时，可先拉取上游镜像，再重标记并推送到内部或云上镜像仓库。

示例：

```bash
IMAGE_NAME="bitnamilegacy/mysql:8.0.39-debian-12-r0"
docker pull "$IMAGE_NAME"

IMAGE_VER="mysql:bitnami.8.0.39-debian-12-r0"
docker tag "$IMAGE_NAME" "registry.example.com/charts/$IMAGE_VER"
docker push "registry.example.com/charts/$IMAGE_VER"

echo "上传镜像成功：registry.example.com/charts/$IMAGE_VER"

docker rmi "registry.example.com/charts/$IMAGE_VER"
docker rmi "$IMAGE_NAME"
```

说明：

- 原始脚本中的变量名写成了 `IMGAE_NAME`，建议修正为 `IMAGE_NAME`
- 推送完成后删除本地镜像，可减少磁盘占用
- 建议统一约定镜像命名规则，便于 Helm values 中批量替换镜像地址

常见预拉取镜像示例：

```bash
docker pull bitnamilegacy/elasticsearch:7.17.5
docker pull bitnamilegacy/os-shell:12-debian-12-r33
docker pull bitnamilegacy/elasticsearch-exporter:1.3.0-debian-11-r14
docker pull bitnamilegacy/kibana:7.17.5
docker pull bitnamilegacy/kibana:8.17.0
docker pull elastic/filebeat:8.17.0
```

## 多方案选择建议

### Docker 与 Kubernetes 部署如何选择

- 仅用于本机测试或临时仓库时，优先使用 Docker 部署，启动快、依赖少
- 需要团队共用、长期运行、通过域名访问时，优先使用 Kubernetes 部署
- 需要与集群内业务统一纳管、统一备份、统一暴露入口时，应选择 Kubernetes 部署

### 本地盘 PV 与其他存储方案如何选择

- 单节点、低复杂度场景可继续使用本地盘 PV
- 涉及节点迁移、容灾或高可用时，不建议继续依赖本地盘路径绑定
- 如果后续需要扩展为高可用仓库，应考虑共享存储或对象存储后端

### `--set` 与 `values.yaml` 如何选择

- 参数少、临时调试时使用 `--set`
- 长期维护、多人协作、环境差异明显时使用 `values.yaml`

## 注意事项

- Helm 安装和 Chart 拉取前，先确认仓库源可达
- 安装前应固定 Chart 版本，避免隐式升级
- 使用 ChartMuseum 时，必须保证存储目录持久化
- 使用本地盘 PV 时，Pod 调度会受节点绑定限制
- Ingress 域名需要提前完成 DNS 或 hosts 配置
- 生产环境应审查容器运行用户、目录权限与镜像来源，不建议长期依赖 `runAsUser: 0` 和 `777` 权限

## 常见问题与排查

### `helm search repo` 查不到新包

处理方式：

```bash
helm repo update
helm search repo <repo-name>/<chart-name> -l
```

### ChartMuseum 已启动但无法上传 Chart

检查项：

- 服务端口 `8080` 是否正常监听
- 存储目录是否已挂载并具备写权限
- 是否访问了正确的上传接口 `/api/charts`
- 是否已安装 `helm-push` 插件

### Kubernetes 中 ChartMuseum Pod 无法启动

检查项：

- PVC 是否成功绑定 PV
- `nodeAffinity` 中节点名称是否正确
- 节点本地目录是否存在
- `infra` 命名空间是否存在
- 镜像地址是否可拉取

### Ingress 域名无法访问

检查项：

- Ingress Controller 是否正常运行
- `ingressClassName: nginx` 是否与集群实际控制器一致
- 域名解析是否指向 Ingress 入口地址
- Service 与 Pod 标签是否匹配

## 推荐执行顺序

1. 安装 Helm 并验证版本
2. 添加公共仓库与内部仓库
3. 查询并确定目标 Chart 版本
4. 拉取 Chart 到本地并按需修改 `values.yaml`
5. 在受限网络环境下先同步依赖镜像到私有镜像仓库
6. 部署 ChartMuseum
7. 配置客户端仓库地址并执行推送、安装、升级与回滚

## 参考资料

- [ChartMuseum 官方文档](https://chartmuseum.com/docs/)
- [Helm Chart Repository Guide](https://helm.sh/docs/topics/chart_repository/)
