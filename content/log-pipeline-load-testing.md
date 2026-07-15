# 日志链路压测与瓶颈定位操作手册

## 背景与目标

本文用于在 Kubernetes 环境中对日志采集链路进行压测，并通过 Kafka、Logstash、Elasticsearch 的关键指标判断系统稳定吞吐上限。文中同时给出日志生成器部署方式、压测步骤、观测命令、瓶颈判定方法及测试数据清理方式。

适用链路：

- 应用日志 -> Kafka -> Logstash -> Elasticsearch
- 需要验证持续写入能力、削峰缓冲能力、异常栈多行日志处理能力的环境

## 环境说明

- Kubernetes 集群中存在 `logs` 命名空间下的 Kafka、Logstash、Elasticsearch 组件
- 压测日志生成器部署在 `load-test` 命名空间
- Logstash 开启了 Persistent Queue，便于观测写入堆积
- Elasticsearch 可通过集群内 `localhost:9200` 访问

## 日志生成器部署

### 部署说明

日志生成器以 Deployment 方式运行，支持通过环境变量调整单 Pod 速率、单条日志长度、批量写入大小，以及是否开启多行异常栈模拟。

- `RATE`：单 Pod 每秒日志条数
- `LINE_BYTES`：单条日志目标字节数
- `BATCH`：批量写入条数，用于降低输出开销
- `MULTILINE`：是否模拟多行异常栈日志

### 推荐部署清单

```yaml
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: log-generator
  namespace: load-test
spec:
  replicas: 1
  selector:
    matchLabels:
      app: log-generator
  template:
    metadata:
      labels:
        app: log-generator
    spec:
      containers:
      - name: gen
        image: registry.example.com/ops/python:3.11-alpine
        env:
        - name: RATE
          value: "1000"          # 每Pod每秒1000条
        - name: LINE_BYTES
          value: "300"           # 单条约300字节
        - name: BATCH
          value: "200"           # 批量写，降低开销
        - name: MULTILINE
          value: "0"             # 1=开启多行栈
        command: ["/bin/sh","-c"]
        args:
        - |
          python - <<'PY'
          import os, sys, time, random, string, datetime
          rate = int(os.getenv("RATE","1000"))
          line_bytes = int(os.getenv("LINE_BYTES","200"))
          batch = int(os.getenv("BATCH","200"))
          multiline = os.getenv("MULTILINE","0") == "1"

          # 预生成 payload（避免每次拼接太慢）
          base = "X" * max(0, line_bytes - 120)

          def ts():
            return datetime.datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]

          while True:
            t0 = time.time()
            for i in range(batch):
              if not multiline:
                sys.stdout.write(f"{ts()} INFO  [log-generator] id={random.randint(1,10**9)} msg={base}\n")
              else:
                # 第一行带时间戳，后续行不带（模拟常见 Java multiline）
                sys.stdout.write(f"{ts()} ERROR [app] Exception: boom id={random.randint(1,10**9)} {base}\n")
                sys.stdout.write("java.lang.RuntimeException: boom\n")
                sys.stdout.write("\tat com.test.A.a(A.java:1)\n")
                sys.stdout.write("\tat com.test.B.b(B.java:2)\n")
            sys.stdout.flush()
            target = batch / rate
            dt = time.time() - t0
            if target > dt:
              time.sleep(target - dt)
          PY
```

### 部署命令

```bash
kubectl create ns load-test
kubectl apply -f loggen.yaml
kubectl -n load-test get pod -l app=log-generator -w
```

## 压测步骤

### 基线压测

先从低流量启动，持续观察 5 到 10 分钟，确认链路稳定。

```bash
# replicas=1,RATE=1000,跑 5~10 分钟
```

重点关注：

- Kafka consumer lag 是否稳定
- Logstash PQ 是否仅短时波动后回落
- Elasticsearch 写入线程池是否正常

### 提升流量的两种方式

#### 方案一：提高单 Pod 速率

适用场景：验证单实例高频日志输出下的链路承载能力。

```bash
kubectl -n load-test set env deploy/log-generator RATE=5000
```

特点：

- 操作简单
- 更容易压测单源高频写入
- 对真实生产中“多应用、多节点并发写入”的模拟程度较弱

#### 方案二：横向扩容日志生成器

适用场景：更接近真实生产环境中的多节点、多来源日志写入模型。

```bash
kubectl -n load-test scale deploy/log-generator --replicas=10
```

特点：

- 更贴近真实分布式日志来源
- 更适合验证采集端和消费端的并发能力
- 对调度、节点资源、网络带宽的影响更明显

### 选择建议

- 如果目标是快速找出系统上限，优先从提高 `RATE` 开始
- 如果目标是评估真实接入场景下的稳定吞吐，优先增加 `replicas`
- 若需要同时验证吞吐和分布式来源特征，可先提高 `RATE`，再逐步扩 `replicas`

## 关键观测与判定方法

### Kafka：消费积压观测

进入 Kafka Pod 查看消费组 lag：

```bash
kubectl -n logs exec -it kafka-controller-0 -- bash
kafka-consumer-groups.sh --bootstrap-server <KAFKA_BOOTSTRAP>:9092 --describe --group logstash-applogs
```

判定原则：

- lag 持续增长，说明当前压测流量已经超过系统持续吞吐上限
- lag 只有短时波动后回落，通常属于正常抖动
- lag 一直上涨，通常表示下游存在瓶颈，常见于 Logstash 或 Elasticsearch

### Logstash：PQ 与 Pipeline 吞吐观测

查看单个 Logstash 实例 PQ 占用：

```bash
kubectl -n logs exec -it logstash-0 -- du -sh /usr/share/logstash/data/queue
```

循环观测多个实例 PQ 变化：

```bash
while true; do
  echo "$(date) - $(kubectl -n logs exec -it logstash-0 -- du -sh /usr/share/logstash/data/queue 2>/dev/null)";
  echo "$(date) - $(kubectl -n logs exec -it logstash-1 -- du -sh /usr/share/logstash/data/queue 2>/dev/null)";
  echo "$(date) - $(kubectl -n logs exec -it logstash-2 -- du -sh /usr/share/logstash/data/queue 2>/dev/null)";
  echo "$(date) - $(kubectl -n logs exec -it logstash-3 -- du -sh /usr/share/logstash/data/queue 2>/dev/null)";
  echo "----"
  sleep 2;
done
```

查看 Pipeline 事件吞吐：

```bash
kubectl -n logs port-forward svc/logstash 9600:9600
curl -s http://<IP_ADDRESS>:9600/_node/stats/pipelines?pretty | egrep -n '"events"|queue|in"|out"|duration'
```

判定原则：

- PQ 短时上涨但很快回落，说明系统具备一定抗抖动能力，通常属正常现象
- PQ 持续上涨，说明输出端写入能力不足，常见于 ES 写入跟不上或 Logstash Pipeline 输出过慢
- `events.in` 增速高于 `events.out` 且 PQ 同时增长，说明瓶颈出现在输出端

### Elasticsearch：写入压力观测

进入 Elasticsearch Pod 查看写入线程池：

```bash
kubectl -n logs exec -it elasticsearch-master-0 -- bash
export ES_PASSWORD='<ELASTIC_PASSWORD>'
curl -u "elastic:${ES_PASSWORD}" http://localhost:9200/_cat/thread_pool/write?v
```

判定原则：

- `write queue` 很高，表示写入请求已出现排队
- `rejected` 持续增加，说明 Elasticsearch 已成为明显瓶颈

说明：

- 不要在命令行中直接写入真实密码；示例使用 `<ELASTIC_PASSWORD>` 占位符
- 正式环境应通过 Secret、受控环境变量或临时凭据注入，并在压测结束后及时清理
- 压测会产生真实资源消耗和测试数据，执行前应明确影响范围、停止条件和回滚方案

## 稳定吞吐上限的判定方法

当出现以下任一现象，并持续存在而非短时抖动时，可判定系统已超过持续吞吐上限：

- Kafka consumer lag 持续增加
- Logstash PQ 一直变大
- Elasticsearch `write queue` 或 `rejected` 明显上升

处理方法：

1. 将当前压测流量下调一个档位
2. 重新持续观察一段时间
3. 找到 lag 不再增长、PQ 不再持续累积、ES 写入队列恢复稳定的那个档位

该档位可视为当前实验环境的稳定吞吐能力。

## 多种日志场景说明

### 单行日志场景

适用场景：

- 常规业务访问日志
- 结构化文本日志
- 对采集链路纯吞吐能力做基线测试

配置方式：

```bash
kubectl -n load-test set env deploy/log-generator MULTILINE=0
```

特点：

- 日志切分简单
- 更适合做纯吞吐对比
- 对多行聚合规则无额外压力

### 多行异常栈场景

适用场景：

- Java 异常栈
- 需要验证 multiline 聚合能力的采集配置

配置方式：

```bash
kubectl -n load-test set env deploy/log-generator MULTILINE=1
```

特点：

- 更接近真实应用报错场景
- 会额外考验采集端或处理端的多行合并配置
- 即使总字节量相近，处理成本通常高于单行日志

选择建议：

- 先用单行日志测基础吞吐
- 再用多行日志验证复杂场景下的可用上限

## 测试数据清理

测试结束后，可在 Kibana 中触发一次 rollover，先创建新的写入索引，再删除旧索引。

```http
POST /<WRITE_ALIAS>/_rollover
```

执行前建议确认：

- 当前写入别名是否正确指向目标索引
- 新索引已创建并接管写入流量
- 旧索引不再承担写入任务，避免误删当前活跃索引

## 注意事项

- 压测建议采用阶梯式提升，不建议一次性打满流量
- `replicas` 与 `RATE` 同时上调时，应记录每一档配置，便于回溯稳定区间
- 如果 `LINE_BYTES` 调整较大，实际吞吐瓶颈可能从“条数上限”转变为“字节带宽上限”
- 多行日志测试前，应确认采集链路已正确配置 multiline 规则，否则统计结果会失真
- `kubectl exec -it` 适合人工排查；若用于脚本长期采样，可根据实际终端环境去掉 `-it`

## 常见问题与排查方式

### Kafka lag 增长，但 Logstash PQ 不明显增长

优先排查：

- Logstash 消费能力是否不足
- Kafka 到 Logstash 的消费线程或消费组配置是否受限
- Logstash 实例数是否偏少

### Logstash PQ 持续变大

优先排查：

- Elasticsearch 写入是否已出现排队或拒绝
- Logstash 输出插件是否存在慢写问题
- 单批次写入参数是否过大或重试过多

### Elasticsearch write queue 偏高

优先排查：

- 数据节点 CPU、内存、磁盘 IOPS 是否不足
- 索引分片数、刷新策略、写入并发是否合理
- 压测流量是否已超出当前集群预期规格

### 单行日志吞吐正常，多行日志明显下降

优先排查：

- multiline 规则是否匹配准确
- 合并逻辑是否造成额外延迟或误聚合
- 处理端是否因异常栈日志长度和行数增加而放大开销
