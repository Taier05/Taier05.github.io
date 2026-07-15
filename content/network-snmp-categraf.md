# 网络设备SNMP监控采集部署手册

> 安全提示：示例地址与 community 已替换为占位符。SNMP v2c 的 community 会以明文方式传输；设备支持时优先使用 SNMPv3，并通过管理网 ACL 仅允许采集器访问 UDP 161。不要在公开仓库中保存真实 community。

## 背景与目标

本文档用于在 Kubernetes 集群中部署 `categraf` 的 SNMP 采集能力，面向交换机等网络设备采集基础系统信息、接口状态与流量计数器，并将指标纳入 `monitoring` 命名空间下的监控体系。

当前方案基于 SNMP v2c，使用 `ConfigMap` 提供 `snmp.toml`，并通过独立 `Deployment` 运行采集进程。

## 环境说明

- Kubernetes 命名空间：`monitoring`
- 采集组件：`categraf`
- 镜像：`registry.example.com/monitoring/categraf:v0.4.22`
- 目标设备地址示例：`<SNMP_TARGET_IP>`
- 时区：`Asia/Shanghai`
- SNMP 协议版本：`v2c`
- Community 示例：`<SNMP_COMMUNITY>`

## 部署说明

部署依赖两个配置来源：

- 已存在的通用配置：`categraf-config`
- 本文新增的 SNMP 配置：`categraf-snmp-config`

其中，`categraf` 容器挂载路径如下：

- `/etc/categraf/conf`：通用配置
- `/etc/categraf/conf/input.snmp`：SNMP 输入插件配置

## 推荐部署清单

以下清单可直接应用。`snmp.toml` 中保留了原始配置注释，便于后续维护和调整。

```yaml
---
kind: ConfigMap
metadata:
  name: categraf-snmp-config
  namespace: monitoring
apiVersion: v1
data:
  snmp.toml: |
    # 轮询周期（秒）
    interval = 30

    [[instances]]
    agents = [
      "udp://<SNMP_TARGET_IP>"
    ]

    # SNMP v2c
    version = 2
    community = "<SNMP_COMMUNITY>"

    timeout = "5s"
    retries = 3

    # 一次 GETBULK 拉取的对象数：有些设备有限制，建议先用默认/小一点稳定（文档建议默认10）
    max_repetitions = 10

    # 给每条指标打上设备IP标签（很关键）
    agent_host_tag = "device_ip"

    # 额外标签：按机房/角色/品牌分组
    labels = { region = "idc1", role = "switch", brand = "generic" }

    # --- 单值（snmpget 适合） ---
    [[instances.field]]
    oid = ".1.3.6.1.2.1.1.3.0"
    name = "uptime"

    [[instances.field]]
    oid = ".1.3.6.1.2.1.1.5.0"
    name = "sysName"
    is_tag = true

    # --- 接口表（snmpwalk 适合）：必须先有 table（可用“虚拟表”） ---
    [[instances.table]]
    name = "interface"
    index_as_tag = true

    [[instances.table.field]]
    oid = ".1.3.6.1.2.1.2.2.1.2"
    name = "ifDescr"
    is_tag = true

    [[instances.table.field]]
    oid = ".1.3.6.1.2.1.2.2.1.7"
    name = "ifAdminStatus"

    [[instances.table.field]]
    oid = ".1.3.6.1.2.1.2.2.1.8"
    name = "ifOperStatus"

    # 64位流量计数器（推荐）
    [[instances.table.field]]
    oid = ".1.3.6.1.2.1.31.1.1.1.6"
    name = "ifHCInOctets"

    [[instances.table.field]]
    oid = ".1.3.6.1.2.1.31.1.1.1.10"
    name = "ifHCOutOctets"

    [[instances.table.field]]
    oid = ".1.3.6.1.2.1.31.1.1.1.15"
    name = "ifHighSpeed"
---
apiVersion: apps/v1
kind: Deployment
metadata:
  labels:
    app: categraf
  name: categraf-snmp
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
        - mountPath: /etc/categraf/conf/input.snmp
          name: categraf-snmp-config
      restartPolicy: Always
      volumes:
      - configMap:
          name: categraf-config
        name: categraf-config
      - configMap:
          name: categraf-snmp-config
        name: categraf-snmp-config
```

## 配置要点

### 单值指标与表格指标

- `uptime`、`sysName` 属于单值 OID，适合 `snmpget` 场景。
- 接口类指标属于表格数据，适合 `snmpwalk` 场景。
- 表格采集前必须定义 `[[instances.table]]`，即使只是作为“虚拟表”承载字段。

### 推荐保留的关键配置

- `max_repetitions = 10`
  适合兼顾兼容性与稳定性。部分设备对单次 `GETBULK` 返回对象数有限制，出现超时或设备兼容性问题时应优先维持较小值。
- `agent_host_tag = "device_ip"`
  用于给每条指标打上设备 IP 标签，便于多设备场景下区分来源。
- `ifHCInOctets`、`ifHCOutOctets`
  优先使用 64 位计数器，适合接口流量采集，优于低位计数器。
- `ifDescr`、`sysName`
  建议保留为标签字段，便于展示和筛选。

## 操作步骤

### 1. 确认网络设备已开启 SNMP

需要确保目标网络设备已开放 UDP `161` 端口，并已启用可访问的 SNMP community。

### 2. 探测网络中的 SNMP 设备

```bash
# 在网路设备上开启SNMP 端口161
# 扫描网络中的SNMP设备
dnf -y install nmap
nmap -sU -p 161 <MANAGEMENT_CIDR> --open
nmap -sU -p 161 <SNMP_TARGET_IP> --open
```

### 3. 在内网主机验证 SNMP 返回值

适用场景：

- 先排除设备侧配置问题
- 尚未部署 Kubernetes 采集任务
- 需要快速验证 community、OID 和 ACL

```bash
# 在内网一台设备上测试能否抓到SNMP设备   <SNMP_COMMUNITY>是SNMP端设置的名称
dnf install -y net-snmp-utils
snmpwalk -v2c -c <SNMP_COMMUNITY> <SNMP_TARGET_IP> RFC1213-MIB::sysUpTime.0
snmpwalk -v2c -c <SNMP_COMMUNITY> <SNMP_TARGET_IP> RFC1213-MIB::sysName.0
```

### 4. 在 Kubernetes 集群内验证采集链路

适用场景：

- 需要确认 Pod 到设备的网络可达性
- 需要验证集群网络策略、路由或出口限制
- 排查“宿主机可通但容器不可通”的问题

```bash
# 在Kubernetes集群中测试能否抓到SNMP设备
kubectl -n monitoring run snmp-test --rm -it --image=registry.example.com/monitoring/alpine:3.22.0 -- sh -c \
'apk add --no-cache net-snmp-tools >/dev/null && snmpwalk -v2c -c <SNMP_COMMUNITY> <SNMP_TARGET_IP> 1.3.6.1.2.1.1.3.0'
```

### 5. 应用部署清单

将上文 YAML 保存后执行：

```bash
kubectl apply -f categraf-snmp.yaml
```

## 多方案与适用场景

### 方案一：先在内网主机测试

适用于设备初次接入或网络设备侧配置尚不确定的场景。优点是路径短、变量少，能快速确认 SNMP 服务本身是否可用。

### 方案二：直接在 Kubernetes 集群内测试

适用于已经明确设备 SNMP 正常，但需要确认集群网络连通性、容器运行环境、镜像工具链是否满足要求的场景。该方案更接近最终运行路径，适合上线前最终验证。

### 选择建议

- 设备首次接入：优先做内网主机测试，再做集群内测试。
- 已知设备可用，仅怀疑集群网络问题：优先做集群内测试。
- 大规模纳管前：建议两种方式都执行一次，分别验证设备侧和采集侧。

## 注意事项

- `community = "<SNMP_COMMUNITY>"` 仅为示例，生产环境应替换为实际值。
- `agents` 当前只配置了一个设备地址；多设备场景可继续追加多个 `udp://IP`。
- `labels` 中的 `region`、`role`、`brand` 建议按实际机房、设备角色和厂商统一规范命名。
- `selector.matchLabels.app` 与 Pod 标签同为 `categraf`，若命名空间内已有同标签工作负载，部署前应确认不会产生选择器重叠风险。
- `volumeMounts` 依赖 `categraf-config` 已存在；若该 `ConfigMap` 缺失，Pod 将无法正常启动。
- SNMP 为 UDP 协议，排障时需重点关注网络 ACL、防火墙和设备侧源地址限制。

## 常见问题与排查

### `snmpwalk` 无返回或超时

优先检查以下项目：

- 设备是否启用 SNMP v2c
- community 是否正确
- 设备是否允许当前来源地址访问
- UDP `161` 端口是否被防火墙或 ACL 拦截
- 集群 Pod 到目标网段是否可路由

### 接口流量指标缺失

重点检查：

- 设备是否支持 `ifHCInOctets` 和 `ifHCOutOctets`
- 表格是否已定义 `[[instances.table]]`
- OID 是否与目标设备实现兼容

### 采集稳定性较差

可按以下方向处理：

- 保持 `max_repetitions = 10`，不要盲目调大
- 适当检查 `timeout = "5s"` 与 `retries = 3` 是否满足链路质量
- 在多设备场景中按设备类型拆分实例，避免单实例承载过多不稳定目标

## 建议的后续优化

- 按设备类型拆分不同 `instances`，分别维护交换机、路由器、防火墙等配置。
- 根据设备厂商补充专有 OID，用于采集温度、电源、风扇、板卡状态等扩展指标。
- 在标签体系中引入统一命名规范，便于后续告警和仪表盘复用。

## 参考资料

- [Categraf SNMP 插件文档](https://flashcat.cloud/docs/content/flashcat-monitor/categraf/plugin/snmp/)
