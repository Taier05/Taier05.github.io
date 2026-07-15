# MySQL GTID 主从复制部署与故障处理手册

## 背景与目标

本文用于规范 MySQL 主从复制的部署、初始化、故障修复与链式复制操作，覆盖以下场景：

- 新建主从复制关系
- 使用 GTID 模式进行自动定位复制
- 兼容传统 `File/Position` 模式
- 从库按库表过滤复制
- 主从异常修复与事务跳过
- 主从链式复制

推荐优先使用 GTID 模式。传统模式仅在历史环境、兼容性约束或排障需要时使用。

## 环境说明

- 适用对象：MySQL 主从复制环境
- 主库示例 `server-id=1`
- 从库示例 `server-id=2`
- 默认端口 `3306`
- 二进制日志格式 `ROW`
- 认证插件 `mysql_native_password`

说明：

- 文中同时保留 `MASTER/SLAVE` 与 `SOURCE/REPLICA` 两套命令表述。
- MySQL 8.0 建议优先使用 `SOURCE/REPLICA` 语法。
- 旧版本仍可使用 `MASTER/SLAVE` 语法。

## 推荐配置

以下配置基于现有可用配置整理，保留原有注释，并对高风险项按场景拆分说明。

### 主库配置

```conf
[mysqld]
server-id=1
log-bin=mysql-bin
binlog_format=ROW
gtid_mode=ON
enforce_gtid_consistency=ON

# Binlog 自动过期（7 天）
binlog_expire_logs_seconds=604800

# 基本配置
port=3306
socket=/tmp/mysql.sock
datadir=/var/lib/mysql

default_authentication_plugin=mysql_native_password
skip-external-locking

# 慢查询日志
slow_query_log=1
slow_query_log_file=/var/lib/mysql/mysql-slow.log
long_query_time=3

# InnoDB 配置
default_storage_engine=InnoDB
innodb_buffer_pool_size=32G
innodb_flush_method=O_DIRECT
innodb_io_capacity=2000
innodb_io_capacity_max=4000
innodb_flush_log_at_trx_commit=1
innodb_lock_wait_timeout=50
innodb_max_dirty_pages_pct=75
innodb_log_file_size=4096M
innodb_log_buffer_size=256M

innodb_read_io_threads = 64  # 读线程数 根据CPU核心数调整
innodb_write_io_threads = 64  # 写线程数 根据CPU核心数调整

max_connections=2000
max_connect_errors=100
open_files_limit=65535
max_allowed_packet=256M

tmp_table_size=128M
max_heap_table_size=128M
join_buffer_size=1M
sort_buffer_size=2M
read_buffer_size=1M
read_rnd_buffer_size=1M
thread_stack=512K

key_buffer_size=32M
myisam_sort_buffer_size=64M
thread_cache_size=256
table_open_cache=2048
table_definition_cache=400
performance_schema_max_table_instances=400

lower_case_table_names=1
sql_mode=NO_ENGINE_SUBSTITUTION,STRICT_TRANS_TABLES
explicit_defaults_for_timestamp=ON
```

### 从库配置

```conf
[mysqld]
server-id=2
log-bin=mysql-bin
binlog_format=ROW
gtid_mode=ON
enforce_gtid_consistency=ON
log_replica_updates=ON # 记录从服务器应用的更新到它自己的二进制日志中

# 从库只读保护（防误写）
read_only=ON
super_read_only=ON

# 崩溃恢复更稳（推荐补齐）
relay-log=relay-bin
relay_log_recovery=ON
master_info_repository=TABLE
relay_log_info_repository=TABLE

# Binlog 自动过期（7 天）
binlog_expire_logs_seconds=604800

# 基本配置
port = 3306
socket = /tmp/mysql.sock
datadir = /var/lib/mysql

default_authentication_plugin = mysql_native_password
skip-external-locking

# 慢查询日志
slow_query_log=1
slow-query-log-file=/var/lib/mysql/mysql-slow.log
long_query_time=3

# InnoDB 配置
default_storage_engine=InnoDB
innodb_buffer_pool_size=32G
innodb_flush_method=O_DIRECT
innodb_io_capacity=2000
innodb_io_capacity_max=4000
innodb_flush_log_at_trx_commit=1
innodb_lock_wait_timeout=50
innodb_max_dirty_pages_pct=75
innodb_log_file_size = 4096M
innodb_log_buffer_size = 256M

innodb_read_io_threads = 64  # 读线程数 根据CPU核心数调整
innodb_write_io_threads = 64  # 写线程数 根据CPU核心数调整

max_connections=2000
max_connect_errors=100
open_files_limit=65535
max_allowed_packet=256M

tmp_table_size=128M
max_heap_table_size=128M
join_buffer_size=1M
sort_buffer_size=2M
read_buffer_size=1M
read_rnd_buffer_size=1M
thread_stack=512K

key_buffer_size = 32M
myisam_sort_buffer_size=64M
thread_cache_size = 256
table_open_cache = 2048
table_definition_cache = 400
performance_schema_max_table_instances = 400

lower_case_table_names=1
sql_mode=NO_ENGINE_SUBSTITUTION,STRICT_TRANS_TABLES
explicit_defaults_for_timestamp=ON
```

### 按库表过滤复制场景

当从库只需要同步指定业务表时，可在从库额外增加以下配置：

```conf
# 只复制 tikbee.*（从库过滤）
replicate-wild-do-table=tikbee.%
```

适用场景：

- 只需要同步单个业务库或部分表
- 从库用于报表、查询分流、单业务备份

不适用场景：

- 需要完整实例级复制
- 存在跨库事务、跨库触发器、依赖系统库对象的场景

### 关于 `slave-skip-errors`

原始配置中存在以下项：

```conf
slave-skip-errors=1062
```

该参数不建议作为长期默认配置。更稳妥的做法是：

- 默认不写入常驻配置
- 仅在确认错误可安全跳过时临时启用
- 处理完成后恢复正常复制策略

原因：

- `1062` 表示唯一键重复，盲目常驻跳过可能掩盖数据不一致
- 对于业务强一致场景，应优先定位根因，而不是长期忽略错误

## 部署前准备

### 1. 修改配置并重启 MySQL

主从两侧完成配置修改后，必须重启 MySQL 使参数生效。

### 2. 主库创建复制账号

只需要创建一次：

```sql
CREATE USER 'replicator'@'<DB_CLIENT_SUBNET>' IDENTIFIED BY '<DB_PASSWORD>';
GRANT REPLICATION SLAVE ON *.* TO 'replicator'@'<DB_CLIENT_SUBNET>';
FLUSH PRIVILEGES;
```

建议：

- 实际环境应替换为强密码
- 授权网段应按实际复制网络收敛

### 3. 记录主库 Binlog 状态

传统模式需要记录主库当前位置：

```sql
SHOW MASTER STATUS;
```

示例：

```text
+------------------+----------+--------------+------------------+
| File             | Position | Binlog_Do_DB | Binlog_Ignore_DB |
+------------------+----------+--------------+------------------+
| mysql-bin.000001 |      154 |              |                  |
+------------------+----------+--------------+------------------+
```

需要记录：

- `File`
- `Position`

GTID 模式通常不依赖这两个值，但在排障或回退到传统模式时仍可能用到。

## 数据初始化

### 导出导入思路

初始建从前，需要先把主库当前数据导入从库。导出方式可根据环境选择：

- `mysqldump`
- `xtrabackup`

### 从库初始化步骤

```sql
STOP SLAVE;
RESET SLAVE ALL;
RESET MASTER;
SHOW DATABASES;
DROP DATABASE cstikbee; -- 删库(看情况)
SHOW DATABASES;
```

说明：

- 上述删库仅为示例，是否执行必须按实际情况判断
- `RESET MASTER` 会清空本地 binlog，执行前需确认该从库不是其他下游节点的上游
- MySQL 8.0 可使用 `STOP REPLICA; RESET REPLICA ALL;`

完成清理后，再将主库备份导入从库。

## 主从配置步骤

### 方案一：GTID 模式

推荐场景：

- 新建复制环境
- 需要自动定位事务位置
- 未来可能做切换、链式复制或故障恢复

从库执行：

```sql
CHANGE MASTER TO
  MASTER_HOST='主库IP地址',
  MASTER_USER='replicator',
  MASTER_PASSWORD='<DB_PASSWORD>',
  MASTER_PORT=3306,
  MASTER_AUTO_POSITION = 1;
START SLAVE;
SHOW SLAVE STATUS\G;
```

MySQL 8.0 新语法可写为：

```sql
CHANGE REPLICATION SOURCE TO
  SOURCE_HOST='主库IP地址',
  SOURCE_USER='replicator',
  SOURCE_PASSWORD='<DB_PASSWORD>',
  SOURCE_PORT=3306,
  SOURCE_AUTO_POSITION = 1;
START REPLICA;
SHOW REPLICA STATUS\G;
```

### 方案二：传统 File/Position 模式

适用场景：

- 历史环境未启用 GTID
- 临时兼容旧版本或旧运维流程

从库执行：

```sql
CHANGE MASTER TO
  MASTER_HOST='主库IP地址',
  MASTER_USER='replicator',
  MASTER_PASSWORD='<DB_PASSWORD>',
  MASTER_PORT=3306,
  MASTER_LOG_FILE='mysql-bin.000001',
  MASTER_LOG_POS=154;
START SLAVE;
SHOW SLAVE STATUS\G;
```

选择建议：

- 能用 GTID 时优先 GTID
- 传统模式更依赖手工记录位点，切换和修复成本更高

## 复制状态检查

### 查看从库详细错误

```sql
SELECT *
FROM performance_schema.replication_applier_status_by_worker
WHERE LAST_ERROR_NUMBER != 0\G;
```

该表适合排查多线程复制下的具体失败事务，可定位：

- 失败 worker
- 错误号
- GTID
- 相关 binlog 位点范围

### 常用检查项

- `SHOW SLAVE STATUS\G;`
- `SHOW REPLICA STATUS\G;`
- 关注 `Last_Errno`
- 关注 `Last_Error`
- 关注 `Retrieved_Gtid_Set`
- 关注 `Executed_Gtid_Set`

## Binlog 查看方法

注意：`mysqlbinlog` 版本尽量与 MySQL 版本一致。

按位点范围解析：

```bash
mysqlbinlog -v --base64-output=DECODE-ROWS mysql-bin.000082 --start-position=109667861 --stop-position=109704855
mysqlbinlog -v --base64-output=DECODE-ROWS mysql-bin.000003 --start-position=712267838 --stop-position=712267849
```

导出全文到文件：

```bash
mysqlbinlog -v --base64-output=DECODE-ROWS mysql-bin.000082 > binlog_output.txt
mysqlbinlog -v --base64-output=DECODE-ROWS mysql-bin.000005 > binlog_output.txt
```

使用建议：

- 优先根据报错中的 `end_log_pos` 缩小排查范围
- 对 `ROW` 格式 binlog 结合 `DECODE-ROWS` 查看具体变更内容

## 常见故障处理

### 中继日志损坏

现象：从库中继日志损坏，需要清理后重新同步。

```sql
STOP REPLICA;
RESET REPLICA;
START REPLICA;
```

说明：

- 清理后如果复制无法继续，通常仍需要重新从主库导出并初始化数据

### 传统模式重建注意事项

当传统模式下复制错误无法安全跳过时，建议按以下步骤重建：

```sql
STOP SLAVE;
RESET SLAVE ALL;
RESET MASTER;
SHOW MASTER STATUS;
```

处理思路：

1. 从库先删除出问题的表或对象
2. 清理从库复制信息与本地 binlog
3. 主库重新确认 binlog 位点
4. 从库重新导入主库数据
5. 重新执行主从配置
6. 启动复制

### GTID 模式跳过单个异常事务

当从库报错已明确定位到某个 GTID，且确认该事务可安全跳过时使用。

错误示例：

```text
Last_Error: Coordinator stopped because there were error(s) in the worker(s). The most recent failure being: Worker 1 failed executing transaction '2d7579cf-f4da-11ef-a4ce-7cc2557b4a04:857912649' at source log mysql-bin.003474, end_log_pos 832323719. See error log and/or performance_schema.replication_applier_status_by_worker table for more details about this failure or others, if any.
```

MySQL 8.0+：

```sql
STOP REPLICA;
SET GTID_NEXT='2d7579cf-f4da-11ef-a4ce-7cc2557b4a04:857912649';
BEGIN; COMMIT;
SET GTID_NEXT='AUTOMATIC';
START REPLICA;
```

旧版本：

```sql
STOP SLAVE;
SET GTID_NEXT='1e1bdc58-cda3-11ef-bb56-10ffe064b112:857912649';
BEGIN; COMMIT;
SET GTID_NEXT='AUTOMATIC';
START SLAVE;
```

适用前提：

- 已确认该事务无需在从库再次执行
- 已评估对业务数据一致性的影响

### 按错误码临时跳过

错误示例：

```text
Last_Errno: 1062
Last_Error: ....
```

查看当前配置：

```sql
SHOW GLOBAL VARIABLES LIKE 'slave_skip_errors';
```

如果没有配置，可在配置文件中加入：

```conf
[mysqld]
slave_skip_errors = 1062
```

或者：

```conf
[mysqld]
slave_skip_errors = '1146,1062'
```

临时修复方式：

```sql
STOP SLAVE;
SET GLOBAL slave_skip_errors = '1062';
START SLAVE;
```

常见错误码说明：

- `1032` - Can't find record in the table: 当尝试更新或删除一个在从库上不存在的记录时发生。
- `1053` - Server shutdown in progress: 通常在服务器关闭过程中尝试执行查询时发生。
- `1062` - Duplicate entry for key: 尝试插入或更新表中已存在的唯一键值。
- `1146` - Table doesn't exist: 尝试访问一个在从库上不存在的表。
- `1158` - Got an error reading communication packets: 读取网络通信包时出错。
- `1159` - Got timeout reading communication packets: 读取网络通信包时超时。
- `1160` - Got an error writing communication packets: 写入网络通信包时出错。
- `1161` - Got timeout writing communication packets: 写入网络通信包时超时。
- `1205` - Lock wait timeout exceeded; try restarting transaction: 事务在等待锁的过程中超时。
- `1213` - Deadlock found when trying to get lock; try restarting transaction: 事务在尝试获取锁时发现死锁。
- `1594` - Relay log read failure: Possibly out of memory or disk space exhausted: 读取中继日志失败，可能是由于内存不足或磁盘空间耗尽。

注意：

- 该方式适合已知且可接受的数据冲突
- 不适合长期掩盖系统性复制异常
- 处理完成后应复核主从数据一致性

### 跳过一个事务

```sql
STOP SLAVE;
SET GLOBAL sql_slave_skip_counter = 1;  -- 跳过一个事务
START SLAVE;
```

适用说明：

- 仅适用于确认跳过不会影响一致性的情况
- 更适合传统复制位点场景
- GTID 场景优先使用按 GTID 注入空事务的方法

## 主从链式复制

链式复制示意：

```text
01主 → 02从(主) → 03从
```

适用场景：

- 主库不希望承载过多从库连接
- 需要分层扩展读取节点
- 异地级联复制

实施步骤：

### 第一步：配置 01 和 02 的主从关系

- 01 主库导出数据
- 01 主库创建同步账号
- 02 从库重置
- 02 从库导入数据
- 02 从库配置
- 02 从库启动

### 第二步：配置 02 和 03 的主从关系

- 02 主库导出数据
- 02 主库创建同步账号
- 03 从库重置
- 03 从库导入数据
- 03 从库配置
- 03 从库启动

关键点：

- 中间节点必须开启 `log-bin`
- 建议开启 `log_replica_updates=ON`
- GTID 模式更适合链式复制

## 配置选择建议

### 推荐保留的默认策略

- 启用 `gtid_mode=ON`
- 启用 `enforce_gtid_consistency=ON`
- 使用 `binlog_format=ROW`
- 从库启用 `read_only=ON` 与 `super_read_only=ON`
- 从库启用 `relay_log_recovery=ON`
- 链式复制场景启用 `log_replica_updates=ON`

### 需要按场景启用的策略

- `replicate-wild-do-table=tikbee.%`
只在定向复制时启用。

- `slave_skip_errors=1062`
只在确认可安全跳过重复键错误时临时启用，不建议作为长期默认配置。

### 参数调整建议

- `innodb_buffer_pool_size=32G`
适合较大内存主机，小内存环境需按机器规格下调。

- `innodb_read_io_threads = 64`
- `innodb_write_io_threads = 64`
需根据 CPU 核心数和存储能力调整，不建议机械照搬。

- `max_connections=2000`
连接数高时需同步评估内存消耗与线程调度开销。

## 注意事项

- 修改主从配置后必须重启 MySQL。
- 建从前必须先完成主库数据导出和从库数据导入。
- `RESET MASTER`、`RESET SLAVE ALL`、`RESET REPLICA ALL` 都属于高影响操作，执行前需确认角色和后果。
- 从库若承担下游复制，不可随意清理本地 binlog。
- 复制异常修复前，先明确是数据不一致、位点问题、中继日志损坏，还是配置错误。
- 使用错误跳过策略前，必须评估业务一致性风险。
- 查看 binlog 时，`mysqlbinlog` 版本尽量与目标 MySQL 版本一致。

## 常见排查路径

### 从库复制中断

1. `SHOW SLAVE STATUS\G;` 或 `SHOW REPLICA STATUS\G;`
2. 查看 `Last_Errno`、`Last_Error`
3. 查询 `performance_schema.replication_applier_status_by_worker`
4. 根据 `GTID` 或 `end_log_pos` 用 `mysqlbinlog` 分析事务
5. 选择重放、跳过、重建或重新导入数据

### 重复键冲突

优先判断：

- 该数据是否已在从库手工写入
- 是否存在历史补数据
- 是否存在过滤复制造成的数据偏差

确认确实可忽略后，再考虑临时使用 `slave_skip_errors=1062` 或事务跳过。

### 表不存在或记录不存在

优先判断：

- 是否漏导表结构或基础数据
- 是否使用了部分库表复制
- 是否存在跨库依赖导致从库对象缺失

如果属于结构或数据缺失，优先补齐对象，而不是直接跳过错误。
