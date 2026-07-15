# vSphere 监控接入与 Categraf 部署手册

> 凭据与证书提示：示例中的 vCenter 地址、账号和密码均为占位符。Kubernetes Secret 默认只是 base64 编码，并不等同于加密；生产环境应启用静态加密或接入外部密钥系统。优先校验 vCenter 证书，只有临时诊断自签名证书问题时才考虑跳过校验。

## 背景与目标

本文用于在 `monitoring` 命名空间中接入 VMware vSphere 监控数据，并统一交由 Categraf 采集。当前可落地的方式有两种：

1. 部署 `vmware_exporter` 暴露 Prometheus 指标，再由 Categraf 通过 `input.prometheus` 抓取。
2. 由 Categraf 直接使用 `input.vsphere` 连接 vCenter 采集。

对于大多数已经采用 Prometheus 指标采集链路的环境，优先推荐方案一；如果希望减少中间组件，或需要直接使用 Categraf 的 vSphere 输入能力，可采用方案二。

## 环境说明

- Kubernetes 命名空间：`monitoring`
- 时区：`Asia/Shanghai`
- Categraf 镜像：`registry.example.com/monitoring/categraf:v0.4.22`
- vmware_exporter 镜像：`registry.example.com/monitoring/vmware_exporter:v0.18.4`
- vCenter SDK 地址格式：`https://<vcenter>/sdk`

## 方案选择建议

### 方案一：vmware_exporter + Categraf Prometheus 采集

适用场景：

- 监控体系已经以 Prometheus 指标暴露为主
- 希望将 vSphere 凭据集中交给 exporter 管理
- 希望 Categraf 侧保持统一的 Prometheus 抓取方式

特点：

- 组件多一层，但职责清晰
- exporter 通过 Service 暴露 `9272` 端口，便于复用和排查
- 凭据通过独立 Secret 注入，配置维护更直观

### 方案二：Categraf 直连 vCenter

适用场景：

- 希望减少组件数量
- 希望直接使用 Categraf 的 `input.vsphere`
- 可以接受 Categraf 直接持有 vCenter 连接配置

特点：

- 架构更简单
- 采集压力直接落在 Categraf 实例上
- 现有配置已为该方案预留较高资源配额，更适合直连采集场景

## 推荐部署方案：vmware_exporter + Categraf

### 1. 创建 vCenter 访问凭据

```bash
# 创建vCenter密码密钥
kubectl -n monitoring create secret generic vmware-exporter-secret \
  --from-literal=VSPHERE_USER='<VCENTER_USER>' \
  --from-literal=VSPHERE_PASSWORD='<VCENTER_PASSWORD>'
```

如果需要更安全的做法，建议在执行前替换为实际账号密码，不在版本库中保留明文。

### 2. 部署 vmware_exporter

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: vmware-exporter
  namespace: monitoring
spec:
  replicas: 1
  selector:
    matchLabels:
      app: vmware-exporter
  template:
    metadata:
      labels:
        app: vmware-exporter
    spec:
      containers:
      - name: vmware-exporter
        image: registry.example.com/monitoring/vmware_exporter:v0.18.4
        ports:
        - containerPort: 9272
          name: http
        env:
        - name: VSPHERE_HOST
          value: "<VCENTER_HOST>"   # 改成你的 vCenter 地址/IP
        - name: VSPHERE_IGNORE_SSL
          value: "TRUE"
        - name: VSPHERE_FETCH_ALARMS
          value: "TRUE"
        - name: VSPHERE_COLLECT_VMS
          value: "FALSE"
        - name: VSPHERE_COLLECT_VMGUESTS
          value: "FALSE"
        - name: VSPHERE_COLLECT_HOSTS
          value: "TRUE"
        - name: VSPHERE_COLLECT_DATASTORES
          value: "TRUE"
        - name: VSPHERE_COLLECT_SNAPSHOTS
          value: "FALSE"
        - name: VSPHERE_USER
          valueFrom:
            secretKeyRef:
              name: vmware-exporter-secret
              key: VSPHERE_USER
        - name: VSPHERE_PASSWORD
          valueFrom:
            secretKeyRef:
              name: vmware-exporter-secret
              key: VSPHERE_PASSWORD
---
apiVersion: v1
kind: Service
metadata:
  name: vmware-exporter
  namespace: monitoring
spec:
  selector:
    app: vmware-exporter
  ports:
  - name: http
    port: 9272
    targetPort: 9272
```

部署命令：

```bash
# 部署exporter生成指标
kubectl -n monitoring apply -f vmware-exporter.yaml
```

### 3. 部署 Categraf 抓取 exporter 指标

```yaml
---
kind: ConfigMap
metadata:
  name: categraf-vmware-config
  namespace: monitoring
apiVersion: v1
data:
  prometheus.toml: |
    [[instances]]
    urls = ["http://vmware-exporter.monitoring.svc.cluster.local:9272/metrics"]
    labels = { cluster="test" }
---
apiVersion: apps/v1
kind: Deployment
metadata:
  labels:
    app: categraf
  name: categraf-vmware
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
          name: categraf-vmware-config
      restartPolicy: Always
      volumes:
      - configMap:
          name: categraf-config
        name: categraf-config
      - configMap:
          name: categraf-vmware-config
        name: categraf-vmware-config
```

部署命令：

```bash
# 部署n9e收集指标
kubectl -n monitoring apply -f categraf-vmware.yaml
```

### 4. 推荐执行顺序

```bash
kubectl -n monitoring create secret generic vmware-exporter-secret \
  --from-literal=VSPHERE_USER='<VCENTER_USER>' \
  --from-literal=VSPHERE_PASSWORD='<VCENTER_PASSWORD>'

kubectl -n monitoring apply -f vmware-exporter.yaml
kubectl -n monitoring apply -f categraf-vmware.yaml
```

## 备选方案：Categraf 直连 vCenter

当不希望额外部署 `vmware_exporter` 时，可直接使用以下方式。

```yaml
---
# 创建 Secret 存储 vsphere 配置
apiVersion: v1
kind: Secret
metadata:
  name: categraf-vsphere-config
  namespace: monitoring
type: Opaque
stringData:
  vsphere.toml: |
    interval = 60
    [[instances]]
      labels = { clustername="zhuhai", env="test" }
      vcenter  = "https://<VCENTER_HOST>/sdk"
      username = "<VCENTER_USER>"
      password = "<VCENTER_PASSWORD>"
      use_tls = true
      insecure_skip_verify = false
---
apiVersion: apps/v1
kind: Deployment
metadata:
  labels:
    app: categraf
  name: categraf-vsphere
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
        resources:
          requests:
            cpu: 1000m
            memory: 1000M
          limits:
            cpu: 2
            memory: 4Gi
        name: categraf
        volumeMounts:
        - mountPath: /etc/categraf/conf
          name: categraf-config
        - mountPath: /etc/categraf/conf/input.vsphere
          name: categraf-vsphere-config
      restartPolicy: Always
      volumes:
      - configMap:
          name: categraf-config
        name: categraf-config
      - secret:
          secretName: categraf-vsphere-config  # 改为 secret
        name: categraf-vsphere-config
```

使用建议：

- 如果直接连接 vCenter，优先保留 `Secret` 挂载方式，不要改回普通 `ConfigMap`
- 现有资源配置已经体现出该模式比普通 Prometheus 抓取更重，建议至少按上述 `requests/limits` 起步
- `insecure_skip_verify = false` 为推荐值；自签名证书应将可信 CA 注入容器，临时跳过校验只用于受控诊断

## 两种方案的差异与取舍

| 对比项 | vmware_exporter + Categraf | Categraf 直连 vCenter |
| --- | --- | --- |
| 组件数量 | 较多 | 较少 |
| 采集链路 | Prometheus `/metrics` | 原生 `input.vsphere` |
| 凭据位置 | exporter Secret | Categraf Secret |
| 排查方式 | 可直接访问 exporter 指标端点 | 主要查看 Categraf 日志与配置 |
| 资源压力 | 分散在 exporter 与 Categraf | 集中在 Categraf |
| 推荐场景 | 标准化监控接入、易复用 | 简化组件、直连采集 |

选择建议：

- 默认优先选择 `vmware_exporter + Categraf`，更符合 Prometheus 化采集习惯，也便于后续扩展。
- 如果集群内不希望增加 exporter 组件，或者更希望把 vSphere 采集逻辑收敛到 Categraf，可使用直连方案。

## 注意事项

- `categraf-vmware` 与 `categraf-vsphere` 都依赖已有的 `categraf-config`，部署前需确认基础配置已存在。
- `VSPHERE_HOST` 与 `vcenter` 地址必须与实际环境一致；直连方式需要使用 `/sdk` 路径。
- 时区统一设置为 `Asia/Shanghai`，如需与集群标准保持一致，可按环境规范调整。
- 示例只使用凭据占位符；生产环境应通过受控 Secret 或外部密钥系统下发，并限制读取权限。
- `labels = { cluster="test" }` 与 `labels = { clustername="zhuhai", env="test" }` 均会影响指标维度，应按实际集群命名统一。

## 常见问题与排查方式

### 1. exporter 已启动，但没有指标

检查项：

```bash
kubectl -n monitoring get pod -l app=vmware-exporter
kubectl -n monitoring get svc vmware-exporter
kubectl -n monitoring logs deploy/vmware-exporter
```

重点确认：

- `VSPHERE_HOST` 是否可达
- 用户名密码是否正确
- vCenter 证书是否需要忽略校验
- 当前启用的采集项是否符合预期，例如仅采集主机与存储，不采集虚拟机与快照

### 2. Categraf 未采集到 exporter 指标

检查项：

```bash
kubectl -n monitoring get pod -l app=categraf
kubectl -n monitoring logs deploy/categraf-vmware
kubectl -n monitoring get configmap categraf-vmware-config -o yaml
```

重点确认：

- `http://vmware-exporter.monitoring.svc.cluster.local:9272/metrics` 是否可解析、可访问
- `input.prometheus` 挂载路径是否正确
- `categraf-config` 是否存在且内容有效

### 3. Categraf 直连 vCenter 失败

检查项：

```bash
kubectl -n monitoring get secret categraf-vsphere-config -o yaml
kubectl -n monitoring logs deploy/categraf-vsphere
kubectl -n monitoring describe pod -l app=categraf
```

重点确认：

- `vsphere.toml` 是否成功挂载到 `/etc/categraf/conf/input.vsphere`
- `vcenter` 地址是否包含 `/sdk`
- 凭据是否正确
- `insecure_skip_verify` 是否符合当前证书环境
- 资源限制是否过低导致采集任务异常

## 参考资料

- [Categraf vSphere 插件](https://github.com/flashcatcloud/categraf/tree/main/inputs/vsphere)
- [vmware_exporter 发布记录](https://github.com/pryorda/vmware_exporter/releases)
