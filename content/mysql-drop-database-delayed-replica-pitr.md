# MySQL 误删库恢复：延迟复制与 Binlog 实战

> 本文以 MySQL 8.0.36 环境为例。文中的主机名、库名、GTID、Binlog 文件和位置均为示例。误操作恢复属于高风险变更，生产环境必须先冻结写入、保护原始证据，并在隔离实例完成恢复和校验后再切换业务。

本文复盘一次 `DROP DATABASE` 误操作。恢复依赖 6 小时延迟副本和 Binlog，但关键并不是“直接从延迟副本导出”：延迟副本被暂停时通常还落后数小时，必须继续应用复制事件，并精确停在危险事务之前。

## 事故摘要

| 项目 | 内容 |
| --- | --- |
| 故障级别 | P1，核心业务数据库不可用 |
| 数据库版本 | MySQL 8.0.36 |
| 复制方式 | GTID、ROW Binlog、一主多从 |
| 保护措施 | 独立 6 小时延迟副本 |
| 恢复目标 | 恢复到误删事务执行前 |
| 最终 RPO | 经业务核对，恢复点前事务完整 |

## 架构与基础配置

```text
                         业务应用
                            |
                  mysql-primary.example.internal
                            |
             +--------------+--------------+
             |                             |
       普通业务副本                    延迟副本
                                    mysql-delay.example.internal
                                      SOURCE_DELAY=21600
```

关键配置：

```ini
server_id=101
log_bin=binlog
binlog_format=ROW
gtid_mode=ON
enforce_gtid_consistency=ON
```

延迟副本配置为延后 21600 秒执行源端事务：

```sql
STOP REPLICA SQL_THREAD;
CHANGE REPLICATION SOURCE TO SOURCE_DELAY = 21600;
START REPLICA SQL_THREAD;
```

`SOURCE_DELAY` 从 MySQL 8.0.23 开始使用；MySQL 8.0.22 及更早版本使用旧的 `MASTER_DELAY` 语法。

延迟副本还应满足：

- 不承载业务查询，不对应用开放连接。
- 启用 `read_only=ON` 和 `super_read_only=ON`。
- Binlog 保留期大于“复制延迟 + 最长发现时间 + 恢复时间”。
- 独立监控接收线程、应用线程、磁盘空间和剩余延迟。
- 定期演练停止点恢复，而不是只确认复制线程为 `Yes`。

## 故障时间线

### 10:35:21：误删生产库

维护人员原计划操作测试环境，因连接目标选择错误，在生产实例执行：

```sql
DROP DATABASE example_app;
```

应用很快出现表不存在和 HTTP 500 错误。

### 10:40：监控报警

数据库进程仍正常，CPU、内存和磁盘也没有明显异常，但目标库已经不存在。普通副本快速应用了相同 DDL，因此不能作为误操作前的数据源。

### 10:42：冻结延迟副本

第一优先级是停止延迟副本的应用线程：

```sql
STOP REPLICA SQL_THREAD;
SHOW REPLICA STATUS\G
```

重点记录：

```text
Replica_IO_Running
Replica_SQL_Running
SQL_Delay
SQL_Remaining_Delay
Relay_Source_Log_File
Exec_Source_Log_Pos
Retrieved_Gtid_Set
Executed_Gtid_Set
```

确认 `Replica_SQL_Running: No` 后，再停止接收线程，完整冻结复制状态：

```sql
STOP REPLICA IO_THREAD;
```

`STOP REPLICA` 和 `SHOW REPLICA STATUS` 是非阻塞组合，不能只看到命令返回就假设线程已经完全停止；需要再次检查线程状态。

### 10:45：业务止写与证据保护

执行以下动作：

1. 从入口层摘除写流量，暂停定时任务和消息消费者。
2. 禁止在原主库重新创建同名库或尝试手工补数据。
3. 保存主库与延迟副本的 `SHOW REPLICA STATUS\G`、GTID 集合和 Binlog 列表。
4. 对延迟副本创建存储快照或物理副本，后续操作只在隔离副本进行。
5. 保留原始 Binlog，不执行 `PURGE BINARY LOGS`、`RESET MASTER` 或 `RESET REPLICA`。

## 关键认知：延迟副本不是事故前一刻

事故在 10:35 发生，延迟副本在 10:42 被暂停，并配置了 6 小时延迟。它的数据状态大约位于 04:42，而不是 10:35。

真实停止点必须以复制状态中的 `Executed_Gtid_Set`、`Relay_Source_Log_File` 和 `Exec_Source_Log_Pos` 为准。直接在此时导出，会丢失凌晨至事故前数小时的正常事务。

正确恢复链路是：

```text
延迟副本当前执行点
        |
        | 继续应用 Relay Log / Binlog
        v
误删事务之前的精确停止点
        |
        | 一致性导出或切换
        v
隔离恢复实例
```

## 定位危险事务

### 先按时间缩小范围

时间参数只用于帮助查找，不直接作为最终恢复边界：

```bash
mysqlbinlog \
  --base64-output=DECODE-ROWS \
  -vv \
  --start-datetime="<INCIDENT_DATE> <WINDOW_START_TIME>" \
  --stop-datetime="<INCIDENT_DATE> <WINDOW_END_TIME>" \
  /var/lib/mysql/binlog.000125 \
  | less
```

在输出中寻找：

```text
SET @@SESSION.GTID_NEXT='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee:4567'
DROP DATABASE example_app
```

记录以下信息：

```text
BAD_GTID=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee:4567
BAD_EVENT_START_POS=678900
BAD_EVENT_END_POS=679120
BAD_BINLOG=binlog.000125
```

真实值必须从 Binlog 输出确认，不能照抄示例。

### 为什么最终使用 GTID 或事件位置

数据库服务器、日志主机和操作终端可能存在时钟偏差。MySQL 官方建议时间参数用于定位，真正回放时优先使用事件位置。GTID 复制环境还可以使用 `SQL_BEFORE_GTIDS`，让应用线程在遇到危险事务前停止，并且不执行该事务。

## 推荐恢复路径：隔离延迟副本停在坏 GTID 前

以下命令只应在延迟副本的快照克隆或隔离副本执行。

### 确认 Relay Log 已包含危险 GTID

如果接收线程尚未取到对应事务，可只启动接收线程，不启动应用线程：

```sql
START REPLICA IO_THREAD;
SHOW REPLICA STATUS\G
```

确认 `Retrieved_Gtid_Set` 已包含 `BAD_GTID` 后立即停止接收线程：

```sql
STOP REPLICA IO_THREAD;
```

### 应用到危险事务之前

```sql
START REPLICA SQL_THREAD
  UNTIL SQL_BEFORE_GTIDS = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee:4567';
```

持续检查：

```sql
SHOW REPLICA STATUS\G
```

预期结果：

- `Replica_SQL_Running: No`。
- `Last_SQL_Errno: 0`，且没有新的应用线程错误。
- `Executed_Gtid_Set` 不包含 `BAD_GTID`。
- `example_app` 存在，关键表和数据时间接近 10:35:21。

`UNTIL` 条件在线程停止后可能不再保留在状态输出中，因此不要只依赖 `Until_Condition` 判断是否成功；应同时核对危险 GTID、复制错误和业务数据时间点。

检查库和核心表：

```sql
SHOW DATABASES LIKE 'example_app';
USE example_app;
SHOW TABLES;
SELECT COUNT(*) FROM critical_table;
SELECT MAX(updated_at) FROM critical_table;
```

不要在确认停止点之前执行无条件 `START REPLICA`。否则延迟副本会继续应用 `DROP DATABASE`，唯一的保护窗口将被关闭。

## 导出误删前的完整数据

在隔离恢复副本确认一致性后导出：

```bash
mysqldump \
  --user=<BACKUP_USER> \
  --password \
  --single-transaction \
  --routines \
  --events \
  --triggers \
  --hex-blob \
  --set-gtid-purged=OFF \
  --databases example_app \
  > example_app_before_drop.sql
```

计算校验值并限制文件权限：

```bash
chmod 600 example_app_before_drop.sql
sha256sum example_app_before_drop.sql \
  > example_app_before_drop.sql.sha256
```

不要在命令行直接填写密码，避免进入 Shell 历史和进程列表。恢复文件应放在受控目录，使用完成后按数据保留策略清理。

## 备用路径：全量备份加 Binlog PITR

如果延迟副本不可用，可在隔离实例恢复最近一次全量备份，再从备份记录的 Binlog 坐标逐文件回放到危险事件开始位置。

用于实际回放的输出不要带 `--base64-output=DECODE-ROWS -vv`。这些选项适合阅读 ROW 事件；执行时应保留 `mysqlbinlog` 产生的 `BINLOG` 语句。

示例：

```bash
# 第一个文件：从备份坐标开始
mysqlbinlog \
  --start-position=123456 \
  /recovery/binlog.000123 \
  | mysql --binary-mode=1 --user=<RECOVERY_USER> --password

# 中间文件：完整应用
mysqlbinlog \
  /recovery/binlog.000124 \
  | mysql --binary-mode=1 --user=<RECOVERY_USER> --password

# 最后一个文件：在 DROP 事件开始位置之前停止
mysqlbinlog \
  --stop-position=678900 \
  /recovery/binlog.000125 \
  | mysql --binary-mode=1 --user=<RECOVERY_USER> --password
```

必须保证：

- `123456` 是全量备份已经包含的最后位置之后的正确起点。
- `678900` 是危险事务的开始位置，而不是结束位置。
- Binlog 文件连续、无缺口，并按照文件顺序回放。
- 回放目标是隔离实例，不是仍在承载请求的生产主库。

## 恢复到生产环境

推荐在隔离实例完成验证后切换，而不是直接在原主库边恢复边开放写入。

### 恢复前验证

至少核对：

- Schema、表、视图、触发器、存储过程和事件是否完整。
- 核心表总行数、时间范围、金额汇总和业务状态分布。
- 关键外键或逻辑关联是否一致。
- 随机抽样订单、用户和流水是否可被应用正确读取。
- 应用使用的数据库账号权限是否仍正确。
- 危险 GTID 或 `DROP DATABASE` 没有进入恢复实例。

示例检查：

```sql
SELECT COUNT(*) FROM example_app.critical_table;
SELECT MIN(created_at), MAX(created_at)
FROM example_app.critical_table;

CHECKSUM TABLE example_app.critical_table;
```

大表执行 `CHECKSUM TABLE` 可能耗时并增加 I/O，生产环境应根据表规模选择抽样、分块校验或业务汇总对账。

### 切换步骤

1. 确认业务仍处于止写状态。
2. 对恢复实例执行最终业务验收。
3. 修改数据库入口，将业务指向恢复实例或受控恢复后的主库。
4. 小流量验证查询、写入、事务和消息消费。
5. 逐步恢复全部流量并持续观察错误率和数据指标。
6. 重建普通副本和新的延迟副本。

不要简单对原延迟副本执行 `START REPLICA` 后继续复用，因为它仍会遇到危险 GTID。事故恢复后应从新的可信主库重新建立复制链路。

## 本次恢复结果

恢复时间线：

| 时间 | 动作 |
| --- | --- |
| 10:35:21 | 误执行 `DROP DATABASE` |
| 10:40 | 业务监控报警 |
| 10:42 | 延迟副本停止应用线程 |
| 10:45 | 业务止写并保护 Binlog |
| 11:02 | 定位危险 GTID 与事件位置 |
| 11:18 | 隔离副本停在危险 GTID 前 |
| 11:35 | 完成一致性导出 |
| 12:20 | 完成恢复与业务校验 |
| 12:40 | 小流量验证后恢复业务 |

最终结果：

| 项目 | 结果 |
| --- | --- |
| 恢复点 | 误删事务执行前 |
| 误删事务 | 未在恢复实例执行 |
| 恢复点前数据 | GTID、行数及业务对账通过 |
| 业务恢复 | 完成 |
| 普通副本 | 从可信主库重新建立 |
| 延迟副本 | 重建并重新配置 6 小时延迟 |

“数据无丢失”必须以业务对账和恢复目标为准，不能只根据复制线程正常或 SQL 导入成功得出结论。

## 根因与改进

### 直接原因

维护人员选错数据库连接，并使用拥有 `DROP` 权限的账号执行危险 DDL。

### 管理原因

- 测试和生产连接标识不够醒目。
- 人员账号权限过大，没有按任务临时授权。
- 危险 DDL 缺少审批和双人复核。
- 恢复体系存在，但演练和操作手册不够精确。

### 改进措施

1. 应用账号仅保留业务必需的 `SELECT`、`INSERT`、`UPDATE`、`DELETE` 等权限，不授予 `DROP`。
2. 人员操作使用独立实名账号，通过堡垒机、工单和限时授权进入生产。
3. `DROP`、`TRUNCATE`、无条件大范围 `DELETE/UPDATE` 必须经过审核。
4. 延迟副本与业务网络隔离，避免被普通连接误用。
5. Binlog 保留周期覆盖最坏发现和恢复窗口，并持续备份到独立存储。
6. 定期执行“备份恢复 + Binlog PITR + 延迟副本停止点”联合演练。
7. 恢复手册中明确记录 GTID、文件位置、停止边界和回滚入口。

## 结论

普通复制解决的是副本和可用性问题，无法阻止错误 SQL 被同步放大。延迟副本提供了时间缓冲，但它只是恢复链路的起点；真正可靠的恢复依赖精确停止点、连续 Binlog、隔离恢复、业务对账和可验证的切换流程。

## 参考资料

- [MySQL 8.0.36 发布说明](https://dev.mysql.com/doc/relnotes/mysql/8.0/en/news-8-0-36.html)
- [MySQL 8.0：延迟复制](https://dev.mysql.com/doc/refman/8.0/en/replication-delayed.html)
- [MySQL 8.0：START REPLICA 与 SQL_BEFORE_GTIDS](https://dev.mysql.com/doc/refman/8.0/en/start-replica.html)
- [MySQL 8.0：基于事件位置的时间点恢复](https://dev.mysql.com/doc/refman/8.0/en/point-in-time-recovery-positions.html)
- [MySQL 8.0：mysqlbinlog 工具](https://dev.mysql.com/doc/refman/8.0/en/mysqlbinlog.html)
