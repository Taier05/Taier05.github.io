# Kubernetes 1.34 高可用集群与 Calico 部署手册

## 背景与目标

本文用于在多节点环境中部署一套基于 `containerd + kubeadm + kube-vip + Calico` 的 Kubernetes `v1.34.3` 高可用集群，重点覆盖以下内容：

- 基础环境初始化
- `containerd` 与 Kubernetes 组件安装
- 第一个控制平面节点初始化
- `kube-vip` 高可用接入
- 其他控制平面与工作节点加入
- Calico 网络安装、地址池规划与校验
- 常见风险点与排查命令

## 环境规划

### 集群角色

- 控制平面 VIP：`<IP_ADDRESS>:6443`
- 控制平面节点：
  - `<IP_ADDRESS> cp-01`
  - `<IP_ADDRESS> cp-02`
  - `<IP_ADDRESS> cp-03`
- 工作节点：
  - `<IP_ADDRESS> worker-01`
  - `<IP_ADDRESS> worker-02`

### 软件与网络参数

- Kubernetes 版本：`v1.34.3`
- 容器运行时：`containerd`
- kube-proxy 模式：`ipvs`
- Pod 网段：`<NETWORK_CIDR>`
- Service 网段：`<NETWORK_CIDR>`
- CNI：Calico `v3.28.2`
- Calico 后端：`bird`
- 默认封装方式：`IPIP=Always`、`VXLAN=Never`
- IPv6：关闭

## 部署前检查

### cgroup 版本

部署前先确认宿主机 cgroup 版本，建议优先使用 `cgroup v2`。

```bash
stat -fc %T /sys/fs/cgroup
mount | grep -E "cgroup2|cgroup "
```

判断方法：

- 输出包含 `cgroup2fs` 时，通常表示当前为 `cgroup v2`
- 若看到多个 `cpu`、`memory` 等子系统挂载，通常为 `cgroup v1`

### 主机名解析

在所有节点写入：

```bash
cat >> /etc/hosts <<EOF
<IP_ADDRESS> k8s-vip
<IP_ADDRESS> cp-01
<IP_ADDRESS> cp-02
<IP_ADDRESS> cp-03
<IP_ADDRESS> worker-01
<IP_ADDRESS> worker-02
EOF
```

## 基础环境初始化

### 内核参数

```bash
cat > /etc/sysctl.d/k8s.conf <<EOF
net.ipv4.ip_forward = 1
vm.swappiness = 0
net.bridge.bridge-nf-call-ip6tables = 1
net.bridge.bridge-nf-call-iptables = 1
EOF

sysctl -p /etc/sysctl.d/k8s.conf
```

### 加载 IPVS 模块

```bash
cat >/etc/modules-load.d/ipvs.conf <<EOF
ip_vs
ip_vs_rr
ip_vs_wrr
ip_vs_sh
nf_conntrack
EOF

modprobe ip_vs
modprobe ip_vs_rr
modprobe ip_vs_wrr
modprobe ip_vs_sh
modprobe nf_conntrack
lsmod | grep ip_vs
```

### 关闭 swap、SELinux 并校时

```bash
swapoff -a && sed -ri 's/.*swap.*/#&/' /etc/fstab
sed -i 's/enforcing/disabled/' /etc/selinux/config && setenforce 0
yum -y install epel-release ipvsadm
yum install -y ntpdate && ntpdate time.windows.com
```

## 安装 containerd

```bash
yum config-manager --add-repo https://download.docker.com/linux/rhel/docker-ce.repo
yum install -y containerd.io
mkdir -p /etc/containerd
containerd config default | tee /etc/containerd/config.toml > /dev/null
sed -i 's/SystemdCgroup = false/SystemdCgroup = true/' /etc/containerd/config.toml
sed -i 's#registry.k8s.io/pause:3.10.1#registry.aliyuncs.com/google_containers/pause:3.10.1#' /etc/containerd/config.toml
systemctl enable --now containerd
systemctl restart containerd
systemctl status containerd
```

推荐保留以下配置：

- `SystemdCgroup = true`
- `pause` 镜像切换到可访问的镜像仓库

## 安装 Kubernetes 组件

```bash
cat >/etc/yum.repos.d/kubernetes.repo <<EOF
[kubernetes]
name=Kubernetes
baseurl=https://pkgs.k8s.io/core:/stable:/v1.34/rpm/
enabled=1
gpgcheck=1
gpgkey=https://pkgs.k8s.io/core:/stable:/v1.34/rpm/repodata/repomd.xml.key
exclude=kubelet kubeadm kubectl cri-tools kubernetes-cni
EOF

yum install -y kubelet kubeadm kubectl --disableexcludes=kubernetes
systemctl enable --now kubelet
```

## 初始化第一个控制平面节点

### 临时绑定 VIP

以下命令在第一台控制平面节点执行，网卡名需要按实际环境替换，示例为 `ens34`。

```bash
ip addr add <NETWORK_CIDR> dev ens34 label ens34:vip
```

### kubeadm 配置

在第一台控制平面节点创建 `/root/kubeadm.yaml`：

```yaml
apiVersion: kubeadm.k8s.io/v1beta4
kind: ClusterConfiguration
kubernetesVersion: v1.34.3
controlPlaneEndpoint: "<IP_ADDRESS>:6443"
imageRepository: "registry.aliyuncs.com/google_containers"
networking:
  podSubnet: <NETWORK_CIDR>
  serviceSubnet: <NETWORK_CIDR>
---
apiVersion: kubeadm.k8s.io/v1beta4
kind: InitConfiguration
localAPIEndpoint:
  advertiseAddress: <IP_ADDRESS>
nodeRegistration:
  criSocket: unix:///run/containerd/containerd.sock
  kubeletExtraArgs:
    - name: node-ip
      value: "<IP_ADDRESS>"
---
apiVersion: kubeproxy.config.k8s.io/v1alpha1
kind: KubeProxyConfiguration
mode: ipvs
```

执行初始化：

```bash
kubeadm init --config /root/kubeadm.yaml --upload-certs
```

## 部署 kube-vip

所有控制平面节点均应安装 `kube-vip` 静态 Pod。

```bash
mkdir -p /etc/kubernetes/manifests
yum -y install podman

podman run --rm --net=host ghcr.io/kube-vip/kube-vip:v0.8.4 manifest pod \
  --interface ens34 \
  --address <IP_ADDRESS> \
  --controlplane \
  --arp \
  --leaderElection \
  | tee /etc/kubernetes/manifests/kube-vip.yaml

systemctl restart kubelet
```

确认 `kube-vip` 正常后，在第一台控制平面节点删除临时 VIP：

```bash
kubectl get pod -A | grep kube-vip
ip addr del <NETWORK_CIDR> dev ens34
```

如果出现 VIP 漂移频繁，可在 `kube-vip.yaml` 中补充以下参数：

```yaml
vip_leaseduration: "15"
vip_renewdeadline: "10"
vip_retryperiod: "2"
```

## 其他节点加入集群

### 控制平面节点

```bash
kubeadm join <IP_ADDRESS>:6443 \
  --token <token> \
  --discovery-token-ca-cert-hash sha256:<hash> \
  --control-plane \
  --certificate-key <certificate-key>
```

### 工作节点

```bash
kubeadm join <IP_ADDRESS>:6443 \
  --token <token> \
  --discovery-token-ca-cert-hash sha256:<hash>
```

### 重新生成加入命令

```bash
kubeadm token create --print-join-command
kubeadm init phase upload-certs --upload-certs
```

说明：

- 不要在长期文档中固化真实 `token` 与 `certificate-key`
- 每次以当前集群重新生成的结果为准

## Calico 安装与推荐配置

如果是新版本，可能要安装新的calico，需要去官网去找

[Kind multi-node install | Calico Documentation (tigera.io)](https://docs.tigera.io/calico/latest/getting-started/kubernetes/kind)

### 当前清单特征

当前使用的 `calico.yaml` 具备以下关键特征：

- 版本：`v3.28.2`
- 镜像仓库：
  - `swr.cn-south-1.myhuaweicloud.com/yalex/node:v3.28.2`
  - `swr.cn-south-1.myhuaweicloud.com/yalex/cni:v3.28.2`
  - `swr.cn-south-1.myhuaweicloud.com/yalex/kube-controllers:v3.28.2`
- `typha_service_name: "none"`，即未启用 Typha
- `calico_backend: "bird"`
- `veth_mtu: "0"`，表示自动探测
- `hostNetwork: true`
- `CALICO_IPV4POOL_IPIP=Always`
- `CALICO_IPV4POOL_VXLAN=Never`
- `FELIX_IPV6SUPPORT=false`
- 包含完整 CRD、RBAC、DaemonSet、Deployment 资源

### 推荐方案

推荐直接在 `calico-node` 容器环境变量中显式指定地址池，使其与 `kubeadm` 中的 `podSubnet` 完全一致。

在 `calico.yaml` 中为 `calico-node` 增加：

```yaml
- name: CALICO_IPV4POOL_CIDR
  value: "<NETWORK_CIDR>"
```

建议放在以下环境变量附近：

```yaml
- name: CALICO_IPV4POOL_IPIP
  value: "Always"
- name: CALICO_IPV4POOL_VXLAN
  value: "Never"
- name: CALICO_IPV4POOL_CIDR
  value: "<NETWORK_CIDR>"
```

安装命令：

```bash
kubectl apply -f calico.yaml
kubectl get pod -A
```

### 备选方案

如果暂时不修改原始清单，也可以在 Calico 安装后单独创建符合规划的 `IPPool`。该方案适用于以下场景：

- 清单文件由外部系统统一管理，不方便直接改动
- 需要将网络规划与安装清单解耦

但需要注意：

- 默认池若已自动创建，需先确认实际生成的地址池
- 已有 Pod 分配到错误网段时，不建议直接在线切换
- 新建地址池前应先评估已有工作负载与路由状态

因此在新集群初始化阶段，仍优先推荐直接修改安装清单。

## Calico 关键实现说明

当前清单的运行方式适用于本集群规划：

- `calico-node` 以 DaemonSet 运行在所有 Linux 节点
- `calico-kube-controllers` 以单副本 Deployment 运行
- `hostNetwork: true`，网络插件直接依赖宿主机网络命名空间
- 使用 `bird` 作为路由后端
- 使用 `IPIP` 作为默认封装方式
- `mount-bpffs` 初始化容器已包含 BPF 相关挂载，当前即便不启用 eBPF 也不影响常规 iptables/IPIP 模式部署

选择建议：

- 二层网络可直达、且保持现有清单默认行为时，沿用 `IPIP=Always`
- 如果后续需要改为其他封装方式，应同步评估 MTU、跨子网路由与现网兼容性

## 推荐部署顺序

1. 所有节点完成系统初始化
2. 安装并配置 `containerd`
3. 安装 `kubelet`、`kubeadm`、`kubectl`
4. 第一台控制平面节点临时绑定 VIP
5. 执行 `kubeadm init`
6. 部署 `kube-vip`
7. 删除手工绑定的 VIP
8. 其余控制平面节点加入集群
9. 工作节点加入集群
10. 修正并安装 Calico
11. 完成节点、DNS、地址池与路由校验

## 验证与检查命令

### 基础状态检查

```bash
kubectl get nodes -o wide
kubectl -n kube-system get pods -o wide
kubectl get pod -A
```

### Calico 相关检查

```bash
kubectl get ippools.crd.projectcalico.org
kubectl describe node <节点名>
kubectl -n kube-system get ds calico-node
kubectl -n kube-system get deploy calico-kube-controllers
```

重点确认：

- `calico-node` 在所有节点均为 Ready
- `calico-kube-controllers` 正常运行
- `coredns` 已恢复为 `Running`
- 实际 IPPool 为 `<NETWORK_CIDR>`
- 节点 `InternalIP` 与 `kubeletExtraArgs.node-ip` 一致

## 命令补全

```bash
yum install -y bash-completion
echo "source <(kubectl completion bash)" >> ~/.bashrc
source ~/.bashrc
```

## 注意事项

- `ens34` 仅为示例网卡名，部署前必须替换为实际网卡
- `containerd`、`kubelet`、`kubeadm`、`kubectl` 版本应保持匹配
- `podSubnet` 与 Calico 默认地址池必须一致，否则会出现地址规划冲突
- `calico.yaml` 中使用的是第三方镜像仓库，生产环境需确认镜像可信性、拉取策略与可用性
- `veth_mtu: "0"` 为自动探测，若底层网络有隧道、云厂商 MTU 限制或跨地域链路，应手工评估并固定 MTU
- `FELIX_DEFAULTENDPOINTTOHOSTACTION=ACCEPT` 允许 Pod 到宿主机流量，若有更严格安全要求，应结合策略单独评估

## 常见问题与排查

### 1. `kubeadm init` 卡住或组件未就绪

排查方向：

- `containerd` 是否正常运行
- `pause` 镜像是否可拉取
- 宿主机时间是否同步
- `node-ip`、`advertiseAddress` 是否与实际网卡地址一致

常用命令：

```bash
systemctl status containerd
systemctl status kubelet
journalctl -u kubelet -f
crictl images
```

### 2. VIP 不稳定或频繁漂移

排查方向：

- `kube-vip` 是否在所有控制平面节点部署
- `--interface` 是否绑定了正确网卡
- ARP 广播是否被交换网络限制
- 选主参数是否需要调优

建议：

- 为 `kube-vip` 增加 `vip_leaseduration`、`vip_renewdeadline`、`vip_retryperiod`
- 在变更前确认旧 VIP 已被正确释放

### 3. Calico 安装后 Pod 网段不符合规划

典型现象：

- `kubectl get ippools.crd.projectcalico.org` 显示的 CIDR 不是 `<NETWORK_CIDR>`
- 新建 Pod 获取到了错误网段地址

根因：

- `calico.yaml` 未显式声明 `CALICO_IPV4POOL_CIDR`

处理建议：

- 新集群优先修改清单后重新安装
- 若集群已投产，先核对现有 IPPool、Pod 分配和路由，再设计迁移方案

### 4. `coredns` 长时间 Pending 或不就绪

排查方向：

- CNI 是否安装成功
- `calico-node` 是否全部 Ready
- 节点是否存在 `NotReady` 或网络不可达

常用命令：

```bash
kubectl -n kube-system get pods -o wide
kubectl -n kube-system describe pod <coredns-pod-name>
kubectl -n kube-system logs -l k8s-app=calico-node --tail=200
```
