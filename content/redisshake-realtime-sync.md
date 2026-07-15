# RedisShake 实时同步部署与配置手册

> 迁移提示：本文地址和密码均为占位符。同步前确认源端与目标端版本、命令兼容性、目标键冲突策略和容量；先做小范围校验，再比较 key 数、抽样值与业务读写。不要在同一目录运行两个 RedisShake 进程，也不要在未验证兼容性的情况下向低版本 Redis 迁移。

## 背景与目标

本文用于通过 RedisShake 将源端 Redis 数据实时同步到目标端 Redis，适用于以下场景：

- Redis 数据实时备份
- Redis 集群向单实例迁移
- 全量数据初始化后持续增量同步

RedisShake 官方参考文档：

- https://tair-opensource.github.io/RedisShake/zh/guide/getting-started.html

## 适用环境

当前示例对应的典型场景如下：

- 源端：Redis Cluster
- 目标端：单实例 Redis
- 同步方式：`RDB` 全量同步 + `AOF` 增量同步
- 传输安全：未启用 `TLS`

如果目标端不是单实例，而是 Redis Cluster 或 Sentinel，也可以通过修改配置直接适配，本文后续给出选择建议。

## 部署步骤

### 1. 准备目录与程序

```bash
mkdir /opt/redis-shake
tar -xvf redis-shake-linux-amd64.tar.gz -C /opt/redis-shake
```

### 2. 编写配置文件

建议将配置文件命名为 `shake.toml`，示例配置如下。为避免将敏感信息直接固化到文档中，密码字段请替换为实际值；其余结构和注释可直接保留使用。

```toml
function = ""

# 源
[sync_reader]
cluster = true            # set to true if source is a redis cluster
address = "source-redis.example.internal:6379" # when cluster is true, set address to one of the cluster node
username = ""              # keep empty if not using ACL
password = "<SOURCE_REDIS_PASSWORD>"              # keep empty if no authentication is required
tls = false                #
sync_rdb = true            # set to false if you don't want to sync rdb
sync_aof = true            # set to false if you don't want to sync aof
prefer_replica = false     # set to true if you want to sync from replica node
try_diskless = false       # set to true if you want to sync by socket and source repl-diskless-sync=yes

#[scan_reader]
#cluster = false            # set to true if source is a redis cluster
#address = "127.0.0.1:6379" # when cluster is true, set address to one of the cluster node
#username = ""              # keep empty if not using ACL
#password = ""              # keep empty if no authentication is required
#tls = false
#dbs = []                   # set you want to scan dbs such as [1,5,7], if you don't want to scan all
#scan = true                # set to false if you don't want to scan keys
#ksn = false                # set to true to enabled Redis keyspace notifications (KSN) subscription
#count = 1                  # number of keys to scan per iteration

# [rdb_reader]
# filepath = "/tmp/dump.rdb"

# [aof_reader]
# filepath = "/tmp/.aof"
# timestamp = 0              # subsecond

# 目标
[redis_writer]
cluster = false            # set to true if target is a redis cluster
sentinel = false           # set to true if target is a redis sentinel
master = ""                # set to master name if target is a redis sentinel
address = "target-redis.example.internal:6379" # when cluster is true, set address to one of the cluster node
username = ""              # keep empty if not using ACL
password = "<TARGET_REDIS_PASSWORD>"              # keep empty if no authentication is required
tls = false
off_reply = false          # ture off the server reply

[advanced]
dir = "data"
ncpu = 0        # runtime.GOMAXPROCS, 0 means use runtime.NumCPU() cpu cores
pprof_port = 0  # pprof port, 0 means disable
status_port = 0 # status port, 0 means disable

# log
log_file = "shake.log"
log_level = "info"     # debug, info or warn
log_interval = 5       # in seconds

# redis-shake gets key and value from rdb file, and uses RESTORE command to
# create the key in target redis. Redis RESTORE will return a "Target key name
# is busy" error when key already exists. You can use this configuration item
# to change the default behavior of restore:
# panic:   redis-shake will stop when meet "Target key name is busy" error.
# rewrite: redis-shake will replace the key with new value.
# skip:  redis-shake will skip restore the key when meet "Target key name is busy" error.
rdb_restore_command_behavior = "panic" # panic, rewrite or skip

# redis-shake uses pipeline to improve sending performance.
# This item limits the maximum number of commands in a pipeline.
pipeline_count_limit = 1024

# Client query buffers accumulate new commands. They are limited to a fixed
# amount by default. This amount is normally 1gb.
target_redis_client_max_querybuf_len = 1024_000_000

# In the Redis protocol, bulk requests, that are, elements representing single
# strings, are normally limited to 512 mb.
target_redis_proto_max_bulk_len = 512_000_000

# If the source is Elasticache or MemoryDB, you can set this item.
aws_psync = "" # 云厂商 PSync 参数请从受控配置注入

# destination will delete itself entire database before fetching files
# from source during full synchronization.
# This option is similar redis replicas RDB diskless load option:
#   repl-diskless-load on-empty-db
empty_db_before_sync = false

[module]
# The data format for BF.LOADCHUNK is not compatible in different versions. v2.6.3 <=> 20603
target_mbbloom_version = 20603
```

### 3. 启动同步任务

```bash
nohup /opt/redis-shake/redis-shake shake.toml > shake.log 2>&1 &
```

## 推荐配置说明

### 同步模式

推荐保留以下组合：

- `sync_rdb = true`
- `sync_aof = true`

该组合表示先执行全量同步，再持续进行增量同步，适合实时备份和迁移切换前的数据追平。

如果仅需增量跟随，且目标端已具备完整基线数据，可根据实际情况关闭 `sync_rdb`。如果只做一次性数据导入、不关心后续变更，则可关闭 `sync_aof`。

### 源端读取策略

- `cluster = true`：源端为 Redis Cluster 时启用
- `address`：填写任一可访问的集群节点地址
- `prefer_replica = false`：默认从主节点同步，更稳妥
- `try_diskless = false`：仅当源端已启用 `repl-diskless-sync=yes` 且确认网络与资源条件合适时再开启

选择建议：

- 生产环境优先使用默认配置，兼容性更高。
- 如果主节点压力较大，且副本延迟可接受，可评估将 `prefer_replica` 改为 `true`。

### 目标端写入策略

当前示例适用于目标端单实例 Redis：

- `cluster = false`
- `sentinel = false`

其他场景建议如下：

- 目标端为 Redis Cluster：将 `cluster` 设为 `true`，`address` 填写任一目标集群节点
- 目标端为 Redis Sentinel：将 `sentinel` 设为 `true`，并配置 `master` 为主库名称

如果目标端具备高可用切换需求，优先选择 Sentinel 或 Cluster；如果只是备份库或迁移接收端，单实例配置更直接。

### 冲突键处理策略

`rdb_restore_command_behavior` 用于控制全量同步时目标端已存在同名 Key 的行为：

- `panic`：发现冲突立即停止，同步安全性最高，适合正式迁移前核验环境
- `rewrite`：直接覆盖目标端 Key，适合确认目标端可被源端完整覆盖的场景
- `skip`：跳过冲突 Key，适合部分补数或保守导入场景

推荐原则：

- 目标端必须严格与源端一致时，优先考虑 `rewrite`
- 目标端存在存量业务数据、不能贸然覆盖时，优先考虑 `panic`

当前配置使用 `panic`，这是更稳妥的默认值。

### 目标库清空策略

`empty_db_before_sync = false` 表示全量同步前不主动清空目标库。

适用建议：

- 目标库是新建实例或空库：可按当前配置执行
- 目标库允许被完整覆盖：可结合业务窗口评估是否改为 `true`
- 目标库中仍有保留数据：必须保持 `false`

该参数风险较高，修改前应确认目标端数据是否允许被整体清理。

## 多方案与适用场景

### 方案一：Redis Cluster 到单实例 Redis

适用场景：

- 备份到独立实例
- 将集群数据汇聚到单点环境进行校验、分析或临时接管

关键配置：

```toml
[sync_reader]
cluster = true

[redis_writer]
cluster = false
sentinel = false
```

### 方案二：Redis 到 Redis Cluster

适用场景：

- 迁移到新的集群环境
- 需要目标端具备更高扩展性

关键调整：

```toml
[redis_writer]
cluster = true
sentinel = false
address = "目标集群任一节点:端口"
```

### 方案三：Redis 到 Sentinel 管理的主从架构

适用场景：

- 目标端使用 Sentinel 管理高可用主库
- 希望写入自动指向当前主节点

关键调整：

```toml
[redis_writer]
cluster = false
sentinel = true
master = "sentinel 中配置的主库名称"
address = "sentinel 节点:端口"
```

## 运行与排查

### 日志位置

配置文件和启动命令中都使用了 `shake.log`，因此建议统一通过该文件观察运行状态：

```bash
tail -f shake.log
```

### 常见检查项

- 源端地址是否可达
- 目标端地址是否可达
- 用户名、密码、ACL 是否正确
- 源端是否为 Cluster，配置项 `cluster` 是否匹配
- 目标端是否为 Cluster 或 Sentinel，写入配置是否匹配
- 目标端是否存在同名 Key，导致 `panic` 停止
- 是否需要开启 `TLS`

### 建议的验证方式

- 启动后先检查日志中是否存在连接失败、鉴权失败、协议错误
- 确认全量同步完成后，抽查部分关键业务 Key
- 持续观察增量写入是否正常跟随

## 注意事项

- 配置文件中的密码建议通过受控方式下发，避免长期明文保存在共享文档或公共仓库中。
- `off_reply = false` 保留服务端响应，便于排查；除非明确需要进一步压榨写入性能，否则不建议随意关闭。
- `log_level = "info"` 适合日常运行；只有在问题定位时再临时调整为更高详细度。
- `pprof_port = 0` 和 `status_port = 0` 表示未开启额外观测端口，如需监控或调试可按需启用。
- 如果源端是 AWS Elasticache 或 MemoryDB，需要结合实际填写 `aws_psync`。
- Bloom Filter 模块数据存在版本兼容性要求，`target_mbbloom_version = 20603` 应与目标端模块版本匹配。

## 建议的落地方式

在生产环境中，推荐先以当前配置在测试或预发布环境完成一次全量与增量链路验证，再切换到正式环境执行。若目标库不是空库，应优先确认 `rdb_restore_command_behavior` 与 `empty_db_before_sync` 的组合是否满足数据安全要求。

## 参考资料

- [RedisShake Quick Start](https://tair-opensource.github.io/RedisShake/en/guide/getting-started.html)
- [RedisShake Sync Reader](https://tair-opensource.github.io/RedisShake/en/reader/sync_reader.html)
