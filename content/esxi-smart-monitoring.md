# ESXi主机磁盘SMART监控部署与接入手册

> 安全提示：示例已移除真实 ESXi 地址和私有镜像仓库。SSH 私钥不得提交到 Git，建议使用专用采集账号或受控密钥并限制 Secret 读取权限。关闭 SSH 主机指纹校验会暴露中间人攻击风险，生产环境应预置并校验 known_hosts。

## 背景与目标

本文用于在 Kubernetes 环境中部署 `esxi-smart-exporter`，通过 SSH 采集 ESXi 主机磁盘 SMART 信息，并以 Prometheus 指标形式暴露给监控系统。  
在此基础上，可选择由 Prometheus 直接抓取 exporter，或通过 Categraf 的 `input.prometheus` 插件接入夜莺 `n9e` 体系。

## 组件说明

- `esxi_smart_exporter.py`：核心采集程序，定期通过 SSH 执行 `esxcli` 命令，解析设备列表与 SMART 输出，并提供 `/metrics` 与 `/healthz` 接口。
- `esxi-smart-exporter.yaml`：Kubernetes 部署清单，包含 `ConfigMap`、`Deployment`、`Service`。
- `categraf-esxismart.yaml`：Categraf 补充采集配置，用于从 exporter 拉取指标。
- `说明.sh`：密钥生成、镜像构建、部署与验证命令示例。

## 环境说明

- Kubernetes 命名空间：`monitoring`
- exporter 默认监听端口：`9808`
- exporter 默认采集周期：`300` 秒
- SSH 默认用户：`root`
- SSH 私钥挂载路径：`/app/keys/id_rsa`
- ESXi 主机列表文件：`/app/config/hosts.txt`

采集依赖以下 ESXi 命令：

```bash
esxcli storage core device list
esxcli storage core device smart get -d '<device>'
```

因此目标 ESXi 主机需开启 SSH，并允许使用密钥登录。

## 部署流程

### 1. 生成 SSH 密钥并配置 ESXi 免密登录

```bash
# ESXI主机做免密
ssh-keygen -t rsa -b 4096 -f ./esxi_smart_rsa -N "" -C "esxi-smart"
# 生成：
# ./esxi_smart_rsa        私钥
# ./esxi_smart_rsa.pub    公钥   将公钥添加到ESXI主机的/etc/ssh/keys-root/authorized_keys上
# 测试
ssh -i ./esxi_smart_rsa root@<ESXI_HOST_IP_2>
```

完成后，将公钥写入每台 ESXi 主机的 `/etc/ssh/keys-root/authorized_keys`。

### 2. 在 Kubernetes 中创建私钥 Secret

```bash
# 把私钥添加到kubernetes
kubectl -n monitoring create secret generic esxi-smart-ssh-key --from-file=id_rsa=./esxi_smart_rsa
```

这里 `Secret` 中的键名必须为 `id_rsa`，因为部署清单通过：

```yaml
- name: SSH_KEY_PATH
  value: "/app/keys/id_rsa"
```

明确指定了私钥文件路径。

### 3. 构建并推送 exporter 镜像

如果镜像已经存在，可跳过本节。示例 Dockerfile 如下：

```dockerfile
# esxi-smart-exporter:latest 镜像制作 Dockerfile (之前做过就可以跳过)
FROM python:3.11-alpine
RUN apk add --no-cache openssh-client
WORKDIR /app
COPY ./esxi_smart_exporter.py /app/esxi_smart_exporter.py
EXPOSE 9808
ENTRYPOINT ["python3", "/app/esxi_smart_exporter.py"]
```

构建与推送命令：

```bash
cd /root/esxi-smart
docker build -t registry.example.com/monitoring/esxi-smart-exporter:latest .
docker push registry.example.com/monitoring/esxi-smart-exporter:latest
```

### 4. 部署 exporter

推荐使用如下 Kubernetes 清单：

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: esxi-smart-exporter-config
  namespace: monitoring
data:
  hosts.txt: |
    <ESXI_HOST_IP_1>
    <ESXI_HOST_IP_2>
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: esxi-smart-exporter
  namespace: monitoring
  labels:
    app: esxi-smart-exporter
spec:
  replicas: 1
  selector:
    matchLabels:
      app: esxi-smart-exporter
  template:
    metadata:
      labels:
        app: esxi-smart-exporter
    spec:
      containers:
      - name: exporter
        image: registry.example.com/monitoring/esxi-smart-exporter:latest
        imagePullPolicy: IfNotPresent
        ports:
        - containerPort: 9808
          name: metrics
        env:
        - name: PORT
          value: "9808"
        - name: SSH_USER
          value: "root"
        - name: SSH_KEY_PATH
          value: "/app/keys/id_rsa"
        - name: ESXI_HOSTS_FILE
          value: "/app/config/hosts.txt"
        - name: COLLECT_INTERVAL_SECONDS
          value: "300"
        - name: SSH_CONNECT_TIMEOUT_SECONDS
          value: "10"
        - name: SSH_COMMAND_TIMEOUT_SECONDS
          value: "60"
        # 如遇旧版本 ESXi 的 SSH 算法兼容问题可启用：
        # - name: SSH_EXTRA_OPTS
        #   value: "-o HostKeyAlgorithms=+ssh-rsa -o PubkeyAcceptedAlgorithms=+ssh-rsa"
        volumeMounts:
        - name: hosts
          mountPath: /app/config
          readOnly: true
        - name: ssh-key
          mountPath: /app/keys
          readOnly: true
        readinessProbe:
          httpGet:
            path: /healthz
            port: 9808
          initialDelaySeconds: 5
          periodSeconds: 10
        livenessProbe:
          httpGet:
            path: /healthz
            port: 9808
          initialDelaySeconds: 15
          periodSeconds: 20
      volumes:
      - name: hosts
        configMap:
          name: esxi-smart-exporter-config
      - name: ssh-key
        secret:
          secretName: esxi-smart-ssh-key
          defaultMode: 0400
---
apiVersion: v1
kind: Service
metadata:
  name: esxi-smart-exporter
  namespace: monitoring
  labels:
    app: esxi-smart-exporter
spec:
  selector:
    app: esxi-smart-exporter
  ports:
  - name: metrics
    port: 9808
    targetPort: metrics
```

应用清单：

```bash
kubectl apply -f esxi-smart-exporter.yaml
```

### 5. 验证 exporter

```bash
kubectl -n monitoring port-forward svc/esxi-smart-exporter 9808:9808
curl -s http://127.0.0.1:9808/metrics | head -n 80
```

健康检查接口：

```text
GET /healthz
GET /-/healthy
```

指标接口：

```text
GET /metrics
```

## 指标与采集行为说明

脚本会先读取 ESXi 主机列表，再对每台主机执行：

1. `esxcli storage core device list`
2. `esxcli storage core device smart get -d '<device>'`

脚本支持以下两类 SMART 输出格式：

- 表格模式：首列通常为 `Parameter`，后续为 `Value`、`Threshold`、`Worst`、`Raw`
- 键值模式：`key: value`

关键指标包括：

- `esxi_smart_exporter_up`：exporter 进程状态
- `esxi_smart_exporter_hosts_total`：配置的 ESXi 主机总数
- `esxi_smart_exporter_collect_success`：最近一次采集是否完全成功
- `esxi_smart_host_up`：单台 ESXi 最近一次采集是否成功
- `esxi_smart_host_device_count`：ESXi 主机识别到的磁盘设备数量
- `esxi_smart_device_info`：设备基础信息，包含厂商、型号、版本等标签
- `esxi_smart_health_ok`：SMART 健康状态，`1` 表示正常
- `esxi_smart_temperature_celsius`：磁盘温度
- `esxi_smart_power_on_hours`：通电时长
- `esxi_smart_power_cycle_count`：上电次数
- `esxi_smart_reallocated_sector_count`：重映射扇区数
- `esxi_smart_pending_sector_reallocation_count`：待重映射扇区数
- `esxi_smart_uncorrectable_sector_count`：不可校正扇区数

如果 SMART 原始字段不是数值，脚本会将其作为 `*_text_info` 指标标签输出，以避免直接丢失信息。

## 接入方案与适用场景

### 方案一：Prometheus 直接抓取 exporter

适用场景：

- 已有 Prometheus 抓取体系
- 不希望额外部署 Categraf 中转
- 需要最短链路、最少组件

特点：

- 结构更直接
- exporter 的 `/metrics` 可直接纳入 Prometheus 抓取目标
- 运维面更简单

### 方案二：通过 Categraf 接入夜莺

适用场景：

- 集群已统一使用 Categraf 进行指标采集
- 需要遵循现有夜莺接入方式
- 希望把该采集能力纳入既有 Categraf 管理模型

可使用如下清单：

```yaml
---
kind: ConfigMap
metadata:
  name: categraf-esxismart-config
  namespace: monitoring
apiVersion: v1
data:
  prometheus.toml: |
    [[instances]]
    urls = ["http://esxi-smart-exporter.monitoring.svc.cluster.local:9808/metrics"]
    url_label_key = "instance"
    url_label_value = "{{.Host}}"
---
apiVersion: apps/v1
kind: Deployment
metadata:
  labels:
    app: categraf
  name: categraf-esxismart
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
          name: categraf-esxismart-config
      restartPolicy: Always
      volumes:
      - configMap:
          name: categraf-config
        name: categraf-config
      - configMap:
          name: categraf-esxismart-config
        name: categraf-esxismart-config
```

应用清单：

```bash
# 使用categraf采集
kubectl apply -f categraf-esxismart.yaml
```

选择建议：

- 如果只需要把 ESXi SMART 指标暴露给 Prometheus，优先选择 Prometheus 直接抓取。
- 如果当前夜莺环境已经规范使用 Categraf，可保留 Categraf 方案。
- 若集群中已存在其他 `app: categraf` 工作负载，部署前应确认标签选择器不会相互影响；必要时将该 Deployment 的 `app` 标签改为独立值。

## 重要配置项

### 主机列表配置

脚本支持两种主机来源：

- `ESXI_HOSTS_FILE`：从文件按行读取，空行和 `#` 注释行会被忽略
- `ESXI_HOSTS`：从环境变量读取，支持逗号或空白符分隔

在 Kubernetes 场景下，优先建议使用 `ConfigMap + hosts.txt`，更适合变更管理。

### SSH 相关配置

- `SSH_USER`：默认 `root`
- `SSH_PORT`：默认 `22`
- `SSH_KEY_PATH`：默认脚本值为 `/app/keys/esxi_smart_rsa`，但当前部署清单已显式覆盖为 `/app/keys/id_rsa`
- `SSH_CONNECT_TIMEOUT_SECONDS`：SSH 建连超时
- `SSH_COMMAND_TIMEOUT_SECONDS`：远程命令执行超时
- `SSH_EXTRA_OPTS`：补充 SSH 参数

对于旧版本 ESXi，如遇 SSH 算法兼容问题，可启用以下配置：

```yaml
# 如遇旧版本 ESXi 的 SSH 算法兼容问题可启用：
# - name: SSH_EXTRA_OPTS
#   value: "-o HostKeyAlgorithms=+ssh-rsa -o PubkeyAcceptedAlgorithms=+ssh-rsa"
```

### 采集周期配置

`COLLECT_INTERVAL_SECONDS` 默认为 `300` 秒。  
如果主机数量较多或单次采集耗时较长，建议不要将该值设置得过低，以免 SSH 连接频繁堆积。

## 常见问题与排查

### 1. `/metrics` 无数据或只有 exporter 自身指标

排查方向：

- 检查 `hosts.txt` 是否为空
- 确认 `ESXI_HOSTS_FILE` 路径与挂载目录一致
- 检查 `Secret` 中私钥文件名是否为 `id_rsa`
- 确认 ESXi 已启用 SSH，且公钥已写入 `authorized_keys`

### 2. 某台 ESXi `esxi_smart_host_up=0`

排查方向：

- SSH 网络连通性
- 用户名、端口、密钥是否正确
- ESXi 是否限制 root SSH 登录
- 是否触发 SSH 算法兼容问题

如果是旧版 ESXi，可尝试启用：

```text
-o HostKeyAlgorithms=+ssh-rsa -o PubkeyAcceptedAlgorithms=+ssh-rsa
```

### 3. 设备列表能获取，但 SMART 读取失败

现象：

- `esxi_smart_host_up=1`
- `esxi_smart_device_smart_ok=0`
- `esxi_smart_host_error{stage="smart_get"}=1`

排查方向：

- 指定磁盘设备是否支持 SMART
- `esxcli storage core device smart get -d '<device>'` 是否能在目标主机手工执行成功
- 某些设备可能只返回键值模式或非标准内容，需结合实际输出确认

### 4. Categraf 部署后没有接收到指标

排查方向：

- 确认 `esxi-smart-exporter.monitoring.svc.cluster.local:9808` 能在集群内访问
- 检查 `prometheus.toml` 是否正确挂载到 `/etc/categraf/conf/input.prometheus`
- 确认 Categraf 自身基础配置 `categraf-config` 已存在

## 注意事项

- exporter 通过 SSH 定时轮询 ESXi，不适合将采集周期设置过短。
- `StrictHostKeyChecking=no` 与 `UserKnownHostsFile=/dev/null` 便于快速落地，但会降低主机指纹校验强度，应在受控网络中使用。
- 当无主机配置时，`esxi_smart_exporter_collect_success` 会置为 `0`，并记录 `no_hosts` 状态。
- 当部分主机或部分磁盘采集失败时，exporter 仍会返回已有指标，但 `esxi_smart_exporter_collect_success` 可能为 `0`。

## 操作速查

```bash
# 创建 SSH 密钥
ssh-keygen -t rsa -b 4096 -f ./esxi_smart_rsa -N "" -C "esxi-smart"

# 创建 Kubernetes Secret
kubectl -n monitoring create secret generic esxi-smart-ssh-key --from-file=id_rsa=./esxi_smart_rsa

# 部署 exporter
kubectl apply -f esxi-smart-exporter.yaml

# 验证 metrics
kubectl -n monitoring port-forward svc/esxi-smart-exporter 9808:9808
curl -s http://127.0.0.1:9808/metrics | head -n 80

# 部署 Categraf 接入
kubectl apply -f categraf-esxismart.yaml
```

## 参考资料

- [Categraf Prometheus 插件](https://github.com/flashcatcloud/categraf/tree/main/inputs/prometheus)
