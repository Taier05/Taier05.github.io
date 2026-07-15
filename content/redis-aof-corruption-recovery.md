# Redis AOF 损坏导致启动失败的修复与验证

## 适用场景

Redis 启动命令类似：

```bash
/opt/redis/src/redis-server /opt/redis/redis.conf
```

启动后进程不存在、端口未监听，日志中出现 AOF 相关错误。

## 典型现象

检查进程：

```bash
ps -ef | grep redis | grep 6379 | grep -v grep
```

检查端口：

```bash
ss -lntp | grep ':6379'
```

查看 Redis 日志：

```bash
tail -n 100 /opt/redis/data/redis.log
```

典型报错：

```text
Bad file format reading the append only file appendonly.aof.xxx.incr.aof:
make a backup of your AOF file, then use ./redis-check-aof --fix <filename.manifest>
```

说明 Redis 启动时加载 AOF 文件失败。

## 确认 AOF 损坏

查看配置：

```bash
grep -nE '^(appendonly|appendfilename|dir|logfile|port|pidfile)' /opt/redis/redis.conf
```

一般 AOF 文件目录：

```bash
/opt/redis/data/appendonlydir/
```

执行只读校验：

```bash
/opt/redis/src/redis-check-aof \
/opt/redis/data/appendonlydir/appendonly.aof.manifest
```

如果看到类似输出，即可确认 AOF 损坏：

```text
AOF appendonly.aof.xxx.incr.aof format error
AOF analyzed: size=xxx, ok_up_to=xxx, diff=xxx
```

## 修复步骤

先备份当前 AOF 目录：

```bash
cp -a /opt/redis/data/appendonlydir \
/opt/redis/data/appendonlydir.bak.$(date +%Y%m%d%H%M%S)
```

> **高风险操作**：先保留 AOF 目录的独立副本，并确认可接受数据回退范围。Redis 官方说明：如果损坏不只发生在文件尾部，`--fix` 可能丢弃从首个损坏位置到文件末尾的全部内容。建议先在副本上检查差异，再决定是否修复原文件。

执行修复：

```bash
/opt/redis/src/redis-check-aof --fix \
/opt/redis/data/appendonlydir/appendonly.aof.manifest
```

注意：`--fix` 的丢失范围取决于首个损坏位置；如果损坏发生在文件中部，后续大量有效写入也可能被丢弃。必须先检查报告偏移和备份副本。

如存在残留 pid 文件，确认进程不存在后再清理：

```bash
cat /var/run/redis_6379.pid
ps -p $(cat /var/run/redis_6379.pid)
rm -f /var/run/redis_6379.pid
```

启动 Redis：

```bash
/opt/redis/src/redis-server \
/opt/redis/redis.conf
```

## 启动后验证

检查进程：

```bash
ps -ef | grep '/opt/redis/src/redis-server' | grep -v grep
```

检查端口：

```bash
ss -lntp | grep ':6379'
```

查看日志：

```bash
tail -n 80 /opt/redis/data/redis.log
```

正常日志应包含：

```text
DB loaded from append only file
Ready to accept connections tcp
```

验证 Redis 响应：

```bash
REDISCLI_AUTH="$(awk '$1=="requirepass" {print $2}' /opt/redis/redis.conf)" \
/opt/redis/src/redis-cli -h <IP_ADDRESS> -p 6379 PING
```

正常返回：

```text
PONG
```

检查持久化状态：

```bash
REDISCLI_AUTH="$(awk '$1=="requirepass" {print $2}' /opt/redis/redis.conf)" \
/opt/redis/src/redis-cli -h <IP_ADDRESS> -p 6379 INFO persistence | \
grep -E '^(loading|rdb_last_bgsave_status|aof_enabled|aof_last_bgrewrite_status|aof_last_write_status):'
```

正常结果应类似：

```text
loading:0
rdb_last_bgsave_status:ok
aof_enabled:1
aof_last_bgrewrite_status:ok
aof_last_write_status:ok
```

## 本次故障结论

本次 `6379` 启动失败的原因是：

```text
appendonly.aof.<SEQUENCE>.incr.aof 文件尾部损坏
```

`redis-check-aof` 显示：

```text
ok_up_to=<VALID_OFFSET>
diff=<TRUNCATED_BYTES>
```

说明损坏点之后存在无效数据。执行 `redis-check-aof --fix` 后，Redis 可正常启动并返回 `PONG`。

## 官方参考

- [Redis Persistence：AOF 截断与损坏恢复](https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/)
