# Headlamp 多集群只读接入与发布手册

> 令牌提示：本文采用最小权限 RBAC。Kubernetes 1.24 及以后，临时登录优先使用 kubectl create token 获取有期限 Token；只有确需长期外部 kubeconfig 时才考虑手工 ServiceAccount Token Secret，并建立轮换、吊销、加密存储和审计机制。不要把 kubeconfig 或 Token 提交到仓库。

## 背景与目标

本文档用于为 Kubernetes 集群部署 Headlamp 多集群只读访问能力，目标包括：

- 在每个目标集群中创建统一的只读访问账号与权限。
- 提取访问所需的 `server`、`CA` 与 `token`，组装为多集群 `kubeconfig`。
- 以外置 `kubeconfig` 的方式部署 Headlamp，避免依赖集群内默认高权限访问。
- 通过 Gateway API 将 Headlamp 以 HTTP 服务形式对外发布。

该方案适用于需要统一查看多个集群资源，但不希望授予变更权限的场景。

## 环境说明

### 组件与命名

- 只读账号命名空间：`headlamp-system`
- 只读 ServiceAccount：`headlamp-viewer`
- 只读 ClusterRole：`headlamp-readonly-global`
- Headlamp 部署命名空间：`headlamp`
- 对外域名示例：`headlamp.example.com`
- Gateway 示例：
  - 名称：`shared-gateway`
  - 命名空间：`nginx-gateway`

### 已使用的集群示例

- `cluster-a`
- `cluster-b`

## 推荐架构

推荐将“凭据生成”和“应用部署”分离：

1. 在每个目标集群中创建只读账号。
2. 从每个目标集群提取只读访问凭据。
3. 将多个集群凭据合并为一个多上下文 `kubeconfig`。
4. 将该 `kubeconfig` 作为 Secret 挂载到 Headlamp 容器。
5. 将 Headlamp 以 `ClusterIP` 方式部署，再通过 Gateway API 暴露。

这样做的优点：

- Headlamp 不依赖所在集群的默认 ServiceAccount 权限。
- 多集群接入方式清晰，可独立增删目标集群。
- 权限边界明确，默认仅允许查看资源。

## 只读权限配置

### 适用场景

适用于希望让 Headlamp 统一查看多个集群的只读资源信息，包括：

- 集群基础信息
- 工作负载
- 网络资源
- 存储资源
- 指标与事件

### 推荐 YAML

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: headlamp-system
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: headlamp-viewer
  namespace: headlamp-system
automountServiceAccountToken: false
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: headlamp-readonly-global
rules:
- apiGroups: [""]
  resources:
    - namespaces
    - nodes
    - pods
    - pods/log
    - services
    - endpoints
    - persistentvolumes
    - persistentvolumeclaims
    - configmaps
    - events
    - limitranges
    - resourcequotas
  verbs: ["get", "list", "watch"]

- apiGroups: ["apps"]
  resources:
    - deployments
    - replicasets
    - daemonsets
    - statefulsets
    - controllerrevisions
  verbs: ["get", "list", "watch"]

- apiGroups: ["batch"]
  resources:
    - jobs
    - cronjobs
  verbs: ["get", "list", "watch"]

- apiGroups: ["autoscaling"]
  resources:
    - horizontalpodautoscalers
  verbs: ["get", "list", "watch"]

- apiGroups: ["networking.k8s.io"]
  resources:
    - ingresses
    - ingressclasses
    - networkpolicies
  verbs: ["get", "list", "watch"]

- apiGroups: ["discovery.k8s.io"]
  resources:
    - endpointslices
  verbs: ["get", "list", "watch"]

- apiGroups: ["storage.k8s.io"]
  resources:
    - storageclasses
    - csidrivers
    - csinodes
    - volumeattachments
  verbs: ["get", "list", "watch"]

- apiGroups: ["policy"]
  resources:
    - poddisruptionbudgets
  verbs: ["get", "list", "watch"]

- apiGroups: ["metrics.k8s.io"]
  resources:
    - nodes
    - pods
  verbs: ["get", "list", "watch"]

- apiGroups: ["events.k8s.io"]
  resources:
    - events
  verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: headlamp-readonly-global
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: headlamp-readonly-global
subjects:
- kind: ServiceAccount
  name: headlamp-viewer
  namespace: headlamp-system
---
apiVersion: v1
kind: Secret
metadata:
  name: headlamp-viewer-token
  namespace: headlamp-system
  annotations:
    kubernetes.io/service-account.name: headlamp-viewer
type: kubernetes.io/service-account-token
```

### 创建命令

在每个目标集群执行：

```bash
kubectl apply -f headlamp-只读账号.yaml
```

## 获取多集群访问凭据

在每个目标集群创建完只读账号后，分别提取以下信息。

### 1. 获取 API Server 地址

```bash
kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}'; echo
```

### 2. 获取集群 CA

输出为 Base64 编码内容，可直接写入 `certificate-authority-data`：

```bash
kubectl -n headlamp-system get secret headlamp-viewer-token -o jsonpath='{.data.ca\.crt}'; echo
```

### 3. 获取访问 Token

```bash
kubectl -n headlamp-system get secret headlamp-viewer-token -o jsonpath='{.data.token}' | base64 -d; echo
```

## 多集群 kubeconfig 组装

### 适用场景

- 需要一个 Headlamp 统一查看多个 Kubernetes 集群。
- 每个集群使用独立只读凭据。
- 希望通过切换 `context` 区分不同集群。

### 推荐结构

建议按“集群、用户、上下文”三段组织，例如：

```yaml
apiVersion: v1
kind: Config
clusters:
- name: cluster-a
  cluster:
    server: https://<cluster-a-apiserver>:6443
    certificate-authority-data: <base64-ca>

- name: cluster-b
  cluster:
    server: https://<cluster-b-apiserver>:6443
    certificate-authority-data: <base64-ca>

users:
- name: cluster-a-headlamp
  user:
    token: <readonly-token>

- name: cluster-b-headlamp
  user:
    token: <readonly-token>

contexts:
- name: cluster-a
  context:
    cluster: cluster-a
    user: cluster-a-headlamp

- name: cluster-b
  context:
    cluster: cluster-b
    user: cluster-b-headlamp

current-context: cluster-a
```

### 选择建议

- 单集群接入：可以仅保留一个 `cluster`、一个 `user`、一个 `context`。
- 多集群接入：推荐统一维护一个多上下文 `kubeconfig`，便于 Headlamp 集中展示。

如果新增集群，按相同格式补充三段配置即可，无需改动 Headlamp 安装方式。

## Headlamp 部署

### 部署思路

部署时关闭集群内凭据依赖，改为显式挂载外置 `kubeconfig`。这是本方案的推荐配置，优先于直接依赖 Pod 默认身份的方式。

### 创建命名空间与 Secret

```bash
kubectl -n headlamp create namespace headlamp --dry-run=client -o yaml | kubectl apply -f -

kubectl -n headlamp create secret generic headlamp-kubeconfig \
  --from-file=config=./headlamp-multicluster-kubeconfig
```

### 安装 Headlamp

```bash
helm repo add headlamp https://kubernetes-sigs.github.io/headlamp/
helm repo update

helm upgrade --install headlamp headlamp/headlamp \
  -n headlamp \
  --create-namespace \
  --set config.inCluster=false \
  --set clusterRoleBinding.create=false \
  --set serviceAccount.create=true \
  --set automountServiceAccountToken=false \
  --set service.type=ClusterIP \
  --set-json 'env=[{"name":"KUBECONFIG","value":"/home/headlamp/.config/Headlamp/kubeconfigs/config"}]' \
  --set-json 'volumeMounts=[{"name":"kcfg","mountPath":"/home/headlamp/.config/Headlamp/kubeconfigs","readOnly":true}]' \
  --set-json 'volumes=[{"name":"kcfg","secret":{"secretName":"headlamp-kubeconfig"}}]'
```

### 关键参数说明

- `config.inCluster=false`
  - 禁用集群内自动配置，强制使用挂载的 `kubeconfig`。
- `clusterRoleBinding.create=false`
  - 不为 Headlamp 自身额外创建高权限绑定，权限由外部 `kubeconfig` 决定。
- `automountServiceAccountToken=false`
  - 避免 Pod 自动挂载默认令牌，减少误用集群内身份的风险。
- `service.type=ClusterIP`
  - 建议通过网关统一暴露，不直接使用 NodePort。

## 对外发布

### 适用场景

适用于集群已部署 Gateway API 与对应网关控制器，需要以统一域名方式发布 Headlamp。

### HTTPRoute 示例

```bash
kubectl apply -f - <<'EOF'
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: headlamp
  namespace: headlamp
spec:
  parentRefs:
    - name: shared-gateway
      namespace: nginx-gateway
  hostnames:
    - "headlamp.example.com"
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /
      backendRefs:
        - name: headlamp
          port: 80
EOF
```

### 认证处理建议

当前路由示例仅完成转发。若 Headlamp 需要对外开放访问，建议在网关层追加认证能力，例如统一接入认证代理、基本认证或企业 SSO。适合以下场景：

- 内网环境但仍需基本保护
- 面向运维团队开放，需要统一身份认证
- 需要保留访问审计能力

如果仅限受控内网访问，可先保留纯转发配置；如果面向更广用户范围，建议优先补齐认证。

## 多方案与适用场景

### 方案一：单集群只读接入

适用场景：

- 仅管理一个集群
- 想快速验证 Headlamp 可用性

特点：

- 配置简单
- 排障路径最短
- 后续扩展到多集群时需要补充更多上下文

### 方案二：多集群统一接入

适用场景：

- 同时查看测试、生产或多云集群
- 希望在一个 UI 中切换多个 Kubernetes 环境

特点：

- 更适合长期运维
- 需要规范管理多个 `server`、`CA` 与 `token`
- 建议统一命名 `cluster`、`user`、`context`

### 选择建议

- 仅临时使用：优先单集群方案。
- 持续运维与统一入口：优先多集群方案。

从已有配置方式看，多集群外置 `kubeconfig` 是更合理的主方案，既保留了权限隔离，也便于增量接入新集群。

## 注意事项

- `headlamp-system` 与 `headlamp` 分工不同：
  - `headlamp-system` 用于只读凭据与授权对象。
  - `headlamp` 用于部署应用本身。
- 手工创建的 `kubernetes.io/service-account-token` Secret 依赖集群控制面自动回填数据，若 Secret 中未生成 `token` 或 `ca.crt`，需先确认对应 ServiceAccount 是否已正确创建。
- `metrics.k8s.io` 资源需要集群已安装 Metrics Server，否则 Headlamp 中指标视图可能为空。
- 若网关侧未加认证，不建议直接暴露到不受控网络。
- 多集群 `kubeconfig` 中的 `current-context` 只决定默认上下文，不影响 Headlamp 识别多个集群。
- 涉及 `token`、`CA`、`server` 的文件应按敏感配置管理，避免进入公共仓库或被无权限人员读取。

## 常见问题与排查方式

### 1. Headlamp 页面无法列出资源

检查项：

```bash
kubectl --kubeconfig=./headlamp-multicluster-kubeconfig get ns
kubectl --kubeconfig=./headlamp-multicluster-kubeconfig auth can-i get pods -A
kubectl --kubeconfig=./headlamp-multicluster-kubeconfig auth can-i list deployments -A
```

排查重点：

- `token` 是否正确
- `certificate-authority-data` 是否匹配目标集群
- `ClusterRoleBinding` 是否绑定到 `headlamp-viewer`

### 2. 无法获取 token

检查项：

```bash
kubectl -n headlamp-system get sa headlamp-viewer
kubectl -n headlamp-system get secret headlamp-viewer-token -o yaml
```

排查重点：

- Secret 注解 `kubernetes.io/service-account.name` 是否正确
- Secret 类型是否为 `kubernetes.io/service-account-token`
- ServiceAccount 与 Secret 是否在同一命名空间

### 3. Headlamp Pod 已启动，但仍未使用外部 kubeconfig

检查项：

```bash
kubectl -n headlamp get pod
kubectl -n headlamp get secret headlamp-kubeconfig
kubectl -n headlamp describe deploy headlamp
```

排查重点：

- 是否已挂载 `headlamp-kubeconfig` Secret
- `KUBECONFIG` 环境变量路径是否与挂载路径一致
- Helm 参数是否被后续升级覆盖

### 4. 域名无法访问

检查项：

```bash
kubectl -n headlamp get httproute headlamp
kubectl -n nginx-gateway get gateway shared-gateway
kubectl -n headlamp get svc headlamp
```

排查重点：

- `HTTPRoute` 是否成功绑定到目标 Gateway
- 域名解析是否正确
- 网关控制器是否已接管并下发配置

## 最小实施步骤

```bash
kubectl apply -f headlamp-只读账号.yaml
kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}'; echo
kubectl -n headlamp-system get secret headlamp-viewer-token -o jsonpath='{.data.ca\.crt}'; echo
kubectl -n headlamp-system get secret headlamp-viewer-token -o jsonpath='{.data.token}' | base64 -d; echo

kubectl -n headlamp create namespace headlamp --dry-run=client -o yaml | kubectl apply -f -
kubectl -n headlamp create secret generic headlamp-kubeconfig \
  --from-file=config=./headlamp-multicluster-kubeconfig

helm repo add headlamp https://kubernetes-sigs.github.io/headlamp/
helm repo update
helm upgrade --install headlamp headlamp/headlamp \
  -n headlamp \
  --create-namespace \
  --set config.inCluster=false \
  --set clusterRoleBinding.create=false \
  --set serviceAccount.create=true \
  --set automountServiceAccountToken=false \
  --set service.type=ClusterIP \
  --set-json 'env=[{"name":"KUBECONFIG","value":"/home/headlamp/.config/Headlamp/kubeconfigs/config"}]' \
  --set-json 'volumeMounts=[{"name":"kcfg","mountPath":"/home/headlamp/.config/Headlamp/kubeconfigs","readOnly":true}]' \
  --set-json 'volumes=[{"name":"kcfg","secret":{"secretName":"headlamp-kubeconfig"}}]'
```

至此即可完成 Headlamp 多集群只读接入的核心部署。

## 参考资料

- [Headlamp 安装与认证文档](https://headlamp.dev/docs/latest/installation/)
