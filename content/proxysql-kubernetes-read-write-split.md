# Kubernetes 中 ProxySQL 读写分离部署与运维手册

> 安全与一致性提示：本文已移除 ProxySQL 管理、监控和业务凭据。配置文件主要用于首次启动引导，ProxySQL 首次运行后磁盘 SQLite 配置可能优先生效；变更后需明确执行 LOAD TO RUNTIME 与 SAVE TO DISK。管理端口只监听本地，业务切流前必须灰度验证读写规则、事务与故障回落。

## 背景与目标

本文用于在 Kubernetes 集群中部署 ProxySQL，并为 MySQL 主从架构提供以下能力：

- 基于 `read_only` 自动识别主从角色
- 将普通 `SELECT` 路由到读组
- 将事务锁定查询和写请求路由到写组
- 对外提供集群内访问、LoadBalancer 暴露及临时 NodePort 验证方式
- 开启 ProxySQL REST API 指标接口，便于后续监控接入

当前示例中：

- 写组 hostgroup 为 `10`
- 读组 hostgroup 为 `20`
- 通过 `mysql_query_rules` 实现基础读写分离
- 当读组不可用时，允许回落到写组

## 环境说明

示例部署要点如下：

- 命名空间：`proxysql`
- ProxySQL 管理端口：`6032`
- ProxySQL 业务端口：`6033`
- 指标端口：`6070`
- 副本数：`2`
- 持久化目录：`/var/lib/proxysql`
- Service 暴露方式：
  - `proxysql-headless`：集群内直连与 StatefulSet 配套
  - `proxysql`：`LoadBalancer`，适合长期业务接入
  - `proxysql-admin`：集群内管理端口访问
  - `proxysql-metrics`：集群内指标访问

MySQL 后端示例：

- `mysql.example.internal:3306` 同时加入写组和读组
- `mysql.example.internal:3307-3311` 加入读组

这种配置适用于单主多从场景，其中主库在必要时可承担兜底读流量。

## 部署步骤

### 1. 创建部署清单

以下清单可直接保存为 `proxysql.yaml` 后执行部署：

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: proxysql-config
  namespace: proxysql
data:
  proxysql.cnf: |
    datadir="/var/lib/proxysql"

    admin_variables=
    {
      admin_credentials="<ADMIN_USER>:<ADMIN_PASSWORD>"
      mysql_ifaces="127.0.0.1:6032"
      refresh_interval=2000
      web_enabled=false
      restapi_enabled=true
      restapi_port=6070
      prometheus_memory_metrics_interval=60
    }

    mysql_variables=
    {
      threads=4
      max_connections=5000
      default_query_delay=0
      default_query_timeout=36000000
      have_compress=true
      poll_timeout=2000
      interfaces="0.0.0.0:6033"
      default_schema="information_schema"
      server_version="8.4"
      connect_timeout_server=3000
      monitor_history=60000
      monitor_connect_interval=15000
      monitor_ping_interval=10000
      monitor_read_only_interval=10000
      monitor_read_only_timeout=500
      monitor_username="proxysql_monitor"
      monitor_password="<MONITOR_PASSWORD>"
      monitor_writer_is_also_reader=true
    }

    mysql_servers =
    (
      { hostgroup=10, address="mysql.example.internal", port=3306, weight=1,    max_connections=6666, max_replication_lag=0 },
      { hostgroup=20, address="mysql.example.internal", port=3306, weight=1,    max_connections=6666, max_replication_lag=0 },
      { hostgroup=20, address="mysql.example.internal", port=3307, weight=1000, max_connections=6666, max_replication_lag=666 },
      { hostgroup=20, address="mysql.example.internal", port=3308, weight=1000, max_connections=6666, max_replication_lag=666 },
      { hostgroup=20, address="mysql.example.internal", port=3309, weight=1000, max_connections=6666, max_replication_lag=666 },
      { hostgroup=20, address="mysql.example.internal", port=3310, weight=1000, max_connections=6666, max_replication_lag=666 },
      { hostgroup=20, address="mysql.example.internal", port=3311, weight=1000, max_connections=6666, max_replication_lag=666 }
    )

    mysql_replication_hostgroups =
    (
      { writer_hostgroup=10, reader_hostgroup=20, check_type="read_only", comment="mysql主从" }
    )

    mysql_users =
    (
      { username="app_user", password="<APP_USER_PASSWORD>", default_hostgroup=10, active=1, max_connections=65535 },
      { username="app_admin", password="<APP_ADMIN_PASSWORD>",      default_hostgroup=10, active=1, max_connections=65535 }
    )

    mysql_query_rules =
    (
      { rule_id=10, active=1, match_pattern="^SELECT.*FOR UPDATE",         destination_hostgroup=10, apply=1 },
      { rule_id=11, active=1, match_pattern="^SELECT.*LOCK IN SHARE MODE", destination_hostgroup=10, apply=1 },
      { rule_id=20, active=1, match_pattern="^SELECT",                     destination_hostgroup=20, apply=1 },
      { rule_id=30, active=1, match_pattern=".*",                          destination_hostgroup=10, apply=1 }
    )
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: proxysql
  namespace: proxysql
  labels:
    app: proxysql
spec:
  serviceName: proxysql-headless
  replicas: 2
  selector:
    matchLabels:
      app: proxysql
  template:
    metadata:
      labels:
        app: proxysql
    spec:
      terminationGracePeriodSeconds: 10
      affinity:
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
          - weight: 100
            podAffinityTerm:
              labelSelector:
                matchLabels:
                  app: proxysql
              topologyKey: kubernetes.io/hostname
      containers:
      - name: proxysql
        image: registry.example.com/database/proxysql:2.7.2
        imagePullPolicy: IfNotPresent
        ports:
        - name: mysql
          containerPort: 6033
        - name: admin
          containerPort: 6032
        - name: metrics
          containerPort: 6070
        volumeMounts:
        - name: config
          mountPath: /etc/proxysql.cnf
          subPath: proxysql.cnf
        - name: data
          mountPath: /var/lib/proxysql
        readinessProbe:
          tcpSocket:
            port: 6033
          initialDelaySeconds: 3
          periodSeconds: 5
          timeoutSeconds: 1
          failureThreshold: 6
        livenessProbe:
          tcpSocket:
            port: 6033
          initialDelaySeconds: 10
          periodSeconds: 10
          timeoutSeconds: 1
          failureThreshold: 6
        resources:
          requests:
            cpu: 100m
            memory: 256Mi
          limits:
            cpu: "1"
            memory: 1Gi
      volumes:
      - name: config
        configMap:
          name: proxysql-config
  volumeClaimTemplates:
  - metadata:
      name: data
    spec:
      accessModes:
      - ReadWriteOnce
      storageClassName: nfs-storage
      resources:
        requests:
          storage: 10Gi
---
apiVersion: v1
kind: Service
metadata:
  name: proxysql-headless
  namespace: proxysql
spec:
  clusterIP: None
  selector:
    app: proxysql
  ports:
  - name: mysql
    port: 6033
    targetPort: 6033
  - name: admin
    port: 6032
    targetPort: 6032
---
apiVersion: v1
kind: Service
metadata:
  name: proxysql
  namespace: proxysql
  labels:
    bgp-lb: "enabled"
spec:
  type: LoadBalancer
  loadBalancerIP: <LOAD_BALANCER_IP>
  selector:
    app: proxysql
  ports:
  - name: mysql
    port: 6033
    targetPort: 6033
  - name: admin
    port: 6032
    targetPort: 6032
---
apiVersion: v1
kind: Service
metadata:
  name: proxysql-admin
  namespace: proxysql
spec:
  type: ClusterIP
  selector:
    app: proxysql
  ports:
  - name: admin
    port: 6032
    targetPort: 6032
---
apiVersion: v1
kind: Service
metadata:
  name: proxysql-metrics
  namespace: proxysql
spec:
  type: ClusterIP
  selector:
    app: proxysql
  ports:
  - name: metrics
    port: 6070
    targetPort: 6070
```

### 2. 应用资源

```bash
kubectl apply -f proxysql.yaml
```

## 管理连接方式

### 方式一：直接进入 Pod 执行管理命令

适用场景：

- 首次部署后检查配置是否加载成功
- 不希望额外暴露管理端口

```bash
kubectl -n proxysql exec -it proxysql-0 -- mysql -h 127.0.0.1 -P 6032 -u admin -p
```

### 方式二：先进入容器再连接管理端口

适用场景：

- 容器内需要顺带执行网络连通性或文件检查

```bash
kubectl -n proxysql exec -it proxysql-0 -- sh
mysql -h 127.0.0.1 -P 6032 -u admin -p
```

## 业务访问方案

### 集群内访问

适用场景：

- 应用本身部署在 Kubernetes 内部
- 希望通过稳定 Service 名称接入

推荐 JDBC 连接串：

```text
jdbc:mysql://proxysql-headless.db-proxy.svc.cluster.local:6033/你的库名?useSSL=false&serverTimezone=Asia/Shanghai
```

如果 ProxySQL 实际部署在 `proxysql` 命名空间，则应优先使用与命名空间一致的域名，例如：

```text
jdbc:mysql://proxysql-headless.proxysql.svc.cluster.local:6033/你的库名?useSSL=false&serverTimezone=Asia/Shanghai
```

选择建议：

- 同命名空间内部访问，优先使用当前实际 Service 域名
- 跨命名空间接入时，务必确认 FQDN 与部署命名空间一致，避免解析错误

### LoadBalancer 暴露

适用场景：

- 集群外长期接入
- 已有 BGP、MetalLB 或云厂商 LoadBalancer 能力

当前配置中：

- Service 名称：`proxysql`
- 类型：`LoadBalancer`
- 固定地址：`<LOAD_BALANCER_IP>`

这是比临时 NodePort 更适合生产的方式，地址稳定，接入层更清晰。

### NodePort 临时验证

适用场景：

- 仅用于快速验证读写分离
- 集群尚未具备对外 LoadBalancer 能力

```bash
cat <<'EOF' | kubectl apply -f -
apiVersion: v1
kind: Service
metadata:
  name: proxysql-nodeport
  namespace: proxysql
spec:
  type: NodePort
  selector:
    app: proxysql
  ports:
  - port: 6033
    targetPort: 6033
    nodePort: 32577
EOF
```

说明：

- NodePort 适合作为临时验证入口
- 长期使用时，优先选择 `LoadBalancer`
- 若固定端口 `32577` 与集群现有端口冲突，需要调整

## 读写分离验证

### 验证读请求是否进入读组

```bash
mysql -u app_user -p -h mysql.example.internal -P 32577 -e "SELECT @@hostname, @@server_id, @@server_uuid, @@port, @@read_only;"
```

或在集群内部直接测试：

```bash
mysql -u app_user -p -h proxysql-headless.proxysql.svc.cluster.local -P 6033 -e "SELECT @@hostname, @@server_id, @@server_uuid, @@port, @@read_only;"
```

判断依据：

- 普通 `SELECT` 应优先命中读组
- 返回结果中的 `@@port`、`@@hostname`、`@@read_only` 可用于识别实际落点

### 验证写请求和锁定查询是否进入写组

```bash
mysql -u app_user -p -h mysql.example.internal -P 32577 -e "
USE appdb;
INSERT INTO proxysql_write_test(id) VALUES(2)
  ON DUPLICATE KEY UPDATE ts=CURRENT_TIMESTAMP;
SELECT @@hostname, @@server_id, @@read_only;
START TRANSACTION;
SELECT COUNT(*) FROM proxysql_write_test FOR UPDATE;
SELECT @@hostname, @@server_id, @@read_only;
COMMIT;
"
```

判断依据：

- `INSERT` 必须落到写组
- `SELECT ... FOR UPDATE` 必须落到写组
- 如果读组全部不可用，普通查询也可能回落到写组，这是 `monitor_writer_is_also_reader=true` 的预期行为

## 路由规则说明

当前规则优先级为：

1. `SELECT ... FOR UPDATE` 路由到写组 `10`
2. `SELECT ... LOCK IN SHARE MODE` 路由到写组 `10`
3. 普通 `SELECT` 路由到读组 `20`
4. 其余全部语句路由到写组 `10`

这种规则适用于典型 OLTP 场景，但需要注意以下差异：

- 适合保守一致性策略的场景：将锁定读取明确送往主库，避免从库读取带来的语义偏差
- 适合读流量分担的场景：普通查询尽量进入读组
- 不适合所有 SQL 形态完全自动识别的场景：复杂事务、多语句、函数副作用语句仍需结合业务验证

如果业务存在大量对一致性敏感的读取，应考虑减少读分离范围，或仅对白名单查询做读路由。

## 监控与高可用要点

### 主从识别

通过如下配置自动识别：

```text
mysql_replication_hostgroups =
(
  { writer_hostgroup=10, reader_hostgroup=20, check_type="read_only", comment="mysql主从" }
)
```

这意味着：

- 主库应为 `read_only=0`
- 从库应为 `read_only=1`
- ProxySQL 依据该状态维护读写分组关系

### 读组故障回落

```text
monitor_writer_is_also_reader=true
```

适用场景：

- 需要在从库故障时保持查询可用性

代价：

- 主库可能承接额外读流量
- 高峰时需要关注主库负载

选择建议：

- 可用性优先时保留该配置
- 主库压力敏感时，应结合业务峰值审慎评估

### 副本部署建议

`StatefulSet` 副本数为 `2`，并配置了反亲和性，适合基础高可用部署。生产环境建议进一步确认：

- 两个 Pod 是否确实分布在不同节点
- 底层存储类是否满足 `ReadWriteOnce` 和性能要求
- `storageClassName` 与实际环境一致

原始注释中同时提到 `nfs-storage` 与 Ceph 动态供应，实际部署时应二选一，并以真实可用的 StorageClass 为准。

## 常见问题与排查

### 1. 业务连接命中了错误的命名空间域名

现象：

- JDBC 或命令行连接域名无法解析
- Service 明明存在，但连接失败

排查方式：

- 确认 ProxySQL 所在命名空间
- 确认使用的是 `proxysql-headless.<namespace>.svc.cluster.local`
- 若示例中的 `db-proxy` 并非实际命名空间，应改为真实值

### 2. 普通查询落到了主库

可能原因：

- 读组节点不可用
- 读组节点复制延迟过高或健康检查失败
- 开启了 `monitor_writer_is_also_reader=true`，触发回落

排查方式：

- 检查各从库 `read_only` 状态
- 检查 ProxySQL 监控账号是否能正常探测后端
- 检查从库连通性和复制状态

### 3. 锁定读没有进入写组

可能原因：

- SQL 书写形式未命中当前正则
- 语句前存在注释、换行或大小写差异

处理建议：

- 保持 SQL 风格稳定
- 必要时扩展 `mysql_query_rules` 的匹配规则
- 变更后重新验证 `SELECT ... FOR UPDATE` 路由结果

### 4. 管理端口可连通但业务端口不可用

排查方式：

- 检查 `6033` 的 Service 暴露是否正确
- 检查就绪探针是否持续失败
- 检查后端 MySQL 是否至少存在可用写组节点

## 安全与运维建议

- 文中凭据均为占位符；生产环境应通过受控 Secret 或专用配置管理方式注入
- `root` 账号不建议作为业务流量接入账号，保留最小权限业务账号即可
- `admin` 管理端口应限制访问范围，避免暴露到不受控网络
- 变更 `mysql_query_rules`、`mysql_servers` 或 `mysql_users` 后，应先灰度验证，再切换业务流量

## 推荐执行顺序

1. 准备命名空间、存储类和后端 MySQL 主从环境
2. 应用 `proxysql.yaml`
3. 进入 Pod 连接 `6032` 管理端口检查配置加载
4. 通过集群内域名或临时 NodePort 执行读写验证
5. 确认规则生效后，再通过 `LoadBalancer` 提供正式接入地址

## 参考资料

- [ProxySQL First Steps](https://proxysql.com/documentation/getting-started/)
