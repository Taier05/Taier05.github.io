# NGINX Gateway Fabric 部署、配置与运维实践

## 背景与目标

本文用于在 Kubernetes 集群中部署 NGINX Gateway Fabric（NGF），并完成以下目标：

- 安装 Gateway API CRDs 与 NGF 控制面
- 创建带 TLS 终止能力的 Gateway，对外提供 80/443 访问
- 通过 HTTPRoute 将业务服务绑定到 Gateway
- 在使用 Cilium LoadBalancer IPPool 的环境中，为数据面 Service 自动注入标签，避免 `EXTERNAL-IP` 长期处于 `Pending`
- 对数据面与控制面进行基础容量优化
- 暴露数据面监控指标，便于接入 Prometheus 或进行临时排查

## 环境说明

- 已配置可用的 `kubeconfig`
- 已安装 `kubectl`、`helm`
- `kubectl` 支持 `kubectl kustomize`
- Gateway 相关资源命名空间使用 `nginx-gateway`
- 示例业务命名空间可使用 `demo`、`logs` 等独立命名空间
- 如集群使用 Cilium 管理 LoadBalancer 地址池，且 IPPool 配置了 `serviceSelector`，需确保生成的 Service 标签满足匹配条件

## 推荐部署方案

生产环境优先使用以下组合：

- Gateway API CRDs
- NGF 控制面
- `NginxProxy` 统一管理数据面 Deployment 与 Service
- Gateway 暴露 80/443，其中 443 执行 TLS Terminate
- 使用 `NginxProxy.spec.kubernetes.service.patches` 为数据面 Service 注入 `lb-pool=vip`、`bgp=blue`
- 数据面副本数至少 2，控制面副本数至少 2

该方案优于直接手工 `patch svc`，因为数据面 Service 由控制器托管，直接修改下游对象容易被回滚。

## 安装 Gateway API CRDs

建议使用较新的 standard channel 版本。现有资料中同时出现了 `v2.3.0` 与 `v2.4.2`，优先采用更新的 `v2.4.2`，如需与现网版本对齐可按实际兼容性调整。

```bash
kubectl kustomize "https://github.com/nginx/nginx-gateway-fabric/config/crd/gateway-api/standard?ref=v2.4.2" | kubectl apply -f -
kubectl get crd | grep gateway.networking.k8s.io
```

## 安装 NGF 控制面

```bash
helm install ngf oci://ghcr.io/nginx/charts/nginx-gateway-fabric \
  --create-namespace -n nginx-gateway

kubectl wait --timeout=5m -n nginx-gateway deployment/ngf-nginx-gateway-fabric --for=condition=Available
kubectl get pods -n nginx-gateway
kubectl get gatewayclass
```

如仅做快速验证，也可以直接安装默认参数；如需 NodePort 模式或更完整的生产配置，见后文多方案选择。

## 推荐的 NginxProxy 配置

以下配置同时覆盖日志格式、数据面副本、资源建议、跨节点分布、滚动升级与 Service 标签注入，适合作为生产默认基线。

```yaml
apiVersion: gateway.nginx.org/v1alpha2
kind: NginxProxy
metadata:
  name: gw-proxy
  namespace: nginx-gateway
spec:
  workerConnections: 4096
  logging:
    accessLog:
      format: '{"timestamp":"$time_iso8601","domain":"$host","server_name":"$server_name","hostname":"$hostname","clientip":"$remote_addr","x_forwarded_for":"$http_x_forwarded_for","request":"$request","uri":"$uri","args":"$args","status":$status,"bytes":$body_bytes_sent,"request_time":$request_time,"upstream_addr":"$upstream_addr","upstream_status":"$upstream_status","upstream_time":"$upstream_response_time","referer":"$http_referer","user_agent":"$http_user_agent","request_length":$request_length,"request_method":"$request_method","scheme":"$scheme"}'
  kubernetes:
    deployment:
      replicas: 2
      container:
        resources:
          requests:
            cpu: 200m
            memory: 256Mi
          limits:
            cpu: "1"
            memory: 1Gi
      pod:
        terminationGracePeriodSeconds: 60
      patches:
        - type: StrategicMerge
          value:
            spec:
              strategy:
                type: RollingUpdate
                rollingUpdate:
                  maxUnavailable: 0
                  maxSurge: 1
              template:
                spec:
                  affinity:
                    podAntiAffinity:
                      preferredDuringSchedulingIgnoredDuringExecution:
                        - weight: 100
                          podAffinityTerm:
                            labelSelector:
                              matchExpressions:
                                - key: gateway.networking.k8s.io/gateway-name
                                  operator: Exists
                            topologyKey: kubernetes.io/hostname
    service:
      type: LoadBalancer
      patches:
        - type: Merge
          value:
            metadata:
              labels:
                lb-pool: vip
                bgp: blue
```

应用配置：

```bash
kubectl apply -f gw-proxy.yaml
```

如果当前集群中已存在 `ngf-proxy-config`，也可以直接对其执行合并补丁：

```bash
kubectl -n nginx-gateway patch nginxproxy.gateway.nginx.org ngf-proxy-config --type=merge -p '{
  "spec":{
    "kubernetes":{
      "service":{
        "patches":[
          {
            "type":"Merge",
            "value":{
              "metadata":{
                "labels":{
                  "lb-pool":"vip",
                  "bgp":"blue"
                }
              }
            }
          }
        ]
      }
    }
  }
}'
```

## 全局策略配置

### ClientSettingsPolicy

适用于需要放大上传体积限制的场景：

```bash
kubectl apply -n nginx-gateway -f - <<'EOF'
apiVersion: gateway.nginx.org/v1alpha1
kind: ClientSettingsPolicy
metadata:
  name: example-gw-client
spec:
  targetRef:
    group: gateway.networking.k8s.io
    kind: Gateway
    name: example-gw
  body:
    maxSize: 500m
EOF
```

### SnippetsPolicy

适用于需要统一处理上传、超时、请求头、`X-Request-ID` 与 NGINX worker 行为的场景：

```bash
kubectl apply -n nginx-gateway -f - <<'EOF'
apiVersion: gateway.nginx.org/v1alpha1
kind: SnippetsPolicy
metadata:
  name: example-gw-snippets
spec:
  targetRefs:
    - group: gateway.networking.k8s.io
      kind: Gateway
      name: example-gw
  snippets:
    - context: main
      value: |
        worker_cpu_affinity auto;
        events { worker_connections 65536; }
    - context: http
      value: |
        underscores_in_headers on;
        ignore_invalid_headers on;
        server_tokens off;
        proxy_request_buffering off;
        proxy_connect_timeout 300s;
        proxy_read_timeout 300s;
        proxy_send_timeout 600s;
        proxy_pass_header Server;
    - context: http.server.location
      value: |
        set $xrid $http_x_request_id;
        if ($xrid = "") { set $xrid $request_id; }
        proxy_set_header X-Request-ID $xrid;
        add_header X-Request-ID $xrid always;
EOF
```

## 准备 TLS 证书

证书 Secret 建议与 Gateway 放在同一命名空间，即 `nginx-gateway`。

```bash
kubectl -n nginx-gateway create secret tls example-tls \
  --cert=example.com.pem \
  --key=example.com.key

kubectl -n nginx-gateway get secret example-tls
openssl x509 -in example.com.pem -noout -text | egrep -n "Subject:|Subject Alternative Name|DNS:"
```

## 创建 Gateway

推荐同时开放 80/443，并显式允许其他命名空间的 Route 绑定：

```bash
kubectl apply -n nginx-gateway -f - <<'EOF'
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: example-gw
spec:
  gatewayClassName: nginx
  infrastructure:
    parametersRef:
      group: gateway.nginx.org
      kind: NginxProxy
      name: gw-proxy
  listeners:
    - name: http
      protocol: HTTP
      port: 80
      allowedRoutes:
        namespaces:
          from: All
    - name: https
      protocol: HTTPS
      port: 443
      tls:
        mode: Terminate
        certificateRefs:
          - kind: Secret
            name: example-tls
      allowedRoutes:
        namespaces:
          from: All
EOF
```

创建后，NGF 会在 `nginx-gateway` 命名空间生成对应数据面 Deployment 与 Service，常见命名格式为 `<gateway-name>-nginx`。

## 创建业务路由

### 场景一：HTTP 与 HTTPS 都可访问

适合内网验证、迁移期兼容或无需强制跳转的场景。

```bash
kubectl apply -n demo -f - <<'EOF'
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: echo-route
spec:
  parentRefs:
    - name: example-gw
      namespace: nginx-gateway
  hostnames:
    - demo.example.com
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /
      backendRefs:
        - name: echo
          port: 80
EOF
```

### 场景二：HTTP 自动跳转 HTTPS

这是对外暴露业务时的推荐方案。

```bash
kubectl apply -f - <<'EOF'
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: demo-http-redirect
  namespace: demo
spec:
  parentRefs:
    - name: example-gw
      namespace: nginx-gateway
      sectionName: http
  hostnames:
    - "demo.example.com"
  rules:
    - filters:
        - type: RequestRedirect
          requestRedirect:
            scheme: https
            port: 443
---
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: demo-https
  namespace: demo
spec:
  parentRefs:
    - name: example-gw
      namespace: nginx-gateway
      sectionName: https
  hostnames:
    - "demo.example.com"
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /
      backendRefs:
        - name: echo
          port: 80
EOF
```

### 场景三：仅开放 HTTPS

适合纯生产入口、无需开放 80 端口的场景。此时可在 Gateway 中移除 80 listener。

```bash
kubectl apply -n demo -f - <<'EOF'
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: demo-https-only
spec:
  parentRefs:
    - name: example-gw
      namespace: nginx-gateway
      sectionName: https
  hostnames:
    - demo.example.com
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /
      backendRefs:
        - name: echo
          port: 80
EOF
```

## 多方案与适用场景

### LoadBalancer 模式

适用场景：

- 集群已具备 LoadBalancer 能力
- 需要固定对外地址
- 使用 Cilium、BGP、VIP 池等网络能力统一管理外部入口

特点：

- 更适合生产环境
- 可结合 `serviceSelector`、BGP、VIP 池做精细控制
- 需要重点处理 Service 标签注入问题

### NodePort 模式

适用场景：

- 测试环境
- 集群没有可用的 LoadBalancer 控制器
- 由外部 SLB、F5、Nginx、硬件负载均衡直接转发到节点端口

示例：

```bash
cat >/root/values-ngf-nodeport.yaml <<'EOF'
nginx:
  service:
    type: NodePort
    externalTrafficPolicy: Cluster
    nodePorts:
      - port: 30080
        listenerPort: 80
      - port: 30443
        listenerPort: 443
nginxGateway:
  replicas: 2
EOF

helm upgrade --install ngf oci://ghcr.io/nginx/charts/nginx-gateway-fabric \
  -n nginx-gateway \
  --create-namespace \
  -f /root/values-ngf-nodeport.yaml
```

NodePort 模式验证：

```bash
kubectl get svc -n nginx-gateway -o wide
curl -I --resolve demo.example.com:30080:<IP_ADDRESS> http://demo.example.com:30080/
curl -k --resolve demo.example.com:30443:<IP_ADDRESS> https://demo.example.com:30443/
```

## 数据面与控制面优化

### 数据面优化建议

- 副本数至少 2，避免单副本故障导致入口中断
- 开启 `podAntiAffinity`，尽量分散到不同节点
- 滚动升级设置 `maxUnavailable: 0`
- 配置合理的 `requests` 与 `limits`
- 使用结构化访问日志，便于日志平台解析

### 控制面优化建议

将控制面 Deployment 扩容至 2 副本：

```bash
kubectl scale deployment -n nginx-gateway ngf-nginx-gateway-fabric --replicas 2
```

## 监控指标暴露

为数据面单独创建 metrics Service：

```bash
cat <<'EOF' | kubectl apply -f -
apiVersion: v1
kind: Service
metadata:
  name: example-gw-nginx-metrics
  namespace: nginx-gateway
spec:
  selector:
    app.kubernetes.io/instance: ngf
    app.kubernetes.io/managed-by: ngf-nginx
    app.kubernetes.io/name: example-gw-nginx
    gateway.networking.k8s.io/gateway-name: example-gw
  ports:
    - name: metrics
      port: 9113
      targetPort: 9113
  type: ClusterIP
EOF
```

验证方式：

```bash
kubectl run alpine-debug --rm -it --restart=Never \
  --image=swr.cn-south-1.myhuaweicloud.com/yalex/alpine:3.20.yalex \
  --command -- curl http://example-gw-nginx-metrics.nginx-gateway.svc:9113/metrics
```

如果仅在当前主机已具备网络连通，也可直接访问：

```bash
curl http://example-gw-nginx-metrics.nginx-gateway.svc:9113/metrics
```

## 常见问题与排查

### `EXTERNAL-IP` 长期为 `Pending`

典型现象：

- Service 为 `nginx-gateway/<gateway-name>-nginx`
- `kubectl get svc` 中 `EXTERNAL-IP` 长期为空

重点排查：

```bash
kubectl -n nginx-gateway get svc example-gw-nginx -o yaml
kubectl get ciliumloadbalancerippools -o yaml
```

若看到类似以下状态，通常说明 Service 未匹配到可用 IPPool：

- `status.conditions[].reason: no_pool`
- `There are no enabled CiliumLoadBalancerIPPools that match this service`

根因通常有两类：

1. Cilium 的 `CiliumLoadBalancerIPPool` 配置了 `serviceSelector`，例如要求 `lb-pool=vip`
2. 数据面 Service 由 NGF 控制器托管，手工 `kubectl patch svc` 会被后续 reconcile 覆盖

错误做法示例：

```bash
kubectl -n nginx-gateway patch svc example-gw-nginx -p '{
  "spec": { "type": "LoadBalancer" },
  "metadata": { "labels": { "lb-pool":"vip", "bgp":"blue" } }
}'
```

推荐修复方式是修改上游 `NginxProxy`，而不是修改下游 Service：

```bash
kubectl -n nginx-gateway patch nginxproxy.gateway.nginx.org ngf-proxy-config --type=merge -p '{
  "spec":{"kubernetes":{"service":{"patches":[
    {"type":"Merge","value":{"metadata":{"labels":{"lb-pool":"vip","bgp":"blue"}}}}
  ]}}}
}'
```

修复后验证：

```bash
kubectl -n nginx-gateway get svc example-gw-nginx -o yaml
kubectl -n nginx-gateway get svc example-gw-nginx -w
```

预期结果：

- `metadata.labels` 包含 `lb-pool=vip`、`bgp=blue`
- `cilium.io/IPAMRequestSatisfied=True`
- `EXTERNAL-IP` 被成功分配

如果 patch 规则已更新，但既有 Service 仍未体现新标签，可删除数据面 Service 让 NGF 自动重建：

```bash
kubectl -n nginx-gateway delete svc example-gw-nginx
kubectl get svc -n nginx-gateway -w
```

### HTTPRoute 无法绑定到 Gateway

检查以下两点：

```bash
kubectl describe httproute -n demo echo-route
kubectl describe gateway -n nginx-gateway example-gw
```

重点确认：

- `parentRefs.namespace` 是否显式指向 `nginx-gateway`
- Gateway listener 是否配置了 `allowedRoutes.namespaces.from: All`
- `Accepted=True`、`ResolvedRefs=True` 是否正常

### 证书引用失败

重点确认：

- Gateway 与 Secret 是否位于同一命名空间
- `certificateRefs.name` 是否与 Secret 名称一致
- 证书 SAN 中是否包含访问域名

### 指标抓取不到

重点确认：

- metrics Service 的 selector 是否与目标数据面 Pod 标签一致
- 目标容器是否监听 `9113`
- 命名空间 DNS 与网络策略是否允许访问

## 验证步骤

```bash
kubectl get deploy,svc -n nginx-gateway
kubectl describe gateway -n nginx-gateway example-gw
kubectl describe httproute -n demo echo-route
kubectl get svc -n nginx-gateway example-gw-nginx -o wide
kubectl get svc -n nginx-gateway example-gw-nginx --show-labels
```

如需从外部直接验证：

```bash
LB=$(kubectl -n nginx-gateway get svc example-gw-nginx -o jsonpath='{.status.loadBalancer.ingress[0].ip}')
curl -H "Host: demo.example.com" "http://$LB/"
curl -k -H "Host: demo.example.com" "https://$LB/"
```

若返回的是 hostname 而非 IP，请改取 `.status.loadBalancer.ingress[0].hostname`。

## 注意事项

- 控制器托管的 Service 不应作为长期配置入口，正式变更应落到 `NginxProxy`、Gateway 或 Helm values
- 若未来会执行 `helm upgrade`，应将 `NginxProxy` 或 Service patch 配置固化到发布清单中，避免升级后丢失
- `allowedRoutes.namespaces.from: All` 提高了跨命名空间绑定灵活性，但也要结合权限管理使用
- NodePort 与 LoadBalancer 适用场景不同，不建议在生产入口上长期混用不受控的暴露方式

## 卸载

```bash
helm uninstall ngf -n nginx-gateway
```

Gateway API CRDs 是否删除应按集群统一规划决定，通常不建议在共享集群中随意移除。
