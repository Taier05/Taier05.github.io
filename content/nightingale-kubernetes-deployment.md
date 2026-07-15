# Nightingale 监控平台部署与扩展采集手册

> 版本与变更提示：本文保留的是经过整理的部署示例，不代表所有版本的默认值。执行 Helm 升级或存储切换前，请先备份 values 与持久化数据，在测试环境核对 Chart 差异，并准备回滚版本。将原 Prometheus 副本缩容为 0 会停止其采集与查询，必须在 VictoriaMetrics 写入、查询和告警全部验证后再执行。

## 背景与目标

本文用于说明在 Kubernetes 集群中部署 Nightingale（n9e）监控平台，并根据场景选择内置 Prometheus 或 VictoriaMetrics 作为时序存储。同时给出通过 Categraf 接入 kube-state-metrics 与 Elasticsearch 指标的标准方式，便于后续扩展其他中间件监控。

## 环境说明

- Kubernetes 集群可正常使用 `kubectl` 和 `helm`
- 目标命名空间：`monitoring`
- 持久化存储类：`nfs-storage`
- 镜像仓库使用华为云 SWR 镜像地址
- 文中示例 Categraf 版本：`v0.4.22`
- 文中示例 Nightingale 版本：`8.4.0`
- 文中示例 VictoriaMetrics 镜像：`registry.example.com/monitoring/victoria-metrics:v1.134.0`

## Nightingale 部署

建议优先使用已验证过的 Helm 模板；如果重新拉取模板，部署前应检查参数项是否变更，尤其是 `n9e-helm/values.yaml`。

```bash
# 安装n9e
# 用保存好的模板(建议)
# 或者
# 拉取新的模板(一定要检查下参数是否有更新，比如n9e-helm/values.yaml)
git clone https://github.com/flashcatcloud/n9e-helm.git 

# 夜莺磁盘使用率异常修复（一定要做了才能执行下面的helm upgrade）
# vi <WORKDIR>/n9e-helm/templates/categraf/daemonset.yaml
# 找到
# - mountPath: /hostfs
#   name: hostrofs
#   readOnly: true
# 改为
# - mountPath: /hostfs
#   name: hostrofs
#   readOnly: true
#   mountPropagation: HostToContainer

helm upgrade --install nightingale ./n9e-helm -n monitoring --create-namespace \
  --set persistence.persistentVolumeClaim.database.storageClass=nfs-storage \
  --set persistence.persistentVolumeClaim.database.size=10Gi \
  --set persistence.persistentVolumeClaim.redis.storageClass=nfs-storage \
  --set persistence.persistentVolumeClaim.redis.size=10Gi \
  --set persistence.persistentVolumeClaim.prometheus.storageClass=nfs-storage \
  --set persistence.persistentVolumeClaim.prometheus.size=100Gi \
  --set expose.type=nodePort \
  --set database.internal.resources.requests.memory=2Gi \
  --set database.internal.resources.requests.cpu=1000m \
  --set database.internal.resources.limits.memory=2Gi \
  --set database.internal.resources.limits.cpu=1000m \
  --set redis.internal.resources.requests.memory=1Gi \
  --set redis.internal.resources.requests.cpu=1000m \
  --set redis.internal.resources.limits.memory=2Gi \
  --set redis.internal.resources.limits.cpu=1000m \
  --set prometheus.internal.resources.requests.memory=2Gi \
  --set prometheus.internal.resources.requests.cpu=1000m \
  --set prometheus.internal.resources.limits.memory=4Gi \
  --set prometheus.internal.resources.limits.cpu=4000m \
  --set prometheus.internal.retention=30d \
  --set n9e.internal.image.tag=8.4.0 \
  --set n9e.internal.image.repository=registry.example.com/monitoring/nightingale \
  --set database.internal.image.tag=5.7 \
  --set database.internal.image.repository=registry.example.com/monitoring/mysql \
  --set nginx.image.tag=stable-alpine \
  --set nginx.image.repository=registry.example.com/monitoring/nginx \
  --set redis.internal.image.tag=6.2 \
  --set redis.internal.image.repository=registry.example.com/monitoring/redis \
  --set prometheus.internal.image.tag=v2.54.1 \
  --set prometheus.internal.image.repository=registry.example.com/monitoring/prometheus \
  --set categraf.internal.image.tag=v0.4.22 \
  --set categraf.internal.image.repository=registry.example.com/monitoring/categraf
```

### 访问与初始登录

- 访问地址示例：`http://<NODE_IP>:<NODE_PORT>`
- 初始账号：`root`
- 初始密码：`root.2020`

首次登录后建议立即修改默认密码，并确认 `NodePort` 是否符合当前集群的暴露策略。

### 数据源配置

如果使用内置 Prometheus，可在 Nightingale 中添加以下数据源：

```text
http://nightingale-prometheus:9090
```

## 时序库方案选择

### 方案一：使用 Nightingale 内置 Prometheus

适用场景：

- 中小规模集群
- 快速搭建 PoC 或测试环境
- 希望减少组件数量，降低维护复杂度

特点：

- 部署最直接，安装命令已包含 Prometheus 组件
- 与 Nightingale 默认集成方式一致
- 适合先上线、后扩展

### 方案二：改用 VictoriaMetrics Single 作为时序库

适用场景：

- 指标存储量较大
- 希望更高的压缩率与更轻量的时序数据库方案
- 已经确定不再继续使用内置 Prometheus 作为长期存储

特点：

- 更适合作为正式环境的单机版时序存储
- Nightingale 只需改写入地址和数据源地址即可接入
- 完成切换后，可将内置 Prometheus 缩容为 `0`

### VictoriaMetrics 部署与切换步骤

```bash
# 改用VictoriaMetrics做时序库
# VictoriaMetrics Single 做时序库
helm repo add vm https://victoriametrics.github.io/helm-charts/
helm repo update

helm upgrade --install vm-single vm/victoria-metrics-single -n monitoring --create-namespace --version 0.29.0 \
  --set server.persistentVolume.enabled=true \
  --set server.image.repository=registry.example.com/monitoring/victoria-metrics \
  --set server.image.tag=v1.134.0 \
  --set server.persistentVolume.storageClassName=nfs-storage \
  --set server.persistentVolume.size=100Gi \
  --set server.retentionPeriod=30d \
  --set server.resources.requests.cpu=1000m \
  --set server.resources.requests.memory=2Gi \
  --set server.resources.limits.cpu=4000m \
  --set server.resources.limits.memory=4Gi
```

修改 Nightingale 写入地址：

```bash
# 更改n9e数据写入地址为VictoriaMetrics
kubectl edit cm -n monitoring n9e-config
```

将配置中的写入地址调整为：

```powershell
Url = "http://vm-single-victoria-metrics-single-server.monitoring.svc:8428/api/v1/write"  # 改为这个
```

完成修改后重启 Nightingale：

```bash
# 重启n9e
kubectl rollout restart deployment nightingale-center -n monitoring
```

web界面 同时将 Nightingale 的查询数据源指向：

```text
http://vm-single-victoria-metrics-single-server.monitoring.svc:8428
```

确认切换稳定后，可执行：

```bash
# 将prometheus 缩容到0
kubectl scale statefulsets nightingale-prometheus -n monitoring --replicas=0
```

## Categraf 扩展采集

对于 KSM、Elasticsearch 以及其他可暴露 Prometheus 指标的中间件，均可通过 Categraf 的 `input.prometheus` 方式接入。整体思路是：

1. 为目标监控对象准备对应的 `/metrics` 暴露地址。
2. 通过 ConfigMap 写入 `prometheus.toml`。
3. 单独部署一个 Categraf Deployment，挂载公共配置与目标采集配置。

### kube-state-metrics 监控

先部署 kube-state-metrics：

```bash
# KSM监控
# 先部署KSM kube-state-metrics
git clone https://github.com/kubernetes/kube-state-metrics
kubectl apply -k kube-state-metrics/examples/standard/
```

再部署 Categraf：

```bash
# 部署categraf
kubectl apply -f categraf-ksm.yaml # 根据情况修改配置文件后执行
```

推荐配置如下：

```yaml
---
kind: ConfigMap
metadata:
  name: categraf-kube-state-metrics-config
  namespace: monitoring
apiVersion: v1
data:
  prometheus.toml: |
    [[instances]]
    urls = ["http://kube-state-metrics.kube-system.svc.cluster.local:8080/metrics"]
    labels = { job="kube-state-metrics" }
---
apiVersion: apps/v1
kind: Deployment
metadata:
  labels:
    app: categraf
  name: categraf-kube-state-metrics
  namespace: monitoring
spec:
  replicas: 1
  selector:
    matchLabels:
      app: categraf
  template:
    metadata:
      labels:
        app: categraf
    spec:
      containers:
      - env:
        - name: TZ
          value: Asia/Shanghai
        - name: HOSTNAME
          valueFrom:
            fieldRef:
              apiVersion: v1
              fieldPath: spec.nodeName
        - name: HOSTIP
          valueFrom:
            fieldRef:
              apiVersion: v1
              fieldPath: status.hostIP
        image: registry.example.com/monitoring/categraf:v0.4.22
        imagePullPolicy: IfNotPresent
        name: categraf
        volumeMounts:
        - mountPath: /etc/categraf/conf
          name: categraf-config
        - mountPath: /etc/categraf/conf/input.prometheus
          name: categraf-kube-state-metrics-config
      restartPolicy: Always
      volumes:
      - configMap:
          name: categraf-config
        name: categraf-config
      - configMap:
          name: categraf-kube-state-metrics-config
        name: categraf-kube-state-metrics-config
```

适用说明：

- 适合采集 Kubernetes 资源对象状态类指标
- 用于工作负载、副本数、Pod 状态、节点对象状态等监控与告警
- 前提是 `kube-state-metrics` 服务地址与端口可达

### Elasticsearch 监控

前提条件是 Elasticsearch 必须先暴露监控端口。

部署命令：

```bash
# elasticsearch 监控
# elasticsearch 必须暴露监控端口
# 部署categraf
kubectl apply -f categraf-elasticsearch.yaml # 根据情况修改配置文件后执行
# 其他中间件类似
```

推荐配置如下：

```yaml
---
kind: ConfigMap
metadata:
  name: categraf-elasticsearch-config
  namespace: monitoring
apiVersion: v1
data:
  prometheus.toml: |
    [[instances]]
    urls = ["http://elasticsearch-metrics.elasticsearch.svc.cluster.local:9114/metrics"]
    labels = { cluster="elasticsearch",instance="<ELASTICSEARCH_CLUSTER>" }
---
apiVersion: apps/v1
kind: Deployment
metadata:
  labels:
    app: categraf
  name: categraf-elasticsearch
  namespace: monitoring
spec:
  replicas: 1
  selector:
    matchLabels:
      app: categraf
  template:
    metadata:
      labels:
        app: categraf
    spec:
      containers:
      - env:
        - name: TZ
          value: Asia/Shanghai
        - name: HOSTNAME
          valueFrom:
            fieldRef:
              apiVersion: v1
              fieldPath: spec.nodeName
        - name: HOSTIP
          valueFrom:
            fieldRef:
              apiVersion: v1
              fieldPath: status.hostIP
        image: registry.example.com/monitoring/categraf:v0.4.22
        imagePullPolicy: IfNotPresent
        name: categraf
        volumeMounts:
        - mountPath: /etc/categraf/conf
          name: categraf-config
        - mountPath: /etc/categraf/conf/input.prometheus
          name: categraf-elasticsearch-config
      restartPolicy: Always
      volumes:
      - configMap:
          name: categraf-config
        name: categraf-config
      - configMap:
          name: categraf-elasticsearch-config
        name: categraf-elasticsearch-config
```

适用说明：

- 适合采集 Elasticsearch 集群运行指标
- 依赖 `elasticsearch-exporter` 或等效指标暴露端点
- 建议通过标签区分集群名、实例名，便于告警与看板筛选

## 多方案选择建议

### 存储方案选择

- 优先快速上线：使用 Nightingale 内置 Prometheus
- 更关注长期存储与资源效率：使用 VictoriaMetrics Single
- 如果当前环境已经依赖 Prometheus 查询链路，可先保持内置 Prometheus，待验证完成后再切换到 VictoriaMetrics

### 采集方案选择

- Kubernetes 资源状态监控：选择 kube-state-metrics + Categraf
- 中间件业务监控：选择 exporter 或原生 `/metrics` + Categraf
- 多种中间件并存时，建议每类监控对象独立一个 ConfigMap 与 Deployment，便于版本调整与故障隔离

## 注意事项

- 重新拉取 `n9e-helm` 模板后，应优先核对 `values.yaml` 是否新增、删除或重命名关键参数。
- 所有 `storageClass`、PVC 容量、资源限制应根据集群实际容量调整。
- 切换 VictoriaMetrics 前，应先确认 Nightingale 写入配置与查询数据源都已同步修改。
- 在确认 VictoriaMetrics 稳定接管写入前，不建议立即缩容内置 Prometheus。
- Categraf 采集依赖公共配置 `categraf-config`，部署前需确认该 ConfigMap 已存在于 `monitoring` 命名空间。
- `categraf-ksm.yaml` 中的 KSM 地址默认位于 `kube-system` 命名空间，若实际部署位置不同，应同步修改 URL。
- `categraf-elasticsearch.yaml` 中的采集地址依赖 `elasticsearch-metrics` 服务名和 `9114` 端口，部署前需确认服务发现名称与暴露端口正确。

## 常见问题与排查

### Nightingale 页面无法访问

- 检查 `nightingale` 服务的暴露方式是否仍为 `NodePort`
- 核对访问地址中的节点 IP 和端口是否正确
- 确认安全组、防火墙、集群网络策略未阻断访问

### Nightingale 无数据或写入异常

- 检查 Nightingale 数据源地址是否配置正确
- 如果已切换 VictoriaMetrics，确认写入地址是否为 `/api/v1/write`
- 执行 `kubectl rollout restart deployment nightingale-center -n monitoring` 后再次验证

### Categraf 已部署但没有指标

- 确认目标 `/metrics` 地址在集群内可达
- 检查 Deployment 是否成功挂载了 `categraf-config` 和对应监控对象 ConfigMap
- 查看 Categraf Pod 日志，确认 TOML 配置是否生效

### 切换 VictoriaMetrics 后仍查询不到历史数据

- 确认 Nightingale 查询数据源已从内置 Prometheus 切换到 VictoriaMetrics 服务地址
- 如果原 Prometheus 已缩容为 `0`，此前未迁移的历史数据将无法继续查询
- 正式切换前建议先验证新写入数据和看板查询是否正常

## 参考资料

- [Nightingale 官方 Helm Chart](https://github.com/flashcatcloud/n9e-helm)
- [Nightingale 数据源接入文档](https://flashcat.cloud/docs/content/flashcat-monitor/nightingale-v7/integrations/datasource/)
