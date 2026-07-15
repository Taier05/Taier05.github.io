# iDRAC 指标采集部署与 Categraf 对接手册

> 安全提示：示例已移除真实 BMC 凭据和地址。请为监控创建最小权限只读账号，不要复用 iDRAC 管理员账号；限制 exporter 到 BMC 管理网的访问，并注意 Secret 默认不等同于加密存储。

## 背景与目标

本文用于在 `monitoring` 命名空间中部署 `idrac-exporter`，并通过 `categraf` 统一拉取 Dell iDRAC 指标，供监控系统持续采集与展示。文中同时给出基础部署方式、批量采集配置、适用场景以及常见注意事项。

## 环境说明

- Kubernetes 集群可正常执行 `kubectl apply`
- 监控命名空间为 `n9e`
- 已具备可访问目标 iDRAC 管理地址的网络连通性
- `idrac-exporter` 服务监听 `9348` 端口
- `categraf` 通过 `input.prometheus` 方式拉取 exporter 暴露的指标

## 部署架构

整体链路如下：

1. `idrac-exporter` 使用预置账号访问各台 iDRAC。
2. exporter 通过 `/metrics?target=<idrac-ip>` 暴露对应目标的采集结果。
3. `categraf` 按配置中的 URL 列表批量抓取 exporter 指标。
4. 监控平台统一接收 `categraf` 上报的指标数据。

这种方式适合将多台 iDRAC 的采集入口统一收敛到一个 exporter 服务，再由 `categraf` 做批量抓取。

## iDRAC Exporter 部署

以下清单包含 `Secret`、`Deployment` 和 `Service`，可直接部署：

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: idrac-exporter-config
  namespace: monitoring
type: Opaque
stringData:
  idrac.yml: |
    address: 0.0.0.0
    port: 9348
    timeout: 20
    hosts:
      default:
        username: "<IDRAC_USER>"
        password: "<IDRAC_PASSWORD>"
    metrics:
      all: true
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: idrac-exporter
  namespace: monitoring
  labels:
    app: idrac-exporter
spec:
  replicas: 1
  selector:
    matchLabels:
      app: idrac-exporter
  template:
    metadata:
      labels:
        app: idrac-exporter
    spec:
      containers:
        - name: idrac-exporter
          image: registry.example.com/monitoring/idrac_exporter:2.4.0
          imagePullPolicy: IfNotPresent
          args:
            - "-config=/etc/prometheus/idrac.yml"
          ports:
            - name: http
              containerPort: 9348
          volumeMounts:
            - name: config
              mountPath: /etc/prometheus/idrac.yml
              subPath: idrac.yml
          readinessProbe:
            httpGet:
              path: /health
              port: 9348
            initialDelaySeconds: 5
            periodSeconds: 10
      volumes:
        - name: config
          secret:
            secretName: idrac-exporter-config
---
apiVersion: v1
kind: Service
metadata:
  name: idrac-exporter
  namespace: monitoring
  labels:
    app: idrac-exporter
spec:
  selector:
    app: idrac-exporter
  ports:
    - name: http
      port: 9348
      targetPort: 9348
```

### 配置说明

- `stringData.idrac.yml` 中定义 exporter 监听地址、端口、超时时间以及默认 iDRAC 账号。
- `hosts.default` 表示未单独指定目标认证信息时统一使用该账号密码。
- `metrics.all: true` 表示开启全部指标采集。
- 容器使用 `-config=/etc/prometheus/idrac.yml` 加载配置文件。
- `readinessProbe` 基于 `/health` 做就绪检查，可用于避免服务未启动完成就被抓取。

### 使用建议

- 清单使用账号密码占位符；部署时应通过受控流程注入实际只读凭据。
- 如果不同设备账号不一致，应按 exporter 支持的主机维度配置方式进一步拆分认证信息；如果所有设备凭据一致，保留 `default` 配置更简单。
- 单副本已可满足基础采集；若后续目标数量较多，可结合实际抓取压力评估是否扩容。

## Categraf 拉取 iDRAC 指标

以下配置通过 `ConfigMap` 下发 `input.prometheus` 配置，并部署独立的 `categraf-idrac-metrics` 实例：

```yaml
---
kind: ConfigMap
metadata:
  name: categraf-input-idrac-metrics
  namespace: monitoring
apiVersion: v1
data:
  prometheus.toml: |
    [[instances]]
    # urls = ["http://idrac-exporter.monitoring.svc:9348/metrics?target=<IDRAC_IP_1>"]
    urls = [
      "http://idrac-exporter:9348/metrics?target=<IDRAC_IP_1>",
      "http://idrac-exporter:9348/metrics?target=<IDRAC_IP_2>",
      "http://idrac-exporter:9348/metrics?target=<IDRAC_IP_3>",
    ]
    url_label_key = "instance"
    url_label_value = "{{.Query}}"
---
apiVersion: apps/v1
kind: Deployment
metadata:
  labels:
    app: categraf
  name: categraf-idrac-metrics
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
          name: categraf-input-idrac-metrics
      restartPolicy: Always
      volumes:
      - configMap:
          name: categraf-config
        name: categraf-config
      - configMap:
          name: categraf-input-idrac-metrics
        name: categraf-input-idrac-metrics
```

### 配置说明

- `prometheus.toml` 中每个 URL 对应一台 iDRAC 目标。
- 请求格式为 `http://idrac-exporter:9348/metrics?target=<idrac-ip>`。
- 已保留单目标示例注释，便于从单机验证切换到批量采集：

```toml
[[instances]]
# urls = ["http://idrac-exporter.monitoring.svc:9348/metrics?target=<IDRAC_IP_1>"]
urls = [
  "http://idrac-exporter:9348/metrics?target=<IDRAC_IP_1>",
  "http://idrac-exporter:9348/metrics?target=<IDRAC_IP_2>",
  "http://idrac-exporter:9348/metrics?target=<IDRAC_IP_3>",
]
url_label_key = "instance"
url_label_value = "{{.Query}}"
```

- `url_label_key = "instance"` 与 `url_label_value = "{{.Query}}"` 的组合会将查询参数内容写入 `instance` 标签，便于在监控系统中区分不同 iDRAC 设备。
- `TZ`、`HOSTNAME`、`HOSTIP` 环境变量用于保持时区一致，并将节点信息注入运行环境。

## 多方案与适用场景

### 方案一：单目标验证

适用场景：

- 首次接入 iDRAC 指标
- 需要先验证 exporter 连通性、认证信息和指标返回情况
- 目标设备数量较少，先做最小化测试

建议做法：

- 使用注释中的单 URL 配置先验证一台设备。
- 优先使用完整域名形式 `http://idrac-exporter.monitoring.svc:9348/metrics?target=<idrac-ip>`，便于跨命名空间或 DNS 排查时定位问题。

### 方案二：批量目标采集

适用场景：

- 多台服务器使用相同或兼容的 iDRAC 采集方式
- 已完成单目标验证，准备批量纳管
- 希望通过一个 exporter 服务统一暴露多个目标的指标

建议做法：

- 在 `urls` 数组中追加多个 `target` 参数地址。
- 保留 `url_label_key` 与 `url_label_value` 配置，避免多目标数据混淆。
- 当前配置相较单目标方式更适合正式环境，因为结构更清晰，也更便于横向扩展。

### 服务访问地址选择建议

- `http://idrac-exporter:9348/...`
  适用于 `categraf` 与 `idrac-exporter` 位于同一命名空间 `n9e` 的场景，写法更短。
- `http://idrac-exporter.monitoring.svc:9348/...`
  适用于需要显式指定服务全名、跨命名空间引用习惯统一、或排查集群 DNS 解析问题的场景。

如果当前部署都位于 `monitoring` 命名空间内，优先保留短域名写法即可；若后续存在跨命名空间访问或需要更明确的服务寻址，建议改为全限定服务名。

## 部署步骤

### 1. 部署 exporter

```bash
kubectl -n monitoring apply -f idrac-exporter.yaml
```

### 2. 部署 categraf 采集任务

```bash
kubectl -n monitoring apply -f categraf-idrac.yaml
```

说明：

- 原始清单本身已经声明了 `namespace: monitoring`，命令中继续使用 `-n monitoring` 不会影响结果，但不是必需条件。
- 如需减少命令歧义，可统一保留一种命名空间声明方式。

## 推荐检查项

### 资源状态检查

```bash
kubectl -n monitoring get secret idrac-exporter-config
kubectl -n monitoring get deploy idrac-exporter categraf-idrac-metrics
kubectl -n monitoring get svc idrac-exporter
kubectl -n monitoring get pod -l app=idrac-exporter
kubectl -n monitoring get pod -l app=categraf
```

### Exporter 连通性检查

可在集群内访问以下地址验证：

```text
http://idrac-exporter:9348/health
http://idrac-exporter:9348/metrics?target=<IDRAC_IP_1>
```

如果 `/health` 正常但 `/metrics?target=...` 无数据或报错，应优先排查目标 iDRAC 地址、账号密码和网络连通性。

## 注意事项

- `Secret` 中的 `username`、`password` 必须按实际环境替换，避免直接使用示例值。
- `target` 参数应填写 iDRAC 管理口地址，而不是业务网地址。
- `categraf-idrac-metrics` 与原有 `categraf` 都使用 `app: categraf` 标签时，若环境中已存在同标签工作负载，排查时需注意不要误判 Pod 来源。
- `metrics.all: true` 会尽量采集全部指标，若后续发现采集耗时或数据量过大，应根据 exporter 能力再做裁剪。
- `timeout: 20` 适合作为基础值；如果远端管理口响应较慢，可在确认链路稳定后再视情况调整。

## 常见问题与排查方式

### Pod 已启动，但没有 iDRAC 指标

排查顺序：

1. 检查 `idrac-exporter` 的 `/health` 是否正常。
2. 直接请求 `/metrics?target=<idrac-ip>`，确认 exporter 能否访问目标设备。
3. 检查 `prometheus.toml` 中的 URL 是否填写正确，尤其是 `target` 参数。
4. 检查 iDRAC 用户名和密码是否正确。
5. 检查 Kubernetes 工作负载所在网络是否可达 iDRAC 管理网段。

### 多台设备数据混在一起，难以区分

处理建议：

- 保留以下标签映射配置，不要省略：

```toml
url_label_key = "instance"
url_label_value = "{{.Query}}"
```

- 这样可以把每个请求中的查询参数写入标签，便于按目标地址检索和展示。

### 使用短服务名访问失败

处理建议：

- 确认 `categraf` 与 `idrac-exporter` 是否都在 `monitoring` 命名空间。
- 如果存在命名空间差异或 DNS 解析疑点，改用：

```text
http://idrac-exporter.monitoring.svc:9348/metrics?target=<idrac-ip>
```

## 结论

当前推荐方案是：

- 使用 `idrac-exporter` 统一代理 iDRAC 指标采集
- 使用独立的 `categraf-idrac-metrics` 批量抓取多个 `target`
- 在批量采集场景下保留 `instance` 标签映射，确保设备维度可区分
- 在生产环境中替换明文凭据，并基于网络、时延和设备规模逐步扩展目标列表

## 参考资料

- [Categraf Prometheus 插件](https://github.com/flashcatcloud/categraf/tree/main/inputs/prometheus)
