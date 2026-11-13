# Elasticsearch Translog 损坏：离线修复与 Kibana 恢复复盘

> 本文由一次 Elasticsearch 7.17 与 Kibana 故障处置整理而成。公网地址、节点名称、索引标识、数据目录、凭据、文档数量和精确时间均已删除或泛化。`elasticsearch-shard remove-corrupted-data` 和 `allocate_stale_primary` 都可能造成永久数据丢失，只能在没有健康分片副本、无法从快照恢复且已完成离线备份时，作为最后手段使用。

一次单节点 Elasticsearch 的 Kibana 任务索引主分片无法分配，导致 Kibana 长时间停留在“server is not ready yet”。日志和离线工具最终确认：Lucene 已提交索引仍可读取，但该分片的 translog 已损坏。处置过程没有删除整个索引，而是先停服和备份，再定向重建损坏分片的事务日志，最后按工具生成的新 allocation ID 强制分配旧主分片。

## 故障现象

现场表现包括：

- Elasticsearch 启动后集群为 `red`，存在未分配主分片；
- Kibana 无法完成内部索引迁移，对外持续返回未就绪；
- 故障集中在 Kibana Task Manager 的系统索引；
- 业务索引仍在磁盘上，但在主分片恢复前不能据此断言数据完整；
- 日志提示 shard failure、translog corruption 或 `no_valid_shard_copy`。

示例索引统一写成：

```text
.kibana_task_manager_REPLACE_WITH_VERSION_001
```

不要直接复制示例名称。先从日志、`_cat/shards` 和 allocation explain 的结果确认真实索引与分片号。

## 先划定恢复边界

这类故障至少有四条恢复路径，优先级从高到低如下：

1. 让 Elasticsearch 从健康副本自动恢复；
2. 从已验证的快照恢复索引；
3. 从原始数据源重新生成索引；
4. 使用 `elasticsearch-shard` 删除损坏数据，并强制分配修复后的旧分片。

第 4 条不是常规维修动作。Elastic 官方文档明确说明，这个工具会移除损坏内容，可能丢失数据；如果后来有包含更新数据的节点重新加入，强制分配的旧副本还可能覆盖更好的副本。

执行前必须回答：

- 是否确实没有健康副本；
- 最近快照是否可用、是否完成过恢复演练；
- 故障索引能否从源系统重建；
- 业务能否接受从最后一次 Lucene commit 之后的未提交变更丢失；
- 是否有维护窗口、控制台入口和足够的备份空间。

## 只读取证

先确认集群和分片状态。以下请求需要使用具备只读监控权限的账号，并通过受控方式提供凭据：

```bash
ES_URL='http://127.0.0.1:9200'
ES_USERNAME='REPLACE_WITH_MONITOR_USER'

curl --fail --silent --show-error \
  --user "$ES_USERNAME" \
  "$ES_URL/_cluster/health?pretty"

curl --fail --silent --show-error \
  --user "$ES_USERNAME" \
  "$ES_URL/_cat/shards?v=true&h=index,shard,prirep,state,node,unassigned.reason&s=state"
```

只针对目标主分片请求 allocation explain：

```bash
curl --fail --silent --show-error \
  --user "$ES_USERNAME" \
  --header 'Content-Type: application/json' \
  --request POST \
  "$ES_URL/_cluster/allocation/explain?pretty" \
  --data @- <<'JSON'
{
  "index": ".kibana_task_manager_REPLACE_WITH_VERSION_001",
  "shard": 0,
  "primary": true
}
JSON
```

`--user "$ES_USERNAME"` 不把密码写进脚本；curl 会交互读取密码。自动化场景应使用权限为 `0600` 的专用凭据文件或受管密钥，不要把密码提交到仓库或写入命令行参数。

同时保存以下证据：

```bash
journalctl -u elasticsearch --since 'REPLACE_WITH_START_TIME' --no-pager
journalctl -u kibana --since 'REPLACE_WITH_START_TIME' --no-pager
```

还应记录版本、节点角色、数据路径、快照状态、文件系统与内核日志。日志中的 token、Cookie、用户数据和公网地址必须在对外分享前删除。

## 停服并制作离线备份

### 1. 正常停止服务

先停 Kibana，避免它持续重试迁移；再停 Elasticsearch，保证离线工具和文件备份面对稳定数据：

```bash
set -euo pipefail
systemctl stop kibana
systemctl stop elasticsearch

test "$(systemctl show kibana -p ActiveState --value)" = inactive
test "$(systemctl show elasticsearch -p ActiveState --value)" = inactive
```

继续确认相关端口无监听、Elasticsearch 进程已经退出。不要在 Elasticsearch 仍运行时执行 `elasticsearch-shard` 或复制数据目录。

### 2. 备份数据、配置和日志

下面使用泛化路径，实际环境必须先读取 `path.data`：

```bash
set -euo pipefail

ES_DATA_DIR='/srv/elasticsearch/data'
BACKUP_ROOT="/var/backups/elasticsearch/recovery-$(date +%Y%m%d-%H%M%S)"

test "$(systemctl show elasticsearch -p ActiveState --value)" = inactive
install -d -m 0700 \
  "$BACKUP_ROOT/data" \
  "$BACKUP_ROOT/config" \
  "$BACKUP_ROOT/logs/elasticsearch" \
  "$BACKUP_ROOT/logs/kibana"

cp -a --reflink=never "$ES_DATA_DIR/." "$BACKUP_ROOT/data/"
cp -a --reflink=never /etc/elasticsearch /etc/kibana "$BACKUP_ROOT/config/"
cp -a --reflink=never /var/log/elasticsearch/. "$BACKUP_ROOT/logs/elasticsearch/"
cp -a --reflink=never /var/log/kibana/. "$BACKUP_ROOT/logs/kibana/"
```

配置备份可能包含密码、证书私钥和 keystore，备份根目录必须限制访问。备份至少应存放到独立故障域；同盘副本只能提供误操作回退，不能替代快照或异机备份。

为数据文件生成校验清单并验证副本：

```bash
(
  cd "$ES_DATA_DIR"
  find . -type f -print0 | sort -z | xargs -0 -r sha256sum
) > "$BACKUP_ROOT/data.sha256"

(
  cd "$BACKUP_ROOT/data"
  sha256sum --quiet -c ../data.sha256
)
```

数据量很大时，计算全量哈希会显著增加 I/O，应结合维护窗口评估。快照恢复仍优先于直接操作数据目录。

## 离线修复目标分片

先从故障日志和 allocation explain 确认索引名、分片号与数据节点。然后以 Elasticsearch 服务用户运行官方工具：

```bash
runuser -u elasticsearch -- env ES_PATH_CONF=/etc/elasticsearch \
  /usr/share/elasticsearch/bin/elasticsearch-shard remove-corrupted-data \
  --index '.kibana_task_manager_REPLACE_WITH_VERSION_001' \
  --shard-id 0
```

工具会分析 Lucene index 和 translog，并在真正写入前要求确认。必须逐行阅读输出，尤其关注：

- 损坏发生在 Lucene segment 还是 translog；
- 明确报告将丢失多少文档或事务日志内容；
- 工具生成的新 history UUID 和 allocation ID；
- 工具最后给出的 `allocate_stale_primary` 请求。

如果输出与预期索引或分片不符，输入 `N` 退出。只有在风险已经确认并获得授权时才输入 `Y`。

本案例中，已提交 Lucene 索引可读取，损坏位于 translog。工具重建了事务日志，因此最后一次 Lucene commit 之后尚未安全提交的任务状态可能丢失；无法从现有证据准确计算丢失数量。

## 启动 Elasticsearch 并重新分配分片

### 1. 启动并等待基础服务可用

```bash
systemctl start elasticsearch
systemctl is-active elasticsearch
```

安全索引加载期间短暂出现 `401` 不等于密码被修改。先结合服务日志确认节点完成启动，不要因为一次早期探测失败就重置凭据。

### 2. 先执行 dry-run

将工具输出的索引名、分片号和节点名代入请求。`accept_data_loss: true` 表示明确接受该分片可能丢失数据，不能隐藏或省略这个风险：

```bash
ES_URL='http://127.0.0.1:9200'
ES_USERNAME='REPLACE_WITH_ADMIN_USER'

curl --fail --silent --show-error \
  --user "$ES_USERNAME" \
  --header 'Content-Type: application/json' \
  --request POST \
  "$ES_URL/_cluster/reroute?dry_run=true&explain=true&pretty" \
  --data @- <<'JSON'
{
  "commands": [
    {
      "allocate_stale_primary": {
        "index": ".kibana_task_manager_REPLACE_WITH_VERSION_001",
        "shard": 0,
        "node": "REPLACE_WITH_NODE_NAME",
        "accept_data_loss": true
      }
    }
  ]
}
JSON
```

确认响应中的决策允许分配，并再次核对目标只有一个索引、一个分片和一个节点。

### 3. 执行实际分配

去掉 `dry_run=true` 后才会改变集群状态：

```bash
curl --fail --silent --show-error \
  --user "$ES_USERNAME" \
  --header 'Content-Type: application/json' \
  --request POST \
  "$ES_URL/_cluster/reroute?pretty" \
  --data @- <<'JSON'
{
  "commands": [
    {
      "allocate_stale_primary": {
        "index": ".kibana_task_manager_REPLACE_WITH_VERSION_001",
        "shard": 0,
        "node": "REPLACE_WITH_NODE_NAME",
        "accept_data_loss": true
      }
    }
  ]
}
JSON
```

立即保存请求和响应，但在对外文档中删除节点 ID、凭据及内部地址。

## 启动 Kibana 与验收

目标主分片恢复后再启动 Kibana：

```bash
systemctl start kibana
systemctl is-active kibana
```

至少完成以下检查：

1. Elasticsearch 和 Kibana 服务保持 `active`，没有持续重启；
2. Kibana 日志显示内部索引迁移完成；
3. `/_cluster/health` 中未分配主分片为 `0`；
4. 目标 Kibana 系统索引恢复为 `green`；
5. Kibana `/api/status` 达到可用状态；
6. 对业务索引执行只读查询，确认所有目标分片成功、无超时；
7. 对比修复前后的索引文档数、关键聚合和抽样记录；
8. 在业务窗口内观察错误日志、任务调度和索引写入。

本案例完成上述只读验收后，Kibana 恢复可用，全部主分片启动，业务索引抽样结果与修复前一致。没有执行破坏性的业务写入测试，因此结论严格限定为“服务与只读查询恢复”，不能扩展为所有业务路径均已验证。

## 为什么单节点恢复后仍可能是 yellow

`yellow` 表示所有主分片已分配，但仍有副本未分配。Elasticsearch 不会把副本放在与主分片相同的节点上，因此只有一个数据节点且索引副本数大于 `0` 时，集群会保持 `yellow`。

这不等于本次主分片修复失败，但代表缺少冗余。生产环境的正确改进通常是增加符合角色与容量要求的数据节点，并保留至少一个副本。把副本数改成 `0` 虽然能让单节点显示 `green`，却会降低恢复能力，不能只为“颜色好看”而修改。

## 后续改进

- 建立并定期演练 Elasticsearch 快照恢复；数据目录文件副本不是快照替代品；
- 生产环境避免单节点，按故障域规划节点、主节点选举和副本；
- 为 Elasticsearch、Kibana、磁盘、文件系统和内核异常建立持久日志；
- 对系统索引故障设置告警，关注未分配主分片和重复 shard failure；
- 修复数据后继续调查底层原因，不能把“服务恢复”误写成“根因解决”；
- 保存变更记录和脱敏证据，明确哪些是已验证结果、哪些仍是候选原因。

## 参考资料

- [Elastic：elasticsearch-shard 工具](https://www.elastic.co/docs/reference/elasticsearch/command-line-tools/shard-tool)
- [Elastic：Cluster Reroute API](https://www.elastic.co/docs/api/doc/elasticsearch/operation/operation-cluster-reroute)
- [Elastic：排查 red / yellow 集群状态](https://www.elastic.co/docs/troubleshoot/elasticsearch/red-yellow-cluster-status)
