# Calico CNI 网络模式选择、部署与变更手册

> 本文以 Calico Open Source 3.32.1 为示例，地址均为文档示例。安装或修改前请以当前官方版本和集群兼容矩阵为准。切换 IP-in-IP、VXLAN 或无封装模式可能中断现有连接；生产集群必须先备份资源、确认节点间网络和带外入口，并安排维护窗口。

Calico 同时提供 CNI、IPAM、网络策略和路由能力。选择网络模式时，重点不是寻找一个适用于所有环境的“最佳模式”，而是判断底层网络能否学习 Pod 路由、是否允许相应协议，以及能否接受封装带来的 MTU 和性能开销。

## 先理解三个概念

### 封装模式

- **IP-in-IP**：用 IP 协议 4 封装 IPv4 工作负载流量，配置项为 `ipipMode`。
- **VXLAN**：通过 VXLAN 隧道承载工作负载流量，配置项为 `vxlanMode`。
- **无封装**：数据包不套额外隧道头，底层网络必须具备到各节点 Pod 网段的路由。

### Always 与 CrossSubnet

- `Always`：跨节点流量始终封装，底层依赖少，但封装和 MTU 开销更明显。
- `CrossSubnet`：仅当源、目标节点不在同一子网时封装；同子网流量直接路由。
- `Never`：对应隧道类型不启用。

CrossSubnet 的判断依据是 Calico Node 资源中记录的节点地址和子网，因此多网卡主机必须先确认节点 IP 自动探测结果正确。

### BGP 不是另一种隧道

BGP 用来分发路由。IP-in-IP 池和无封装池都可能使用 BGP 传播集群路由；VXLAN 场景则可以由 Felix 编程集群路由，不一定需要内部 BGP。将“BGP”和“IPIP/VXLAN”简单列为互斥网络模式容易造成误解。

## 模式对比与选择

| 方案 | 同子网流量 | 跨子网流量 | 底层网络要求 | 典型场景 |
| --- | --- | --- | --- | --- |
| IP-in-IP Always | IP-in-IP | IP-in-IP | 节点间允许 IP 协议 4 | IPv4、自建网络且希望降低底层路由依赖 |
| IP-in-IP CrossSubnet | 不封装 | IP-in-IP | 同子网可直达，跨子网允许 IP 协议 4 | 多数 IPv4 VMware、KVM 或物理机集群 |
| VXLAN Always | VXLAN | VXLAN | 节点间允许 VXLAN | 不支持 IP-in-IP 或希望使用 VXLAN 的环境 |
| VXLAN CrossSubnet | 不封装 | VXLAN | 同子网可直达，跨子网允许 VXLAN | 多子网、希望减少封装的云或虚拟化环境 |
| 无封装 | 不封装 | 不封装 | 底层路由或 BGP 必须学习 Pod 路由 | 网络设备可控、追求低开销的自建网络 |

选择时先确认：

1. Pod CIDR 是否与节点网段、Service CIDR、VPN 和现有路由重叠。
2. 云平台或防火墙是否允许所选封装协议。
3. 底层 MTU 是否足以容纳隧道头，或是否已正确下调 Calico MTU。
4. 多网卡节点是否选择了正确的内部地址。
5. 无封装方案的 Pod 路由由 BGP、路由反射器、ToR 还是 Felix 负责。

## 安装前准备

本文使用以下示例 Pod CIDR：

```yaml
networking:
  podSubnet: 10.244.0.0/16
```

如果使用 kubeadm，初始化配置中的 Pod CIDR 与 Calico IPPool 必须保持一致。先完成以下检查：

```bash
kubectl cluster-info
kubectl get nodes -o wide
kubectl get pods -A
```

如果集群已经安装其他 CNI，不要直接叠加安装 Calico。应先制定 CNI 迁移方案并确认 Pod、节点路由和网络策略的迁移影响。

## 推荐方式：Tigera Operator 部署

Calico 官方建议新集群使用 Operator 管理安装、升级和扩缩容。以下版本号仅对应本文验证时的官方版本：

```bash
CALICO_VERSION=v3.32.1

kubectl create -f \
  "https://raw.githubusercontent.com/projectcalico/calico/${CALICO_VERSION}/manifests/v1_crd_projectcalico_org.yaml"

kubectl create -f \
  "https://raw.githubusercontent.com/projectcalico/calico/${CALICO_VERSION}/manifests/tigera-operator.yaml"

curl -fsSLO \
  "https://raw.githubusercontent.com/projectcalico/calico/${CALICO_VERSION}/manifests/custom-resources.yaml"
```

在应用前编辑 `custom-resources.yaml`。下面是 IP-in-IP CrossSubnet 的关键配置示例：

```yaml
apiVersion: operator.tigera.io/v1
kind: Installation
metadata:
  name: default
spec:
  calicoNetwork:
    bgp: Enabled
    ipPools:
      - cidr: 10.244.0.0/16
        blockSize: 26
        encapsulation: IPIPCrossSubnet
        natOutgoing: Enabled
        nodeSelector: all()
```

常用 `encapsulation` 值：

- `IPIP`：IP-in-IP Always。
- `IPIPCrossSubnet`：IP-in-IP CrossSubnet。
- `VXLAN`：VXLAN Always。
- `VXLANCrossSubnet`：VXLAN CrossSubnet。
- `None`：无封装。

应用并观察状态：

```bash
kubectl create -f custom-resources.yaml
watch kubectl get tigerastatus
```

当相关组件的 `AVAILABLE` 为 `True`，且 `PROGRESSING`、`DEGRADED` 为 `False` 后，再继续进行业务连通性验证。

## 兼容方式：原始 Manifest 部署

原始 Manifest 适合必须深度修改底层 Kubernetes 资源的环境，但无法像 Operator 一样管理完整生命周期，新集群通常不优先采用。

```bash
CALICO_VERSION=v3.32.1
curl -fsSL -o calico.yaml \
  "https://raw.githubusercontent.com/projectcalico/calico/${CALICO_VERSION}/manifests/calico.yaml"
```

非 kubeadm 平台或需要显式配置时，确认 `calico-node` 中的环境变量：

```yaml
- name: CALICO_IPV4POOL_CIDR
  value: "10.244.0.0/16"
- name: CALICO_IPV4POOL_IPIP
  value: "CrossSubnet"
- name: CALICO_IPV4POOL_VXLAN
  value: "Never"
```

应用并观察 DaemonSet：

```bash
kubectl apply -f calico.yaml
kubectl -n kube-system rollout status daemonset/calico-node
kubectl get nodes -o wide
```

不要直接下载 `latest` 或不固定版本的生产清单。升级前应先阅读版本说明和 Kubernetes 兼容矩阵。

## 查看当前 IPPool

不同安装方式下资源展示可能略有差异，优先从 Kubernetes API 读取实际配置：

```bash
kubectl get ippools.crd.projectcalico.org -o wide
kubectl get ippool default-ipv4-ippool -o yaml
```

重点检查：

```yaml
spec:
  cidr: 10.244.0.0/16
  ipipMode: CrossSubnet
  vxlanMode: Never
  natOutgoing: true
  nodeSelector: all()
```

Operator 管理的 IPPool 应通过 `Installation/default` 修改，不要直接编辑 IPPool，否则 Operator 可能将配置恢复为期望状态：

```bash
kubectl get installation.operator.tigera.io default -o yaml
```

## 已运行集群切换封装模式

> 这是有中断风险的网络变更。模式切换会改变节点隧道设备和路由，已有连接可能中断。必须先在测试集群验证，并准备 API Server、节点控制台和配置回滚入口。

### 备份当前状态

```bash
mkdir -p calico-backup

kubectl get installation.operator.tigera.io default -o yaml \
  > calico-backup/installation.yaml 2>/dev/null || true

kubectl get ippool default-ipv4-ippool -o yaml \
  > calico-backup/default-ipv4-ippool.yaml

kubectl get felixconfiguration default -o yaml \
  > calico-backup/felixconfiguration.yaml 2>/dev/null || true
```

同时记录节点、Pod、路由和 Calico 组件状态：

```bash
kubectl get nodes -o wide
kubectl get pods -A -o wide
kubectl get ippool default-ipv4-ippool -o yaml
```

### Manifest 管理集群的变更示例

先做服务端预演，确认补丁可以被 API Server 接受：

```bash
kubectl patch ippool default-ipv4-ippool \
  --type=merge \
  --patch '{"spec":{"ipipMode":"CrossSubnet","vxlanMode":"Never"}}' \
  --dry-run=server -o yaml
```

在维护窗口内应用：

```bash
kubectl patch ippool default-ipv4-ippool \
  --type=merge \
  --patch '{"spec":{"ipipMode":"CrossSubnet","vxlanMode":"Never"}}'
```

切换为 VXLAN CrossSubnet 时，将目标改为：

```json
{"spec":{"ipipMode":"Never","vxlanMode":"CrossSubnet"}}
```

Operator 管理的集群应修改 `Installation/default` 中对应 IPPool 的 `encapsulation`，让 Operator 完成协调，不要使用上面的 IPPool 直改命令。

### 回滚

如果变更后出现跨节点不通，优先恢复变更前的模式字段，而不是直接重启所有节点：

```bash
kubectl patch ippool default-ipv4-ippool \
  --type=merge \
  --patch '{"spec":{"ipipMode":"Always","vxlanMode":"Never"}}'
```

回滚值必须来自变更前备份；上面的 `Always/Never` 仅用于说明命令结构。

## 验证清单

### 控制面和组件状态

```bash
kubectl get nodes
kubectl get tigerastatus 2>/dev/null || true
kubectl -n calico-system get pods -o wide 2>/dev/null || true
kubectl -n kube-system get pods -l k8s-app=calico-node -o wide
kubectl get ippool default-ipv4-ippool -o yaml
```

### 节点隧道和路由

在至少两台不同子网的节点上检查：

```bash
ip -d link show tunl0
ip -d link show vxlan.calico
ip route
```

预期表现：

- IP-in-IP 模式通常可以看到 `tunl0`。
- VXLAN 模式通常可以看到 `vxlan.calico`。
- 无封装模式不依赖这两个隧道接口，但必须存在到其他节点 Pod 网段的有效路由。

如果启用了 BGP，还要检查邻居状态：

```bash
calicoctl node status
```

### 工作负载连通性

选择位于不同节点的现有测试 Pod，验证 Pod IP、Service IP、DNS 和外部访问。不要只用节点间 `ping` 代替工作负载测试：

```bash
kubectl get pods -A -o wide
kubectl exec -n <NAMESPACE> <SOURCE_POD> -- ping -c 3 <TARGET_POD_IP>
kubectl exec -n <NAMESPACE> <SOURCE_POD> -- nslookup kubernetes.default.svc
```

生产验证还应覆盖 NetworkPolicy、NodePort/Ingress、宿主机到 Pod、Pod 到外部依赖以及跨子网通信。

## 常见故障

### 同节点正常，跨节点不通

依次检查：

- 节点间是否允许所选封装协议或 BGP。
- `ipipMode` 与 `vxlanMode` 是否符合预期。
- 节点 IP 自动探测是否选错管理网、存储网或公网接口。
- 路由表中是否存在到远端 Pod block 的路由。
- 安全组、主机防火墙和反向路径过滤是否丢弃流量。

### 大包失败或连接偶发卡顿

封装会减少可用 MTU。先使用禁止分片的探测确认路径 MTU，再检查 Calico 自动探测结果和 CNI MTU 配置；不要未经测试就统一写死一个 MTU。

### CrossSubnet 行为与预期不一致

检查 Calico Node 资源中的 IPv4 地址：

```bash
kubectl get nodes.crd.projectcalico.org -o yaml
```

多网卡节点建议在 Operator 的 `Installation` 中配置 `nodeAddressAutodetectionV4`，按接口、CIDR 或可达目标明确选择节点地址。

### 模式切换后部分连接仍异常

先确认 IPPool 已收敛，并比较各节点路由和隧道接口。若必须滚动重启 `calico-node`，应一次处理少量节点并持续观察业务，而不是同时删除所有网络组件 Pod。

## 参考资料

- [Calico 官方：自建 Kubernetes 安装](https://docs.tigera.io/calico/latest/getting-started/kubernetes/self-managed-onprem/onpremises)
- [Calico 官方：选择网络方案](https://docs.tigera.io/calico/latest/networking/determine-best-networking)
- [Calico 官方：IP-in-IP 与 VXLAN](https://docs.tigera.io/calico/latest/networking/configuring/vxlan-ipip)
- [Calico 官方：IPPool 资源](https://docs.tigera.io/calico/latest/reference/resources/ippool)
- [Calico 官方：Operator Installation API](https://docs.tigera.io/calico/latest/reference/installation/api)
