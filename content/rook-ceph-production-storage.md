# Rook-Ceph 生产部署与分层存储运维手册

> 极高风险提示：Ceph 副本数、故障域、PG、OSD 下线和集群清理必须结合实时容量与健康状态评估。优先使用 Rook 官方 OSD purge Job；一次只处理一个 OSD并等待回填完成。删除 CephCluster、强制移除 finalizer 或清理设备会永久丢失数据，本文不提供可直接复制的强制清集群命令。

## 背景与目标

本文用于在自建 Kubernetes 环境中部署和运维 Rook-Ceph，覆盖以下典型需求：

- 构建可为 Kubernetes 提供动态存储的 Ceph 集群
- 提供 RBD 块存储、对象存储和 Dashboard 管理入口
- 支持单池部署与 SSD/HDD 分层存储
- 支持节点扩容、磁盘替换、OSD 下线与故障排查
- 在 VMware 等虚拟化环境中降低盘符漂移带来的运维风险

本文优先采用可直接落地的生产做法；对于不同规模和不同介质规划，分别给出适用场景与选择建议。

## 环境规划与设计建议

### 基础要求

- 至少 3 个节点承载 MON，才能形成稳定 quorum。
- 数据库类业务建议使用 SSD 或 NVMe，网络建议低延迟且至少万兆。
- 数据盘必须与系统盘严格分离，部署前务必在每个节点确认：

```bash
lsblk -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT
```

### 故障域与副本建议

对于常见的 3 节点存储集群，推荐：

- `failureDomain: host`
- `size: 3`
- `min_size: 2`

原因：

- 副本按主机维度打散，单节点故障时仍可读写。
- 若使用 `failureDomain=osd`，当单机存在多个 OSD 时，多个副本可能落在同一主机，抗故障能力变差。

注意：

- 当集群只有 3 个 host 且池副本数为 3 时，掉 1 个 host 后通常还能读写，但会长期处于 `degraded/undersized`，因为没有第 4 个 host 承载缺失副本。
- 生产建议最终扩展到至少 4 个存储节点，以便故障后可以自动补齐副本。

### 磁盘路径选择建议

物理机盘符稳定时，可显式指定 `sdb`、`sdc` 等设备名；在 VMware 等虚拟化环境中，更推荐使用 `/dev/disk/by-path`，避免重启或控制器顺序变化导致 `/dev/sdX` 漂移。

查看稳定路径：

```bash
ls -l /dev/disk/by-path | grep -E -- '-> ../../sd[b|c]$'
```

## 安装 Rook-Ceph

### 获取部署文件

```bash
git clone --single-branch --branch v1.18.8 https://github.com/rook/rook.git
cd rook/deploy/examples
```

### 镜像拉取受限场景

如无法访问默认镜像仓库，可在 `operator.yaml` 中替换 CSI 镜像；以下两组镜像均可作为参考：

华为云镜像：

```yaml
ROOK_CSI_REGISTRAR_IMAGE: "registry.example.com/storage/csi-node-driver-registrar:v2.13.0"
ROOK_CSI_RESIZER_IMAGE: "registry.example.com/storage/csi-resizer:v1.13.2"
ROOK_CSI_PROVISIONER_IMAGE: "registry.example.com/storage/csi-provisioner:v5.2.0"
ROOK_CSI_SNAPSHOTTER_IMAGE: "registry.example.com/storage/csi-snapshotter:v8.2.1"
ROOK_CSI_ATTACHER_IMAGE: "registry.example.com/storage/csi-attacher:v4.8.1"
image: registry.example.com/storage/ceph:v1.18.8
```

私有仓库镜像：

```yaml
ROOK_CSI_REGISTRAR_IMAGE: "registry.example.com/storage/sig-storage/csi-node-driver-registrar:v2.13.0"
ROOK_CSI_RESIZER_IMAGE: "registry.example.com/storage/sig-storage/csi-resizer:v1.13.2"
ROOK_CSI_PROVISIONER_IMAGE: "registry.example.com/storage/sig-storage/csi-provisioner:v5.2.0"
ROOK_CSI_SNAPSHOTTER_IMAGE: "registry.example.com/storage/sig-storage/csi-snapshotter:v8.2.1"
ROOK_CSI_ATTACHER_IMAGE: "registry.example.com/storage/sig-storage/csi-attacher:v4.8.1"
```

如需 toolbox，可同步调整 `toolbox.yaml` 镜像：

```yaml
image: registry.example.com/storage/ceph:v19
```

### 安装顺序

```bash
kubectl apply -f crds.yaml
kubectl apply -f common.yaml
kubectl apply -f csi-operator.yaml
kubectl apply -f operator.yaml
kubectl apply -f toolbox.yaml
```

检查组件状态：

```bash
kubectl -n rook-ceph get pod
```

## 创建 Ceph 集群

### 推荐原则

- 不要使用 `useAllDevices: true`，避免误用系统盘。
- 明确指定节点和数据盘。
- VMware 等环境优先使用 `by-path`。
- 存在节点磁盘差异时，只填写真实存在的盘，避免 `osd-prepare` 反复失败。

### 通用三节点示例

适用于各节点均有一块独立数据盘的场景：

```yaml
apiVersion: ceph.rook.io/v1
kind: CephCluster
metadata:
  name: rook-ceph
  namespace: rook-ceph
spec:
  cephVersion:
    image: quay.io/ceph/ceph:v19.2.3
  dataDirHostPath: /var/lib/rook
  dashboard:
    enabled: true
    ssl: false
  storage:
    useAllNodes: false
    useAllDevices: false
    nodes:
    - name: storage-node-01
      devices:
      - name: sdb
    - name: storage-node-02
      devices:
      - name: sdb
    - name: storage-node-03
      devices:
      - name: sdb
```

### VMware 生产示例

适用于节点较多、磁盘需要按稳定路径绑定的场景：

```yaml
apiVersion: ceph.rook.io/v1
kind: CephCluster
metadata:
  name: rook-ceph
  namespace: rook-ceph
spec:
  cephVersion:
    image: registry.example.com/storage/ceph:v19.2.3
    allowUnsupported: false
  dataDirHostPath: /var/lib/rook
  mon:
    count: 5
    allowMultiplePerNode: false
  mgr:
    count: 2
    allowMultiplePerNode: false
  dashboard:
    enabled: true
    ssl: false
  monitoring:
    enabled: true
    metricsDisabled: false
    exporter:
      perfCountersPrioLimit: 5
      statsPeriodSeconds: 5
  removeOSDsIfOutAndSafeToRemove: false
  priorityClassNames:
    mon: system-node-critical
    osd: system-node-critical
    mgr: system-cluster-critical
  storage:
    useAllNodes: false
    useAllDevices: false
    nodes:
    - name: macau-01
      devices:
      - name: /dev/disk/by-path/pci-0000:02:00.0-scsi-0:0:1:0
    - name: macau-02
      devices:
      - name: /dev/disk/by-path/pci-0000:02:00.0-scsi-0:0:1:0
    - name: macau-03
      devices:
      - name: /dev/disk/by-path/pci-0000:02:00.0-scsi-0:0:1:0
      - name: /dev/disk/by-path/pci-0000:02:00.0-scsi-0:0:2:0
```

说明：

- `macau-01`、`macau-02` 只有 SSD 时，只写对应 SSD，不要填写不存在的 HDD。
- `mon.count: 5` 适用于节点充足且追求更高仲裁稳定性的场景；小规模集群通常保留 3 个 MON 即可。

应用后观察：

```bash
kubectl apply -f cluster-prod.yaml
kubectl -n rook-ceph get pod -w
```

## 集群健康检查

安装 toolbox 后，常用检查命令如下：

```bash
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- ceph -s
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- ceph health detail
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- ceph pg stat
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- ceph osd tree
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- ceph osd df tree
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- ceph df
```

理想状态：

- `HEALTH_OK`
- `mon` 达到预期 quorum
- `mgr` 正常 active/standby
- `osd: N up, N in`
- `pgs: active+clean`

## 存储池与 StorageClass 设计

### 方案一：单一副本池

适用场景：

- 集群规模较小
- 所有数据盘介质相近
- 业务以单一类型为主

推荐块存储池：

```yaml
apiVersion: ceph.rook.io/v1
kind: CephBlockPool
metadata:
  name: replicapool
  namespace: rook-ceph
spec:
  failureDomain: host
  replicated:
    size: 3
```

对应 RBD StorageClass：

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: rook-ceph-block
  annotations:
    storageclass.kubernetes.io/is-default-class: "true"
provisioner: rook-ceph.rbd.csi.ceph.com
parameters:
  clusterID: rook-ceph
  pool: replicapool
  imageFormat: "2"
  imageFeatures: layering
  csi.storage.k8s.io/provisioner-secret-name: rook-csi-rbd-provisioner
  csi.storage.k8s.io/provisioner-secret-namespace: rook-ceph
  csi.storage.k8s.io/controller-expand-secret-name: rook-csi-rbd-provisioner
  csi.storage.k8s.io/controller-expand-secret-namespace: rook-ceph
  csi.storage.k8s.io/node-stage-secret-name: rook-csi-rbd-node
  csi.storage.k8s.io/node-stage-secret-namespace: rook-ceph
allowVolumeExpansion: true
reclaimPolicy: Delete
volumeBindingMode: Immediate
```

PVC 验证：

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: test-rbd
spec:
  accessModes: ["ReadWriteOnce"]
  storageClassName: rook-ceph-block
  resources:
    requests:
      storage: 5Gi
```

### 方案二：SSD/HDD 分层池

适用场景：

- 业务冷热分层明显
- 节点同时具备 SSD 与 HDD
- 需要将数据库和归档类数据分开

创建 CRUSH rule：

```bash
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- \
  ceph osd crush rule create-replicated replicated_ssd default host ssd
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- \
  ceph osd crush rule create-replicated replicated_hdd default host hdd
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- \
  ceph osd crush rule ls | egrep 'replicated_(ssd|hdd)'
```

创建池：

```bash
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- ceph osd pool create rbd-ssd 64
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- ceph osd pool set rbd-ssd size 3
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- ceph osd pool set rbd-ssd min_size 2
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- ceph osd pool set rbd-ssd crush_rule replicated_ssd
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- ceph osd pool application enable rbd-ssd rbd

kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- ceph osd pool create rbd-hdd 64
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- ceph osd pool set rbd-hdd size 2
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- ceph osd pool set rbd-hdd min_size 1
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- ceph osd pool set rbd-hdd crush_rule replicated_hdd
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- ceph osd pool application enable rbd-hdd rbd
```

说明：

- SSD 池建议用于 MySQL 等低延迟业务。
- HDD 池可用于容量型或冷数据业务。
- 当 HDD 分布的 host 数量较少时，`size` 必须与实际 host 数量匹配；样例中 HDD 池使用 `size=2/min_size=1`，适用于容量池容错要求较低或 host 覆盖范围不足的场景。
- 若 HDD 节点数量同样充足且希望达到生产级副本保护，优先将 HDD 池也设置为 `size=3/min_size=2`。

对应 StorageClass：

SSD：

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: rook-ceph-block-ssd
provisioner: rook-ceph.rbd.csi.ceph.com
parameters:
  clusterID: rook-ceph
  pool: rbd-ssd
  imageFormat: "2"
  imageFeatures: layering
  csi.storage.k8s.io/provisioner-secret-name: rook-csi-rbd-provisioner
  csi.storage.k8s.io/provisioner-secret-namespace: rook-ceph
  csi.storage.k8s.io/node-stage-secret-name: rook-csi-rbd-node
  csi.storage.k8s.io/node-stage-secret-namespace: rook-ceph
reclaimPolicy: Delete
allowVolumeExpansion: true
volumeBindingMode: Immediate
```

HDD：

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: rook-ceph-block-hdd
  annotations:
    storageclass.kubernetes.io/is-default-class: "true"
provisioner: rook-ceph.rbd.csi.ceph.com
parameters:
  clusterID: rook-ceph
  pool: rbd-hdd
  imageFormat: "2"
  imageFeatures: layering
  csi.storage.k8s.io/provisioner-secret-name: rook-csi-rbd-provisioner
  csi.storage.k8s.io/provisioner-secret-namespace: rook-ceph
  csi.storage.k8s.io/node-stage-secret-name: rook-csi-rbd-node
  csi.storage.k8s.io/node-stage-secret-namespace: rook-ceph
reclaimPolicy: Delete
allowVolumeExpansion: true
volumeBindingMode: Immediate
```

### Bucket 与 PVC 的区别

`rook-ceph.ceph.rook.io/bucket` 是对象存储桶 provisioner，用于 OBC，不可直接给 PVC 使用。若 PVC 一直 `Pending`，先确认选择的是 RBD 或 CephFS 类型的 StorageClass，而不是 Bucket 类型。

## PG autoscaler 与容量规划

### PG autoscaler

建议保持开启：

```bash
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- ceph mgr module enable pg_autoscaler
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- ceph osd pool set replicapool pg_autoscale_mode on
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- ceph osd pool autoscale-status
```

对于多池场景，可补充预期容量信息：

```bash
ceph osd pool set <pool> target_size_ratio 0.70
ceph osd pool set <pool> target_size_bytes 1000000000000
```

### MySQL 等数据库容量评估

若使用 3 副本池承载 500Gi MySQL 数据：

- 逻辑数据约 500Gi
- 原始容量至少约 `500Gi x 3 = 1500Gi`
- 实际还需预留恢复空间、BlueStore 元数据和 nearfull/full 阈值余量

因此：

- 原始可用容量应显著高于 1.5Ti
- 业务高峰和故障恢复期间要避免接近 `nearfull`

### 性能与监控重点

业务侧重点：

- commit 延迟
- p95/p99 延迟
- fsync 相关等待

MySQL 节点快速观测：

```bash
iostat -x 1
```

Ceph 侧重点：

```bash
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- ceph -s
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- ceph health detail
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- ceph pg stat
```

节点网络与介质检查：

```bash
ip -s link
ping -i 0.2 <other-node-ip>
lsblk -o NAME,ROTA,TYPE,SIZE,MODEL
```

## Dashboard 暴露方案

### 方案一：Gateway 终止 TLS

适用场景：

- 需要正式域名和可信证书
- 希望统一接入层处理 TLS、访问控制和审计

先关闭 Dashboard 内置 SSL：

```bash
kubectl -n rook-ceph patch cephcluster rook-ceph --type merge -p '{"spec":{"dashboard":{"ssl":false,"port":8443}}}'
```

创建证书 Secret：

```bash
kubectl -n gateway-system create secret tls demo-cert \
  --cert=/path/to/tls.crt \
  --key=/path/to/tls.key
```

创建 Gateway：

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: tls-gateway
  namespace: gateway-system
spec:
  gatewayClassName: cilium
  listeners:
  - name: https
    protocol: HTTPS
    port: 443
    hostname: "ceph.example.com"
    allowedRoutes:
      namespaces:
        from: All
    tls:
      certificateRefs:
      - kind: Secret
        name: demo-cert
```

如需 BGP 宣告：

```bash
kubectl -n gateway-system label svc cilium-gateway-tls-gateway lb-pool=vip bgp=blue --overwrite
```

创建 HTTPRoute：

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: ceph
  namespace: rook-ceph
spec:
  parentRefs:
  - name: tls-gateway
    namespace: gateway-system
    sectionName: https
  hostnames:
  - ceph.example.com
  rules:
  - matches:
    - path:
        type: PathPrefix
        value: /
    backendRefs:
    - name: rook-ceph-mgr-dashboard
      port: 8443
```

### 方案二：TLS 透传

适用场景：

- 需要尽快暴露 Dashboard
- 可以接受自签名证书告警
- Gateway 实现已支持 `TLSRoute`

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: TLSRoute
metadata:
  name: ceph-dashboard-tls
  namespace: rook-ceph
spec:
  parentRefs:
  - name: <GATEWAY_NAME>
    namespace: <GATEWAY_NS>
  hostnames:
  - ceph.example.com
  rules:
  - backendRefs:
    - name: rook-ceph-mgr-dashboard
      port: 8443
```

### 方案三：NodePort 临时访问

适用场景：

- 内网快速验证
- 无 Gateway API 或临时排障

```yaml
apiVersion: v1
kind: Service
metadata:
  name: rook-ceph-mgr-dashboard-nodeport
  namespace: rook-ceph
spec:
  type: NodePort
  selector:
    app: rook-ceph-mgr
    rook_cluster: rook-ceph
  ports:
  - name: http-dashboard
    port: 7000
    targetPort: 7000
    nodePort: 30700
```

登录信息：

```bash
kubectl -n rook-ceph get secret rook-ceph-dashboard-password \
  -o jsonpath="{['data']['password']}" | base64 --decode && echo
```

默认用户名为 `admin`。

## 启用对象存储

### 创建 CephObjectStore

```yaml
apiVersion: ceph.rook.io/v1
kind: CephObjectStore
metadata:
  name: store-a
  namespace: rook-ceph
spec:
  metadataPool:
    replicated:
      size: 3
  dataPool:
    replicated:
      size: 3
  preservePoolsOnDelete: true
  gateway:
    port: 80
    instances: 3
```

说明：

- 对象池副本数应与实际可用存储 host 数匹配。
- 如果集群阶段性只剩 2 个 OSD，继续保持 `size: 3` 会导致对象池长期 `undersized`。

### 创建对象用户

```yaml
apiVersion: ceph.rook.io/v1
kind: CephObjectStoreUser
metadata:
  name: s3-admin
  namespace: rook-ceph
spec:
  store: store-a
  displayName: "s3-admin"
```

获取 AK/SK：

```bash
kubectl -n rook-ceph get secret rook-ceph-object-user-store-a-s3-admin -o jsonpath='{.data.AccessKey}' | base64 -d; echo
kubectl -n rook-ceph get secret rook-ceph-object-user-store-a-s3-admin -o jsonpath='{.data.SecretKey}' | base64 -d; echo
```

### 通过 Gateway 暴露 RGW

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: rgw-store-a
  namespace: rook-ceph
spec:
  parentRefs:
  - name: <GATEWAY_NAME>
    namespace: <GATEWAY_NS>
  hostnames:
  - s3.example.com
  rules:
  - matches:
    - path:
        type: PathPrefix
        value: /
    backendRefs:
    - name: rook-ceph-rgw-store-a
      port: 80
```

### 客户端访问方式

推荐使用 AWS CLI：

```bash
export AWS_ACCESS_KEY_ID="<S3_ACCESS_KEY>"
export AWS_SECRET_ACCESS_KEY="<S3_SECRET_KEY>"
export AWS_DEFAULT_REGION="us-east-1"
export S3_ENDPOINT="https://s3.example.com"

aws --endpoint-url "$S3_ENDPOINT" s3 mb s3://customer-a
aws --endpoint-url "$S3_ENDPOINT" s3 cp ./mysql-backup.tar.gz s3://customer-a/mysql-backup.tar.gz
aws --endpoint-url "$S3_ENDPOINT" s3 cp s3://customer-a/mysql-backup.tar.gz ./mysql-backup.tar.gz
aws --endpoint-url "$S3_ENDPOINT" s3 ls s3://customer-a/
```

若客户端不便持有 AK/SK，可使用预签名 URL：

```bash
aws --endpoint-url https://s3.example.com s3 presign s3://customer-a/mysql-backup.tar.gz --expires-in 3600
```

## OSD 新增、替换与下线

### 操作前检查

```bash
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- ceph -s
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- ceph health detail
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- ceph osd tree
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- ceph osd df tree
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- ceph pg stat
```

### 新增 OSD 节点

推荐顺序：

1. 将新节点加入 Kubernetes 并确认 `Ready`
2. 清理新数据盘
3. 修改 `CephCluster.spec.storage.nodes`
4. 观察 `osd-prepare` 与新 OSD 创建
5. 等待 PG 恢复

清盘命令：

```bash
DEV=/dev/sdb
sudo wipefs -a $DEV
sudo sgdisk --zap-all $DEV
# 如支持 discard，优先：
# sudo blkdiscard -f $DEV
```

示例：

```yaml
spec:
  storage:
    nodes:
    - name: storage-node-01
      devices:
      - name: sdb
    - name: storage-node-02
      devices:
      - name: sdb
    - name: storage-node-03
      devices:
      - name: sda
    - name: storage-node-04
      devices:
      - name: sdb
```

应用与观察：

```bash
kubectl -n rook-ceph apply -f cephcluster.yaml
kubectl -n rook-ceph rollout restart deploy/rook-ceph-operator
kubectl -n rook-ceph get job | grep osd-prepare
kubectl -n rook-ceph get pod -o wide | egrep "osd-prepare|rook-ceph-osd"
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- ceph osd tree
```

### OSD 安全下线与删除

以 `osd.0` 为例：

```bash
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- ceph osd out <OSD_ID>
# 查看 kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- ceph -s
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- ceph osd safe-to-destroy <OSD_ID>
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- ceph osd purge <OSD_ID> --yes-i-really-mean-it


# 修改cephcluster.yaml  
# 注释掉机器的盘
    nodes:
      #- name: storage-node-test
      #  devices:
      #    - name: /dev/disk/by-path/pci-0000:02:00.0-scsi-0:0:1:0
      #    - name: /dev/disk/by-path/pci-0000:02:00.0-scsi-0:0:2:0
再kubectl apply -f cephcluster.yaml 
```

关键原则：

- 必须在 `safe-to-destroy` 返回 OK 后再执行 `purge`
- `purge` 不可逆
- 在 3 host + size=3 场景下，最佳顺序是先新增 OSD，再删除旧 OSD

### 同节点换盘

适用场景：主机不变，仅替换坏盘。

建议流程：

1. 确认坏盘对应 OSD
2. 对该 OSD 执行 `out`
3. 更换并清理新盘
4. 删除该节点的 `osd-prepare` job 并重启 operator
5. 待新 OSD 创建后，再对旧 OSD 做 `safe-to-destroy` 与 `purge`

```bash
kubectl -n rook-ceph delete job rook-ceph-osd-prepare-storage-node-01
kubectl -n rook-ceph rollout restart deploy/rook-ceph-operator
```

### 整节点替换

适用场景：退役旧节点，以新节点替代。

推荐流程：

1. 先让新节点加入存储并创建 OSD
2. 再对旧节点上的 OSD 执行 `out`
3. 等待集群恢复
4. 对旧 OSD 执行 `safe-to-destroy` 与 `purge`
5. 最后 `drain` 并下线旧节点

## 恢复回填节流

当回填和恢复导致业务抖动时，可临时降低恢复并发：

```bash
ceph tell osd.* injectargs '--osd-max-backfills=1'
ceph tell osd.* injectargs '--osd-recovery-max-active=1'
ceph tell osd.* injectargs '--osd-recovery-op-priority=1'
ceph tell osd.* injectargs '--osd-client-op-priority=63'
```

调整后继续观察：

```bash
ceph -s
ceph pg stat
ceph health detail
```

## 常见问题与排查

### OSD 没有创建

优先查看：

```bash
kubectl -n rook-ceph get job | grep osd-prepare
kubectl -n rook-ceph logs job/rook-ceph-osd-prepare-<node> -c provision | tail -n 200
kubectl -n rook-ceph logs deploy/rook-ceph-operator --tail=200
```

常见原因：

- 盘上残留旧 Ceph 元数据
- 设备名填写错误
- 节点 taint 或调度限制导致 OSD Pod 起不来
- 节点声明了不存在的磁盘

顽固旧盘可使用更彻底清理方式：

```bash
DEV=/dev/sdb
sudo umount ${DEV}* 2>/dev/null || true
sudo wipefs -a $DEV
sudo sgdisk --zap-all $DEV
sudo dd if=/dev/zero of=$DEV bs=1M count=200 conv=fsync
MB=$(( $(blockdev --getsize64 $DEV) / 1024 / 1024 ))
sudo dd if=/dev/zero of=$DEV bs=1M seek=$((MB-200)) count=200 conv=fsync
sudo partprobe $DEV || true
```

### `safe-to-destroy` 报错

如果提示：

- `OSD(s) have no reported stats`
- `not all PGs are active+clean`

说明当前仍有 PG 未恢复完成。应先修复故障节点、补充新 OSD 或等待恢复，再重新执行 `safe-to-destroy`。

### Namespace 卡在 Terminating

先识别阻塞删除的资源和 finalizer；不要在未确认控制器状态及数据影响时直接移除：

```bash
kubectl -n rook-ceph get cephcluster -o name
kubectl -n rook-ceph get cephcluster <CEPH_CLUSTER_NAME> -o yaml
# 不要强制删除：先按官方 cleanupPolicy 清理上层资源并确认备份
kubectl -n rook-ceph get cephcluster
```

最后手段：

```bash
# 不在常规手册中提供移除 namespace finalizer 的命令；先定位残留资源和控制器
kubectl api-resources --verbs=list --namespaced -o name
```

### Dashboard 或 RGW 通过 Gateway 访问异常

检查点：

- `HTTPRoute` 或 `TLSRoute` 是否 `Accepted=True`
- Gateway 的 `allowedRoutes` 是否允许来自 `rook-ceph`
- backend service 名称与端口是否正确
- 证书或 TLS 模式是否与访问方式一致

集群内连通性验证：

```bash
kubectl -n rook-ceph run tmpcurl --rm -it --image=curlimages/curl -- sh
curl -vk http://rook-ceph-mgr-dashboard.rook-ceph.svc:8443/
curl -vk https://rook-ceph-mgr-dashboard.rook-ceph.svc:8443/
curl -i http://rook-ceph-rgw-store-a.rook-ceph.svc
```

## 生产建议

- 关键业务优先使用 SSD/NVMe 对应的独立 pool。
- 对象存储建议按租户拆分用户与 bucket，避免共用凭据。
- Dashboard 对外暴露优先选择 Gateway 终止 TLS，并叠加访问控制。
- 不要混用系统盘与数据盘，不要依赖 `useAllDevices: true`。
- 对于 3 副本池，原始容量规划至少按 3 倍逻辑数据估算，并额外预留恢复空间。
- 监控应覆盖 OSD 状态、PG 健康、容量阈值、慢操作、节点磁盘与网络质量。

## 参考资料

- [Rook Ceph OSD Management](https://rook.io/docs/rook/latest-release/Storage-Configuration/Advanced/ceph-osd-mgmt/)
- [Rook Ceph Cleanup](https://rook.io/docs/rook/latest-release/Getting-Started/ceph-teardown/)
