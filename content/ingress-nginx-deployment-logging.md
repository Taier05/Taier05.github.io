# Ingress-Nginx 部署与访问日志配置手册

## 背景与目标

Ingress-Nginx 是 Kubernetes 集群中常用的 Ingress Controller，可用于统一接入 HTTP/HTTPS 流量、暴露集群内服务，并提供可观测的访问日志能力。本文记录基于官方清单部署 Ingress-Nginx、在非云负载均衡场景下调整 Service 暴露方式，以及配置结构化访问日志的推荐做法。

## 环境说明

- Kubernetes 集群已可正常访问
- 已安装 `kubectl`，且当前上下文具备集群管理权限
- 目标命名空间为 `ingress-nginx`
- 官方部署版本示例为 `controller-v1.14.0`

## 部署方式

### 方案一：直接使用官方清单部署

适用场景：

- 集群可直接访问 GitHub 原始内容
- 采用官方默认部署方式，后续仅做少量调整

执行命令：

```bash
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.14.0/deploy/static/provider/cloud/deploy.yaml
```

说明：

- 该方式部署简单，适合快速安装和标准化环境。
- 如果网络受限或镜像拉取存在障碍，应先下载 YAML，在本地修改镜像地址后再执行部署。

### 方案二：下载清单后按需修改再部署

适用场景：

- 受网络限制，无法直接拉取官方镜像或远程 YAML
- 需要提前调整镜像源、Service 类型或其他控制器参数

建议做法：

1. 先下载官方部署清单。
2. 按实际环境替换镜像地址。
3. 如无云厂商 LoadBalancer，提前将控制器 Service 调整为 `NodePort`。
4. 完成修改后再执行 `kubectl apply -f <本地文件>`。

## Service 暴露方式调整

### NodePort 场景的推荐修改

适用场景：

- 裸机集群
- 私有化环境
- 无可用云负载均衡器

修改命令：

```bash
kubectl edit svc ingress-nginx-controller -n ingress-nginx
```

重点调整项：

```yaml
spec:
  externalTrafficPolicy: Cluster
  type: NodePort
```

对应关系如下：

- 将 `type: LoadBalancer` 调整为 `type: NodePort`
- 将 `externalTrafficPolicy: Local` 调整为 `externalTrafficPolicy: Cluster`

选择建议：

- `NodePort` 适合没有外部负载均衡能力的环境，部署成本更低，但通常需要结合上层四层负载均衡、反向代理或节点 IP 直接访问。
- `LoadBalancer` 更适合云环境，能直接对外提供统一入口；若集群具备稳定的 LB 能力，优先保留官方默认方式。
- `externalTrafficPolicy: Cluster` 更利于在 NodePort 模式下保证流量转发可用性；如果业务明确依赖保留客户端源 IP，则需要结合网络拓扑重新评估是否使用 `Local`。

## 日志格式配置

为便于日志平台采集、检索和结构化分析，建议将 Ingress-Nginx 访问日志调整为 JSON 格式。

编辑 ConfigMap：

```bash
kubectl edit cm -n ingress-nginx ingress-nginx-controller
```

推荐配置：

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: ingress-nginx-controller
  namespace: ingress-nginx
data:
  log-format-escape-json: "true"
  log-format-upstream: >-
    {"timestamp":"$time_iso8601","domain":"$server_name","hostname":"$hostname","remote_user":"$remote_user","clientip":"$remote_addr","proxy_protocol_addr":"$proxy_protocol_addr","@source":"$server_addr","host":"$http_host","request":"$request","args":"$args","upstreamaddr":"$upstream_addr","status":"$status","upstream_status":"$upstream_status","bytes":"$body_bytes_sent","responsetime":"$request_time","upstreamtime":"$upstream_response_time","proxy_upstream_name":"$proxy_upstream_name","x_forwarded":"$http_x_forwarded_for","upstream_response_length":"$upstream_response_length","referer":"$http_referer","user_agent":"$http_user_agent","request_length":"$request_length","request_method":"$request_method","scheme":"$scheme","k8s_ingress_name":"$ingress_name","k8s_service_name":"$service_name","k8s_service_port":"$service_port"}
```

字段说明：

- `timestamp`：请求时间
- `domain`、`host`：请求域名信息
- `clientip`：客户端地址
- `request`、`request_method`、`args`：请求内容
- `status`、`upstream_status`：网关层和上游响应状态
- `responsetime`、`upstreamtime`：总耗时和上游耗时
- `k8s_ingress_name`、`k8s_service_name`、`k8s_service_port`：关联的 Kubernetes 资源信息

## 推荐操作步骤

1. 根据网络环境选择直接部署或下载后修改部署。
2. 完成安装后，确认 `ingress-nginx-controller` Pod 处于 `Running` 状态。
3. 若环境不支持 `LoadBalancer`，立即将 Service 改为 `NodePort`。
4. 配置 JSON 日志格式，便于后续接入日志系统。
5. 变更后检查控制器是否正确加载配置，并验证访问日志输出格式。

## 注意事项

- 使用远程 YAML 安装时，应确认版本与集群兼容，避免盲目升级控制器版本。
- 修改 Service 类型后，外部访问方式会改变，需要同步调整访问入口、DNS、负载均衡或安全组策略。
- 如果集群处于受限网络环境，镜像地址和 YAML 获取方式应提前准备，避免部署过程中断。
- JSON 日志格式依赖正确转义，`log-format-escape-json: "true"` 不应省略。

## 常见问题与排查

### 无法直接执行官方安装命令

排查方向：

- 检查集群节点是否能访问 GitHub 原始内容地址
- 检查镜像仓库是否可拉取官方镜像
- 必要时改为下载 YAML 后替换镜像地址再部署

### Service 改为 NodePort 后仍无法访问

排查方向：

- 确认 `ingress-nginx-controller` Service 已分配 NodePort
- 确认节点防火墙、安全组、上层负载均衡配置已放通对应端口
- 确认 Ingress 规则、后端 Service 和 Pod 均正常

### 日志未按 JSON 输出

排查方向：

- 确认修改的是 `ingress-nginx-controller` 对应 ConfigMap
- 确认 `log-format-upstream` 内容未被错误换行或截断
- 检查控制器是否已重新加载配置
