# ProxySQL + MySQL 读写分离与安全故障切换实战

> 本文整理自实际 ProxySQL + MySQL 主从环境。主机名、地址、账号、密码和容量参数均已替换为示例值。主库提升、`RESET REPLICA ALL`、`OFFLINE_HARD` 和全局只读切换都属于高风险操作，执行前必须确认数据一致性、旧主库隔离状态、回退路径和维护授权。

ProxySQL 可以为 MySQL 提供统一入口、连接池、查询路由、后端健康检查和运行统计，但它不会替代 MySQL 复制，也不会自动保证主库提升时的数据一致性。真正可靠的故障切换需要把数据层选主、旧主库隔离、ProxySQL 路由更新和业务验证作为一条完整链路。

本文使用以下逻辑角色：

```text
应用程序
   │
   ▼
ProxySQL :6033
   │
   ├── 写入、锁定读、事务流量 ──> Hostgroup 10 ──> Writer
   │
   └── 普通只读查询 ───────────> Hostgroup 20 ──> Readers
```

## 两种接入模式

### 只代理读流量

应用继续直连主库写入，只把只读查询发送到 ProxySQL。优点是改造范围小，缺点是应用需要维护两套数据源，主库切换时也要分别处理写入口和读入口。

### 统一数据库入口

应用的读写连接都指向 ProxySQL，由业务账号的 `default_hostgroup` 和查询规则决定流量去向。这种模式更利于统一切换和观测，但必须认真处理事务、锁定读、读后写一致性以及 ProxySQL 自身的高可用。

本文主要采用统一入口模式。

## 先明确能力边界

在生产环境落地前，需要接受以下事实：

- ProxySQL 根据规则路由 SQL，不理解完整业务语义。
- 普通异步复制存在延迟，从 Reader 读取的数据可能落后于 Writer。
- `read_only` 能帮助识别角色，但不能代替共识选主或防脑裂机制。
- 单台 ProxySQL 本身是入口单点，应至少部署两个实例并提供受控的客户端切换方式。
- 正则规则无法覆盖所有复杂 SQL、存储过程、多语句和框架改写场景，必须结合真实 Query Digest 验证。

对强一致读、写后立即读、账务和库存等场景，应显式走 Writer，不能仅依赖“所有 SELECT 都去从库”的简单规则。

## 示例规划

| 组件 | 示例地址 | 用途 |
| --- | --- | --- |
| ProxySQL Admin | `127.0.0.1:6032` | 仅本机管理接口 |
| ProxySQL Data | `proxysql.example.com:6033` | 业务统一入口 |
| MySQL Writer | `mysql-primary.example.com:3306` | Hostgroup 10 |
| MySQL Reader 1 | `mysql-replica-1.example.com:3306` | Hostgroup 20 |
| MySQL Reader 2 | `mysql-replica-2.example.com:3306` | Hostgroup 20 |
| Metrics | `127.0.0.1:6070/metrics` | Prometheus 指标 |

示例约定：

```text
Writer Hostgroup = 10
Reader Hostgroup = 20
```

域名均属于示例，不对应真实环境。生产部署应使用内部 DNS，并限制 Admin 和 Metrics 端口的访问范围。

## 安装与基线检查

通过 ProxySQL 官方仓库安装经过验证的版本，不要长期固定到一份无人维护的旧 RPM：

```bash
dnf install proxysql
systemctl enable --now proxysql
systemctl status proxysql --no-pager
proxysql --version
```

升级前应在预发布环境验证 MySQL 版本、认证插件、查询规则和配置表结构。不同 ProxySQL 版本的字段与默认值可能变化，操作前应以当前版本的官方文档和实际表结构为准：

```sql
SHOW CREATE TABLE mysql_users\G
SHOW CREATE TABLE mysql_servers\G
SHOW CREATE TABLE mysql_replication_hostgroups\G
SHOW CREATE TABLE mysql_query_rules\G
```

## 理解 MEMORY、RUNTIME 与 DISK

ProxySQL 配置包含三层：

```text
MEMORY  -> Admin 数据库中正在编辑的配置
RUNTIME -> 当前生效的运行配置
DISK    -> 重启后加载的持久化配置
```

常规变更步骤为：

```text
修改 MEMORY
    ↓
LOAD 对应模块 TO RUNTIME
    ↓
验证运行结果
    ↓
SAVE 对应模块 TO DISK
```

例如修改后端节点：

```sql
LOAD MYSQL SERVERS TO RUNTIME;
SAVE MYSQL SERVERS TO DISK;
```

只修改 MEMORY 不会立即生效；只 `LOAD` 不 `SAVE`，重启后可能恢复旧配置。高风险切换时可先 `LOAD` 验证，确认正确后再 `SAVE`，避免把错误永久化。

## 安全登录 Admin 接口

不要在命令行中使用 `-p明文密码`，它可能进入 Shell 历史或进程参数。使用交互式提示：

```bash
mysql -u admin -p -h 127.0.0.1 -P 6032
```

首次部署应立即替换默认管理凭据，并确保 Admin 端口只监听或只允许受控管理网络访问：

```sql
UPDATE global_variables
SET variable_value='admin:REPLACE_WITH_STRONG_ADMIN_PASSWORD'
WHERE variable_name='admin-admin_credentials';

LOAD ADMIN VARIABLES TO RUNTIME;
SAVE ADMIN VARIABLES TO DISK;
```

配置落盘后再次通过密码提示登录验证。公开文档、工单和仓库中不要保存真实凭据。

## 配置最小权限监控账号

ProxySQL Monitor 使用独立账号连接、Ping 并检查 `read_only`。普通主从复制场景中，官方文档说明连接、Ping 和 `read_only` 检查只需要 `USAGE`；如果还要监控复制延迟，再授予 `REPLICATION CLIENT`。

在 Writer 和所有 Reader 上创建同名账号：

```sql
CREATE USER 'proxysql_monitor'@'REPLACE_WITH_PROXYSQL_SOURCE'
IDENTIFIED BY 'REPLACE_WITH_MONITOR_PASSWORD';

GRANT USAGE ON *.*
TO 'proxysql_monitor'@'REPLACE_WITH_PROXYSQL_SOURCE';

GRANT REPLICATION CLIENT ON *.*
TO 'proxysql_monitor'@'REPLACE_WITH_PROXYSQL_SOURCE';
```

不要无条件授予 `PROCESS` 或全库 `SELECT`。账号来源应限制为 ProxySQL 节点或专用网段，并与业务账号分离。

在 ProxySQL 中配置：

```sql
SET mysql-monitor_username='proxysql_monitor';
SET mysql-monitor_password='REPLACE_WITH_MONITOR_PASSWORD';
SET mysql-monitor_enabled='true';

LOAD MYSQL VARIABLES TO RUNTIME;
SAVE MYSQL VARIABLES TO DISK;
```

确认监控连接正常：

```sql
SELECT hostname, port, time_start_us, connect_success_time_us, connect_error
FROM monitor.mysql_server_connect_log
ORDER BY time_start_us DESC
LIMIT 10;

SELECT hostname, port, time_start_us, ping_success_time_us, ping_error
FROM monitor.mysql_server_ping_log
ORDER BY time_start_us DESC
LIMIT 10;
```

## 校验 MySQL 主从角色

Writer 应为可写：

```sql
SELECT @@global.read_only, @@global.super_read_only;
```

预期：

```text
read_only       = 0
super_read_only = 0
```

Reader 应保持只读：

```text
read_only       = 1
super_read_only = 1
```

同时检查复制线程、GTID 和延迟：

```sql
SHOW REPLICA STATUS\G
SELECT @@global.gtid_executed;
```

`read_only` 状态错误可能让 ProxySQL 把节点放进错误的 Hostgroup。它只是一项角色信号，不能证明节点数据最新或适合被提升。

## 添加后端节点

先添加 Writer：

```sql
INSERT INTO mysql_servers
  (hostgroup_id, hostname, port, status, weight, max_connections, max_replication_lag)
VALUES
  (10, 'mysql-primary.example.com', 3306, 'ONLINE', 100, 500, 0);
```

再添加 Readers：

```sql
INSERT INTO mysql_servers
  (hostgroup_id, hostname, port, status, weight, max_connections, max_replication_lag)
VALUES
  (20, 'mysql-replica-1.example.com', 3306, 'ONLINE', 100, 300, 30),
  (20, 'mysql-replica-2.example.com', 3306, 'ONLINE', 100, 300, 30);

LOAD MYSQL SERVERS TO RUNTIME;
```

这里的 `weight`、`max_connections` 和 `max_replication_lag` 只是便于说明字段的示例，不应直接复制到生产。实际值需要结合 MySQL `max_connections`、连接池规模、ProxySQL 实例数量、复制延迟目标和压测结果确定。

验证运行配置：

```sql
SELECT hostgroup_id, hostname, port, status, weight, max_connections, max_replication_lag
FROM runtime_mysql_servers
ORDER BY hostgroup_id, hostname, port;
```

确认无误后持久化：

```sql
SAVE MYSQL SERVERS TO DISK;
```

## 配置 Writer / Reader 自动识别

使用 `mysql_replication_hostgroups` 建立角色映射：

```sql
INSERT INTO mysql_replication_hostgroups
  (writer_hostgroup, reader_hostgroup, comment)
VALUES
  (10, 20, 'async replication read-write split');

SET mysql-monitor_writer_is_also_reader='false';

LOAD MYSQL SERVERS TO RUNTIME;
LOAD MYSQL VARIABLES TO RUNTIME;
SAVE MYSQL SERVERS TO DISK;
SAVE MYSQL VARIABLES TO DISK;
```

核心逻辑：

```text
read_only = 0 -> Writer HG10
read_only = 1 -> Reader HG20
```

显式关闭 `mysql-monitor_writer_is_also_reader`，可避免 Writer 被自动复制到 Reader Hostgroup。若确实需要 Writer 同时承担读流量，应在容量和一致性评估后有意识地开启，而不是依赖默认值。

查看角色检测记录：

```sql
SELECT hostname, port, time_start_us, success_time_us, read_only, error
FROM monitor.mysql_server_read_only_log
ORDER BY time_start_us DESC
LIMIT 10;
```

## 配置业务账号与事务保持

业务账号默认路由到 Writer，普通只读查询再由规则分流：

```sql
INSERT INTO mysql_users
  (username, password, default_hostgroup, active, transaction_persistent, max_connections)
VALUES
  ('app_user', 'REPLACE_WITH_BUSINESS_PASSWORD', 10, 1, 1, 500);

LOAD MYSQL USERS TO RUNTIME;
SAVE MYSQL USERS TO DISK;
```

`transaction_persistent=1` 很重要：事务一旦在某个 Hostgroup 开始，后续语句应保持在同一 Hostgroup，避免事务中的普通 `SELECT` 被规则切到 Reader。具体默认值和行为仍应以当前版本表结构为准，并通过真实事务验证。

ProxySQL 中配置的业务账号必须与后端 MySQL 账号及认证方式兼容。不要把账号密码写入应用镜像或公开配置，应使用受控 Secret 或凭据管理系统。

## 配置查询规则

推荐把更具体的锁定读放在普通 `SELECT` 前：

```sql
INSERT INTO mysql_query_rules
  (rule_id, active, match_digest, destination_hostgroup, apply, comment)
VALUES
  (10, 1, '^SELECT.*FOR UPDATE',          10, 1, 'locking read to writer'),
  (11, 1, '^SELECT.*FOR SHARE',           10, 1, 'locking read to writer'),
  (12, 1, '^SELECT.*LOCK IN SHARE MODE',  10, 1, 'legacy locking read to writer'),
  (19, 0, '^SELECT.*',                    10, 1, 'emergency reads to writer'),
  (20, 1, '^SELECT.*',                    20, 1, 'normal reads to replicas');

LOAD MYSQL QUERY RULES TO RUNTIME;
```

未命中读规则的语句会回到业务账号的 `default_hostgroup=10`，因此不需要额外添加匹配所有 SQL 的宽泛兜底正则。

验证规则顺序：

```sql
SELECT rule_id, active, match_digest, destination_hostgroup, apply, comment
FROM runtime_mysql_query_rules
ORDER BY rule_id;
```

### 正则路由的限制

以下场景必须单独验证：

- SQL 前置注释、公共表表达式和框架生成语句。
- 显式事务与自动提交关闭的连接。
- 存储过程、函数和多语句请求。
- 写后立即读和必须读取最新数据的业务。
- `SELECT` 中包含用户变量、副作用或特殊锁语义。

不要仅凭规则表“看起来正确”就上线。先在灰度账号或预发布流量中观察 Query Digest，再逐步扩大范围。

确认路由符合预期后持久化：

```sql
SAVE MYSQL QUERY RULES TO DISK;
```

## 验证读写分离

连接时使用密码提示，避免明文密码出现在命令行：

```bash
mysql -u app_user -p -h proxysql.example.com -P 6033
```

普通读查询：

```sql
SELECT @@hostname, @@server_id, @@server_uuid, @@port, @@read_only;
```

多执行几次，观察是否分发到健康 Reader。然后在专用测试库创建验证表：

```sql
CREATE TABLE proxysql_route_test (
    id BIGINT PRIMARY KEY,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ON UPDATE CURRENT_TIMESTAMP
);

INSERT INTO proxysql_route_test(id)
VALUES (1)
ON DUPLICATE KEY UPDATE updated_at=CURRENT_TIMESTAMP;

SELECT @@hostname, @@server_id, @@read_only;
```

写操作应进入 Writer。锁定读测试：

```sql
START TRANSACTION;
SELECT * FROM proxysql_route_test WHERE id=1 FOR UPDATE;
SELECT @@hostname, @@server_id, @@read_only;
COMMIT;
```

锁定读应显示 `@@read_only=0`。此外还要验证一个包含多条读写语句的完整事务，确认始终停留在 Writer。

查看实际命中统计：

```sql
SELECT rule_id, hits
FROM stats_mysql_query_rules
ORDER BY rule_id;

SELECT hostgroup, count_star, digest_text
FROM stats_mysql_query_digest
ORDER BY count_star DESC
LIMIT 20;
```

## 日常运维检查

后端运行状态：

```sql
SELECT hostgroup_id, hostname, port, status
FROM runtime_mysql_servers
ORDER BY hostgroup_id, hostname, port;
```

连接池状态：

```sql
SELECT hostgroup, srv_host, srv_port, status,
       ConnUsed, ConnFree, ConnOK, ConnERR, Queries
FROM stats_mysql_connection_pool
ORDER BY hostgroup, srv_host, srv_port;
```

配置三层对照：

```sql
SELECT hostgroup_id, hostname, port, status FROM mysql_servers;
SELECT hostgroup_id, hostname, port, status FROM runtime_mysql_servers;
SELECT hostgroup_id, hostname, port, status FROM disk.mysql_servers;
```

不要只看 `runtime_mysql_servers` 中的 `ONLINE`。还应结合连接错误、Ping、`read_only`、复制延迟、GTID 和业务请求成功率判断健康状态。

## 安全摘除与恢复 Reader

计划维护 Reader 时，先使用 `OFFLINE_SOFT` 停止接收新连接，让已有连接逐步释放：

```sql
UPDATE mysql_servers
SET status='OFFLINE_SOFT'
WHERE hostgroup_id=20
  AND hostname='mysql-replica-2.example.com'
  AND port=3306;

LOAD MYSQL SERVERS TO RUNTIME;
```

观察连接池：

```sql
SELECT hostgroup, srv_host, srv_port, status, ConnUsed, ConnFree
FROM stats_mysql_connection_pool
WHERE srv_host='mysql-replica-2.example.com'
  AND srv_port=3306;
```

维护完成后，先在 MySQL 层验证复制线程、GTID、延迟和只读状态，再恢复：

```sql
UPDATE mysql_servers
SET status='ONLINE'
WHERE hostgroup_id=20
  AND hostname='mysql-replica-2.example.com'
  AND port=3306;

LOAD MYSQL SERVERS TO RUNTIME;
SAVE MYSQL SERVERS TO DISK;
```

非紧急场景不要直接删除节点，也不要优先使用会立即中断连接的 `OFFLINE_HARD`。

## 所有 Readers 故障时临时读主

先确认 Writer 的 CPU、连接数、磁盘 I/O 和复制状态能够承受额外读流量，再启用预置的应急规则：

```sql
UPDATE mysql_query_rules
SET active=1
WHERE rule_id=19;

LOAD MYSQL QUERY RULES TO RUNTIME;
```

验证读请求已经进入 HG10、错误率下降且主库资源可控后，再决定是否持久化。Readers 恢复并追平后关闭规则：

```sql
UPDATE mysql_query_rules
SET active=0
WHERE rule_id=19;

LOAD MYSQL QUERY RULES TO RUNTIME;
SAVE MYSQL QUERY RULES TO DISK;
```

应急读主会牺牲主库余量，不能成为长期运行方式。

## 主库故障切换：先防脑裂，再提升

### 1. 宣布切换并冻结变更

暂停自动化操作，记录故障时间、当前 Writer、所有候选 Reader、ProxySQL 配置快照和业务影响。明确 RTO、允许的数据丢失边界以及切换负责人。

### 2. 隔离旧 Writer

在提升任何 Reader 之前，必须确认旧 Writer 无法继续接受写入。可根据环境使用网络隔离、关闭数据库监听、撤销业务路由、存储隔离或主机级 fencing。

同时从 ProxySQL 运行配置中硬下线旧 Writer：

```sql
UPDATE mysql_servers
SET status='OFFLINE_HARD'
WHERE hostgroup_id=10
  AND hostname='mysql-primary.example.com'
  AND port=3306;

LOAD MYSQL SERVERS TO RUNTIME;
```

`OFFLINE_HARD` 会立即中断相关后端连接，只适用于确认故障或脑裂风险的紧急场景。

### 3. 选择数据最新且健康的候选节点

在每个候选 Reader 上检查：

```sql
SHOW REPLICA STATUS\G
SELECT @@global.gtid_executed,
       @@global.read_only,
       @@global.super_read_only;
```

重点确认：

- 复制 I/O 与 SQL 线程状态及最后错误。
- `Retrieved_Gtid_Set`、`Executed_Gtid_Set` 和延迟。
- 候选节点是否缺少已确认提交的事务。
- 是否存在比它更新的其他 Reader。
- 数据库和底层存储是否健康。

仅凭 `Seconds_Behind_Source=0` 不足以证明数据完整或绝对最新。

### 4. 停止复制并提升新 Writer

记录原复制配置后，在选定节点执行：

```sql
STOP REPLICA;
SHOW REPLICA STATUS\G

SET GLOBAL super_read_only = OFF;
SET GLOBAL read_only = OFF;
```

不要一开始就执行 `RESET REPLICA ALL`。它会清除连接参数和复制元数据，不利于回溯。只有在拓扑已经记录、切换确认完成且确实需要清理旧复制配置时，才执行：

```sql
RESET REPLICA ALL;
```

ProxySQL Monitor 检测到 `read_only=0` 后，应将新节点放入 Writer Hostgroup。也可以在维护窗口中显式更新，但必须检查最终运行状态：

```sql
SELECT hostgroup_id, hostname, port, status
FROM runtime_mysql_servers
ORDER BY hostgroup_id, hostname, port;
```

### 5. 先做最小业务验证

在恢复全部流量前完成：

- 新连接和认证测试。
- 受控写入、读取和事务提交测试。
- GTID、错误日志和数据库只读状态核对。
- ProxySQL Query Rule、连接池与错误率检查。
- 关键业务数据抽查。

确认后逐步恢复流量，并持续观察连接、延迟、锁等待和磁盘 I/O。

### 6. 重建其他 Readers

在其他节点上重新配置复制源：

```sql
STOP REPLICA;

CHANGE REPLICATION SOURCE TO
    SOURCE_HOST='mysql-primary-new.example.com',
    SOURCE_PORT=3306,
    SOURCE_USER='repl_user',
    SOURCE_PASSWORD='REPLACE_WITH_REPLICATION_PASSWORD',
    SOURCE_AUTO_POSITION=1;

START REPLICA;
SHOW REPLICA STATUS\G
```

`CHANGE REPLICATION SOURCE TO` 的凭据可能进入终端记录、审计日志或自动化输出，应在受控会话中使用专用复制账号，并及时清理不必要的明文记录。

### 7. 旧 Writer 不得直接重新上线

旧 Writer 恢复连接后仍可能带着旧时间线或未复制事务。保持它与业务隔离并开启 `super_read_only`，完成数据差异评估；通常应将它重建为新 Writer 的 Reader，追平并验证后再加入 Hostgroup。

## 临时阻断写入

ProxySQL 可添加高优先级错误规则作为维护期的第一层防护：

```sql
INSERT INTO mysql_query_rules
  (rule_id, active, match_digest, error_msg, apply, comment)
VALUES
  (5, 1,
   '^(INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP|TRUNCATE|RENAME|GRANT|REVOKE|CALL|LOAD).*',
   '数据库维护中，暂时禁止写入',
   1,
   'temporary maintenance guard');

LOAD MYSQL QUERY RULES TO RUNTIME;
```

但正则无法可靠覆盖所有写入方式，例如存储过程内部写入、带注释或 CTE 的语句及特殊协议行为。需要数据库级强制只读时，应在确认影响后设置：

```sql
SET GLOBAL super_read_only = ON;
SET GLOBAL read_only = ON;
```

恢复写入前再次核对当前节点确实是唯一 Writer：

```sql
SET GLOBAL read_only = OFF;
SET GLOBAL super_read_only = OFF;
```

ProxySQL 规则和 MySQL 全局只读都应准备显式回滚命令，并在维护结束后及时恢复。

## 健康检测与容量参数

监控周期示例：

```sql
SET mysql-monitor_connect_interval=15000;
SET mysql-monitor_ping_interval=10000;
SET mysql-monitor_read_only_interval=10000;
SET mysql-monitor_replication_lag_interval=10000;

LOAD MYSQL VARIABLES TO RUNTIME;
SAVE MYSQL VARIABLES TO DISK;
```

这些数值不是通用最佳实践。周期越短，故障发现越快，但监控连接和后端开销也更高。还需要结合 timeout、连续失败次数、网络抖动和业务 RTO 共同设置，避免一次瞬时超时就触发错误判断。

连接数和线程数也不能照抄现场值。至少满足：

```text
所有 ProxySQL 实例可能建立的后端连接总量
    < MySQL 可用连接上限
    < MySQL max_connections 并保留管理余量
```

调整前使用压测和运行统计验证，避免把 ProxySQL 前端的大连接上限直接等同于后端承载能力。

## Prometheus 指标

ProxySQL 内置 Prometheus Exporter，可通过 Admin REST API 暴露：

```sql
SET admin-restapi_enabled='true';
SET admin-restapi_port='6070';
SET admin-prometheus_memory_metrics_interval='60';

LOAD ADMIN VARIABLES TO RUNTIME;
SAVE ADMIN VARIABLES TO DISK;
```

本机验证：

```bash
curl --fail --silent --show-error http://127.0.0.1:6070/metrics | head
```

Metrics 端点可能暴露后端、查询和运行状态信息。生产环境应通过主机防火墙、专用监控网或反向代理限制来源，不要直接暴露到公网。

## ProxySQL 自身高可用

至少部署两个 ProxySQL 实例，并确保：

- 应用具备多个入口、VIP、负载均衡或明确的连接切换机制。
- 两个实例的 `mysql_servers`、`mysql_users` 和 `mysql_query_rules` 一致。
- 每个实例都独立验证 RUNTIME 与 DISK。
- 切换脚本对所有 ProxySQL 实例执行并检查结果，避免一半实例仍指向旧 Writer。
- 定期演练单个 ProxySQL 实例故障和配置漂移。

ProxySQL Cluster 可以帮助同步部分配置，但不能替代变更审计、数据层选主和脑裂保护。

## 变更与回滚清单

每次上线或故障切换至少记录：

- 变更前的 MEMORY、RUNTIME、DISK 配置快照。
- Writer / Reader 的 `read_only`、GTID、复制线程和延迟。
- Query Rule 命中数和连接池状态。
- 变更执行顺序、执行人和时间点。
- 每一步对应的回滚 SQL。
- 应用连接、读写事务和关键数据验证结果。

高风险变更建议先 `LOAD` 到 RUNTIME 验证，再决定是否 `SAVE` 到 DISK。若运行结果不符合预期，可以从已确认的配置快照恢复 MEMORY，再重新 `LOAD`。

## 关键结论

1. 业务账号默认 Hostgroup 应指向 Writer，普通只读查询再分流。
2. 锁定读、强一致读和事务不能简单发送到 Reader。
3. `transaction_persistent=1` 是统一入口模式的重要保护项。
4. Monitor 账号只授予所需权限，业务、监控和管理凭据必须分离。
5. 容量、权重、延迟阈值和检测周期必须经过测量，不能照抄示例。
6. Reader 维护优先使用 `OFFLINE_SOFT`，紧急隔离才使用 `OFFLINE_HARD`。
7. 主库切换第一步是隔离旧 Writer，随后才是选择并提升最新 Reader。
8. `RESET REPLICA ALL` 会删除复制配置，不应作为故障切换的第一条命令。
9. ProxySQL 的正则禁写只能作为辅助，严格维护锁应结合 MySQL 层控制。
10. 两个以上 ProxySQL 入口、配置一致性和定期演练同样属于整体高可用设计。

## 参考资料

- [ProxySQL：首次配置指南](https://proxysql.com/documentation/proxysql-configuration/)
- [ProxySQL：用户与 transaction_persistent 配置](https://proxysql.com/documentation/users-configuration/)
- [ProxySQL：MySQL Monitor 模块](https://proxysql.com/documentation/backend-monitoring/)
- [ProxySQL：Monitor 全局变量](https://proxysql.com/documentation/global-variables/mysql-monitor-variables/)
- [ProxySQL：Prometheus Metrics](https://proxysql.com/documentation/prometheus-exporter/)
