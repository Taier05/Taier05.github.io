# Linux 高 Load 与 D 状态风暴故障复盘

> 本文由一次实际故障处置整理而成，主机地址、节点名、容器标识、目录、端口和账号均已移除或泛化。文中的停止监控、修改内核参数和重启操作具有业务中断风险，只能在确认数据持久化、具备控制台或带外入口并取得维护授权后执行。

一台承载 RagFlow 的 Linux 主机持续触发 Load 高告警，随后出现 SSH 登录困难、认证后命令长时间无响应等现象。分层检查确认网络和 `sshd` 并未中断，真正的问题是大量任务进入 `D`（不可中断睡眠）状态，部分常用命令在读取 `/proc/<pid>/cmdline` 时也被阻塞。

故障链涉及 Transparent Huge Pages（THP）、`khugepaged`、业务 Python 进程的地址空间锁等待，以及 PCP/Categraf 对 `/proc` 的持续扫描。主机重启清除了存量内核等待，但应用依赖并未自动完整恢复，因此还需要分别处理主机级和应用级故障。

## 事故影响

- Load Average 上升到两百以上，但 CPU 仍大部分空闲。
- SSH 网络连接和公钥认证成功，登录后的 `uptime`、`ps`、`w`、`pgrep` 等命令可能卡住。
- 多个进程查询和监控任务进入 D 状态，新的采集任务继续产生。
- RagFlow 后端持续出现 Redis 服务名解析或连接失败。
- 页面一度返回 HTTP 200，但数据库、缓存和对象存储链路并不完整。

未发现数据被删除或 Docker Volume 被重建的证据。恢复后数据库和对象存储健康检查通过，但这类结论仍应以业务对账、数据目录检查和应用验证为准，不能只看容器重新变为 `running`。

## 关键结论

### 高 Load 的直接来源是 D 状态任务堆积

Load Average 不只反映正在使用 CPU 的任务，也会受到不可中断睡眠任务的影响。因此，“Load 很高、CPU idle 仍很高”并不矛盾。

现场主机拥有数十个 CPU，Load 升到两百以上时 CPU 仍有九成左右空闲，同时存在大量 D 状态的 `ps`、`pgrep`、`pmdaproc` 和业务 `python3` 任务。这说明直接压力来自内核等待，而不是计算资源不足。

### SSH 是假性不可达

现场检查结果：

- ICMP 可达。
- TCP 22 端口开放。
- SSH 公钥认证成功。
- `sshd` 保持运行。
- 卡点发生在登录后的命令执行阶段。

因此，“无法 SSH”并不是网络中断或 SSH 服务停止，而是登录会话执行命令时被整机内核卡顿拖住。

### THP 与 khugepaged 是高可信触发条件

现场 THP 处于：

```text
enabled: [always] madvise never
```

同时观察到：

- `AnonHugePages` 达到数十 GiB。
- `khugepaged` 持续活跃。
- RagFlow 容器内的 Python 进程处于内存映射和写锁等待路径。
- 内核日志出现过与相关对象释放路径有关的 Warning。

典型内核栈包含：

```text
rwsem_down_write_slowpath
vm_mmap_pgoff
__x64_sys_brk
```

这些证据说明 THP 内存整理和进程地址空间锁竞争参与了本次阻塞，但仅凭一次现场不能把所有同类 D 状态问题都归因于 THP。

### `/proc` 进程采集放大了故障

PCP、Categraf 或脚本式监控可能通过 `ps`、`pmdaproc` 等方式反复读取：

```text
/proc/<pid>/cmdline
```

当目标进程的地址空间已经发生锁等待时，读取任务可能继续卡在：

```text
proc_pid_cmdline_read
__access_remote_vm
```

现场 `pmlogger` 还出现启停困难和反复拉起。最终形成放大链路：

```text
业务 Python 进程发生地址空间锁等待
        ↓
读取 /proc/<pid>/cmdline 的任务被阻塞
        ↓
监控继续创建新的进程扫描
        ↓
D 状态任务持续堆积
        ↓
Load 升高，登录后的命令近似不可用
```

### RagFlow 参与故障链，但不是已证实的唯一根因

关键 D 状态 Python 进程属于 `ragflow-server`，所以 RagFlow 工作负载确实处于故障链中。但现有证据只能支持：

- RagFlow Python 进程是地址空间锁等待的关键对象。
- THP 与 `khugepaged` 提供了高风险内存整理条件。
- `/proc` 扫描将局部阻塞放大为整机 D 状态风暴。
- Redis、MySQL、MinIO 等依赖异常带来了额外重试和应用错误。

更严谨的结论是“业务工作负载、THP 内核行为和监控采集共同形成故障链”，而不是简单认定某个应用缺陷是单一根因。

## 重启后的第二个问题：应用依赖未恢复

主机重启后 D 状态任务已经清除，但 RagFlow 仍未完整恢复。当时的容器状态表现为：

- Server 和搜索组件运行。
- MySQL、MinIO、Redis 等依赖处于退出状态。

Server 日志持续出现：

```text
Error -2 connecting to redis:6379. Name or service not known
```

Redis 容器没有运行时，容器网络中的 `redis` 服务名无法正常解析。即使页面返回 HTTP 200，也只能说明入口或前端进程可以响应，不能证明后台任务、缓存、对象存储和数据库链路健康。

因此需要区分：

1. **主机级故障**：D 状态风暴导致 Load 高和 SSH 登录后卡顿。
2. **应用级故障**：主机恢复后，RagFlow 依赖容器没有自动完整启动。

## 诊断顺序

### 分开验证 SSH 的四个阶段

从另一台管理机依次检查：

```bash
ping -c 3 <HOST_IP>
nc -vz -w 3 <HOST_IP> 22
ssh -o BatchMode=yes -o ConnectTimeout=5 <HOST_IP> true
ssh -o BatchMode=yes -o ConnectTimeout=5 <HOST_IP> 'cat /proc/loadavg'
```

对应含义：

- Ping 失败：先查网络或主机存活。
- TCP 22 失败：检查安全策略、监听端口和 `sshd`。
- `true` 失败：检查认证、PAM、Shell 和用户策略。
- 认证成功但读取负载卡住：转向主机调度、D 状态和内核等待路径。

### 避免先运行高开销的进程遍历

故障期间不要一开始就执行大范围 `ps -ef`、`w`、`last` 或 `pmdaproc`。它们可能扫描大量 `/proc` 文件并卡在相同路径，进一步增加等待任务。

优先读取明确 PID 的窄范围信息：

```bash
cat /proc/<PID>/status
cat /proc/<PID>/stack
cat /proc/loadavg
cat /sys/kernel/mm/transparent_hugepage/enabled
grep -E 'AnonHugePages|MemAvailable' /proc/meminfo
```

如果 `ps` 仍可快速返回，再限制字段和结果量：

```bash
ps -eo pid,ppid,stat,comm --sort=stat | head -n 80
```

## 实际恢复过程

以下操作根据事故处置记录整理，并未在本文发布过程中重新执行。

### 运行时关闭 THP

```bash
echo never > /sys/kernel/mm/transparent_hugepage/enabled
echo never > /sys/kernel/mm/transparent_hugepage/defrag

cat /sys/kernel/mm/transparent_hugepage/enabled
cat /sys/kernel/mm/transparent_hugepage/defrag
```

活动值的方括号应落在 `never`：

```text
always madvise [never]
```

运行时关闭只会阻止新的 THP 分配和整理，不会拆分已经存在的所有 THP，也无法直接清除已经进入 D 状态的任务。

### 阻止 PCP 继续创建采集任务

先屏蔽相关服务和定时器，避免后续自动激活：

```bash
systemctl mask \
  pmlogger.service \
  pmlogger_farm.service \
  pmlogger_check.timer \
  pmlogger_daily.timer \
  pmcd.service \
  pmie.service \
  pmproxy.service
```

对于仍可响应信号的采集进程，再尝试停止或发送终止信号：

```bash
systemctl stop pmcd.service pmie.service pmproxy.service
systemctl kill -s SIGKILL pmlogger.service
```

如果进程本身处于 D 状态，`SIGKILL` 也不会让它立即退出。屏蔽服务的作用是阻止新任务产生，存量内核等待仍可能需要维护重启才能清除。

该操作会停止 PCP 指标采集。恢复 PCP 前应先调整 proc PMDA 或其他高频 `/proc` 扫描项，并在测试环境验证采集开销。

### 维护重启清除存量内核等待

D 状态任务正在等待内核路径时，普通 `kill -9` 通常不能立即清理。业务确认维护窗口、容器数据已经持久化且具备控制台入口后，执行：

```bash
sync
systemctl reboot
```

`sync` 只能推动内核缓存写回，不能替代数据库正常关闭、存储一致性检查或业务停写。不要默认使用 `systemctl reboot -i`；`-i` 的含义是忽略关机抑制器，并不等同于“更安全”或“立即重启”。

### 持久禁用 THP

本次主机属于使用 `grubby` 管理内核参数的 RHEL 系发行版：

```bash
grubby --update-kernel=ALL --args="transparent_hugepage=never"
grubby --info=DEFAULT | egrep 'kernel=|args='
```

重启后同时检查：

```bash
cat /sys/kernel/mm/transparent_hugepage/enabled
cat /proc/cmdline
```

默认内核参数中应包含：

```text
transparent_hugepage=never
```

Debian、Ubuntu 或其他发行版应采用其对应的 GRUB、systemd-boot 或内核参数管理方式，不要直接照搬 `grubby`。是否选择 `never` 也应基于应用特征和压测结果；某些工作负载可能更适合 `madvise`。

### 恢复 RagFlow 依赖

恢复过程中只启动已有容器，没有删除、重建或格式化 Docker Volume：

```bash
docker start ragflow-mysql ragflow-minio ragflow-redis
docker restart ragflow-server
```

严禁在不清楚数据卷用途时执行：

```bash
docker compose down -v
docker volume rm <VOLUME_NAME>
```

## 恢复验证

主机级检查：

```bash
uptime
cat /proc/loadavg
ps -eo stat= | awk '$1 ~ /^D/ {count++} END {print "D_COUNT=" (count+0)}'

cat /sys/kernel/mm/transparent_hugepage/enabled
cat /proc/cmdline
grubby --info=DEFAULT | egrep 'kernel=|args='

systemctl is-active pmcd pmlogger pmie pmproxy
systemctl is-enabled pmcd pmlogger pmie pmproxy
```

应用级检查：

```bash
docker ps --filter name=ragflow \
  --format 'table {{.Names}}\t{{.Status}}'

docker logs --since 10m ragflow-server

docker exec ragflow-server getent hosts redis
docker exec ragflow-server getent hosts mysql
docker exec ragflow-server getent hosts minio
```

最终确认：

- D 状态任务归零，Load 回落并保持稳定。
- THP 运行态和启动参数均符合预期。
- PCP 相关单元处于 `inactive` 且 `masked`。
- RagFlow Server、搜索、数据库、对象存储和缓存组件均已运行。
- 容器内服务名解析、目标端口和健康检查通过。
- Server 日志恢复正常启动与心跳，不再持续报依赖解析错误。
- 业务页面、后台任务、文件访问和数据查询均通过验证。

HTTP 200 只是其中一个检查点，不能单独作为应用恢复结论。

## 根因分层

### 已确认的直接原因

- 大量任务进入 D 状态并持续累积。
- D 状态任务推高 Load Average。
- `/proc/<pid>/cmdline` 读取路径出现阻塞。
- SSH 认证后的命令执行因此近似不可用。

### 高可信触发条件

- THP 处于 `always`。
- 匿名透明大页使用量较高。
- `khugepaged` 活跃。
- 业务 Python 进程存在 mmap/brk 和写锁等待。

### 已确认的放大因素

- PCP/Categraf 类进程采集持续扫描 `/proc`。
- `pmlogger` 启停异常并产生新的进程查询。
- 新任务继续卡在相同的 `/proc` 路径。

### 应用侧并发故障

- Redis、MySQL、MinIO 等容器没有随主机完整恢复。
- Server 持续重试 Redis 连接。
- 页面 HTTP 200 掩盖了后台依赖异常。

### 尚不能确认

- 不能确认 RagFlow 自身缺陷是唯一根因。
- 不能仅凭 Redis 连接失败证明其造成内核 mmap 锁等待。
- 不能只凭 Load 高就判断 CPU、磁盘或内存容量不足。

## 后续治理

### 防止 THP 配置漂移

- 每次内核升级后检查默认启动参数。
- 每次重启后核对 THP 运行态。
- 将 THP、`AnonHugePages` 和 `khugepaged` 纳入主机基线巡检。

### 降低监控放大风险

- PCP 保持屏蔽，完成 proc PMDA 风险评估后再恢复。
- 避免高频遍历全部 `/proc/<pid>/cmdline`。
- 为进程采集设置超时、并发限制和失败退避。
- Load 告警同时关联 CPU idle、I/O wait、D 状态数量和内存大页指标。

### 修正容器恢复策略

先检查现有策略：

```bash
docker inspect \
  ragflow-server ragflow-es-01 ragflow-mysql ragflow-minio ragflow-redis \
  --format '{{.Name}} restart={{.HostConfig.RestartPolicy.Name}} status={{.State.Status}}'
```

Docker restart policy 可以让容器在退出或 Docker 重启后自动恢复，但它不等同于依赖已经就绪。Compose 中应为数据库、缓存和对象存储定义有效的 `healthcheck`，并让 Server 通过长语法 `depends_on` 的 `condition: service_healthy` 等待依赖健康。

变更 Compose 文件前应备份当前配置并在维护窗口验证，不要为了“自动恢复”直接批量修改所有容器的 restart policy。

## 可复用处置流程

1. 分别验证网络、TCP 22、SSH 认证和登录后命令执行。
2. 对比 Load、CPU idle、I/O wait 和磁盘状态。
3. 使用窄范围 `/proc` 读取确认已知 PID 的状态和内核栈。
4. 检查 THP、`AnonHugePages` 和 `khugepaged`。
5. 确认 D 状态 PID 属于哪个容器或业务进程。
6. 检查 PCP/Categraf 是否反复扫描 `/proc`。
7. 先阻止新的采集任务产生，再安排维护重启清除存量等待。
8. 重启后分别验证主机状态和应用依赖。
9. 持久修正 THP 与监控策略，避免只恢复不治理。
10. 对 RagFlow 执行容器状态、服务解析、端口、健康检查和日志联合验证。

## 结论

这次“Load 很高并且无法正常 SSH”的本质不是算力不足，也不是 SSH 服务或网络故障，而是内存锁等待和 `/proc` 访问阻塞形成大量 D 状态任务，持续进程采集又进一步放大了问题。

RagFlow 工作负载、THP 内核行为和监控采集共同构成了高可信故障链；重启清除了存量内核等待，随后通过持久调整 THP、屏蔽高风险采集链路、恢复 RagFlow 依赖并验证后台服务，主机和业务才真正恢复。

## 参考资料

- [Linux Kernel：CPU load](https://www.kernel.org/doc/html/v6.11/admin-guide/cpu-load.html)
- [Red Hat：Transparent Huge Pages 的使用与禁用](https://access.redhat.com/solutions/46111)
- [Docker：容器 Restart Policy](https://docs.docker.com/engine/containers/start-containers-automatically/)
- [Docker Compose：控制服务启动顺序](https://docs.docker.com/compose/how-tos/startup-order/)
