# Categraf 无法采集 Ceph Metrics：503 故障复盘

## 基本信息

- 时间：2026-04-20
- 环境：Kubernetes
- 相关命名空间：
  - `monitoring`
  - `rook-ceph`
- 相关组件：
  - `categraf-ceph`
  - `rook-ceph-mgr`

## 现象

- `categraf-ceph` 无法采集到 Ceph 指标
- `categraf-ceph` 配置指向：

```toml
[[instances]]
urls = ["http://rook-ceph-mgr.rook-ceph.svc:9283/metrics"]
labels = { job="ceph" }
```

- 从 `categraf-ceph` Pod 内访问 `/metrics` 时，最初返回：

```http
HTTP/1.1 503 Service Unavailable
```

- 返回体中的关键信息为：

```text
Gathering data took 60.02 seconds, metrics are stale for 45.02 seconds, returning "service unavailable".
```

## 排查结论

- 问题不在 `categraf-ceph` 配置，也不在网络连通性
- `rook-ceph-mgr` 的 Service 和 Endpoints 正常
- 根因在 `Ceph mgr` 的 `prometheus` 模块
- `mgr` 在生成 `/metrics` 时耗时过长，缓存过期后按当前策略直接返回 `503`

## 排查中确认到的关键状态

- `mgr/prometheus/cache = true`
- `mgr/prometheus/exclude_perf_counters = true`
- `mgr/prometheus/scrape_interval = 15`
- 初始行为等价于缓存过期时失败返回 `503`

从 `Ceph mgr` 容器内源码确认，`prometheus` 模块支持以下两种陈旧缓存策略：

- `fail`
- `return`

其行为如下：

- `fail`：缓存过期时返回 `503`
- `return`：缓存过期时返回旧缓存内容

## 本次实际执行的变更

本次只修改了 `mgr` 侧，未对 `OSD`、`MON` 做任何调整。

### 变更 1

将 `mgr/prometheus/stale_cache_strategy` 设置为 `return`

执行命令：

```bash
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- \
  ceph config set mgr mgr/prometheus/stale_cache_strategy return
```

校验命令：

```bash
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- \
  ceph config get mgr mgr/prometheus/stale_cache_strategy
```

校验结果：

```text
return
```

### 变更 2

由于配置写入后，原 active `mgr.a` 仍然继续返回旧行为的 `503`，因此执行了一次仅针对 `mgr` 的主备切换，让新的 active `mgr` 完整加载配置。

执行命令：

```bash
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph mgr fail a
```

切换结果：

- 原 active：`mgr.a`
- 新 active：`mgr.b`

## 变更后验证结果

### Service 指向新的 active mgr

```bash
kubectl -n rook-ceph get endpoints rook-ceph-mgr -o wide
```

结果显示 `rook-ceph-mgr` 已指向新的 active `mgr.b`

### 从 `categraf-ceph` Pod 内验证 `/metrics`

执行命令：

```bash
kubectl -n monitoring exec deploy/categraf-ceph -- \
  sh -lc "curl -sS -D - --max-time 20 http://rook-ceph-mgr.rook-ceph.svc:9283/metrics | sed -n '1,60p'"
```

返回结果：

```http
HTTP/1.1 200 OK
Content-Type: text/plain;charset=utf-8
```

并且已经返回真实指标，例如：

```text
ceph_health_status
ceph_mon_quorum_status
ceph_mon_metadata
ceph_mgr_status
ceph_mgr_module_status
```

### mgr 日志验证

`mgr-b` 日志中已出现成功访问记录：

```text
"GET /metrics HTTP/1.1" 200
```

## 本次到底改了什么

如果只看最终生效动作，本次只做了两件事：

1. 将 `Ceph mgr prometheus` 模块的陈旧缓存策略改为 `return`
2. 将 active `mgr` 从 `a` 切换到 `b`，让新 active 实例按新配置提供 `/metrics`

没有做的事情：

- 没有修改 `categraf-ceph` 配置
- 没有修改 `OSD`
- 没有修改 `MON`
- 没有修改 `Service`、`Endpoints`、`ConfigMap`
- 没有升级 Ceph、Rook 或 Categraf

## 如果要还原，怎么还原

### 还原配置

回滚时应恢复为变更前实际记录的值，不要直接照抄其他环境：

```bash
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- \
  ceph config set mgr mgr/prometheus/stale_cache_strategy <ORIGINAL_VALUE>
```

说明：

- Ceph 官方文档明确给出了 `return` 与 `fail` 两种行为配置
- 部分版本的默认显示值可能为 `log`，应以现场版本、变更前记录和模块实际行为为准
- 如果没有记录原值，先停止回滚动作并核对版本文档，不要凭经验猜测

回滚后校验：

```bash
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- \
  ceph config get mgr mgr/prometheus/stale_cache_strategy
```

### 让回滚配置生效

和本次变更一样，配置是否立即被当前 active `mgr` 完整采用，可能依赖模块重载或 active 切换。

如果回滚后仍然看到旧行为，可以只动 `mgr` 再做一次主备切换，例如：

```bash
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph mgr fail b
```

说明：

- 当前 active 已经是 `mgr.b`
- 执行后会触发 active 切换
- 这一步只影响 `mgr`，不涉及 `OSD` / `MON`

### 还原后的预期表现

如果成功回滚为原行为，当 `/metrics` 生成再次超过缓存允许范围时，应重新出现：

```http
HTTP/1.1 503 Service Unavailable
```

以及类似提示：

```text
returning "service unavailable"
```

## 建议

- 当前方案本质上是“优先保证能取到 metrics”，即允许返回旧缓存
- 这适合监控采集恢复，但不代表 `mgr` 指标生成变慢的问题已经根治
- 后续如果要彻底解决，还应继续只读分析为什么 `mgr` 生成 `/metrics` 持续接近或超过 60 秒

## 可直接复用的命令

### 查看当前策略

```bash
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- \
  ceph config get mgr mgr/prometheus/stale_cache_strategy
```

### 设置为 return

```bash
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- \
  ceph config set mgr mgr/prometheus/stale_cache_strategy return
```

### 回滚为原值

```bash
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- \
  ceph config set mgr mgr/prometheus/stale_cache_strategy log
```

### 主动切换当前 active mgr

```bash
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph mgr stat
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph mgr fail <当前active名称>
```

### 验证 metrics 是否返回数据

```bash
kubectl -n monitoring exec deploy/categraf-ceph -- \
  sh -lc "curl -sS -D - --max-time 20 http://rook-ceph-mgr.rook-ceph.svc:9283/metrics | sed -n '1,60p'"
```

## 官方参考

- [Ceph Prometheus Module：stale cache 策略](https://docs.ceph.com/en/latest/mgr/prometheus/)
