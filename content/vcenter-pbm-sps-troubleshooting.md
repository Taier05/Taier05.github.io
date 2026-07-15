# vCenter PBM / SPS 服务异常排查记录

## 一、故障现象

在 vSphere Client 中，通过 vCenter 给任意一台 ESXi 主机创建虚拟机时，均出现相同报错：

```text
无法连接到 Profile-Driven Storage Service。
```

创建虚拟机时进一步报错：

```text
出现了常规系统错误:
PBM error occurred during PreCreateCheckCallback:
No version for VMODL calls to
<<last binding: <<TCP '<IP_ADDRESS> : 51346'>,
<TCP '<IP_ADDRESS> : 1080'>> >, /pbm/sdk>
```

故障特点：

- vCenter 下所有 ESXi 主机均无法正常创建虚拟机
- 不同 datastore 均出现相同错误
- 报错中包含 `/pbm/sdk`
- 报错中包含 `<IP_ADDRESS>:1080`
- vSphere Client 提示无法连接到 Profile-Driven Storage Service

---

## 二、故障判断

由于所有 ESXi 主机都出现相同的 PBM 错误，因此问题并非单台 ESXi、单个 datastore 或虚拟机参数导致，而是集中在 vCenter 本身。

PBM 和 SPS 的关系如下：

- **PBM**：Policy-Based Management，基于策略的存储管理
- **SPS**：Storage Policy Service / Profile-Driven Storage Service
- vCenter 中对应服务名：`vmware-sps`

创建虚拟机时，vCenter 会调用 PBM/SPS 服务执行存储策略和兼容性预检查。

当 `vmware-sps` 服务停止后，vCenter 无法正常访问 `/pbm/sdk`，因此所有通过 vCenter 发起的虚拟机创建任务都会失败。

---

## 三、排查过程

### 1. 检查 SPS 服务状态

登录 vCenter Server Appliance，执行：

```bash
service-control --status vmware-sps
```

返回结果：

```text
Stopped:
 vmware-sps
```

说明 `vmware-sps` 服务已停止。

---

### 2. 检查 vCenter 核心依赖服务

执行：

```bash
service-control --status vmware-vpxd
service-control --status vmware-vpxd-svcs
service-control --status vmware-stsd
```

返回结果：

```text
Running:
 vmware-vpxd
```

```text
Running:
 vmware-vpxd-svcs
```

```text
Running:
 vmware-stsd
```

说明 vCenter 核心管理服务、vpxd 相关服务以及 STS 服务均正常运行。

---

### 3. 检查磁盘空间

执行：

```bash
df -h
```

检查结果显示：

- `/storage/log` 使用率约 10%
- `/storage/db` 使用率约 2%
- `/storage/core` 使用率约 1%
- 根分区 `/` 使用率约 33%

未发现分区空间不足问题。

因此，本次故障不是由 vCenter 磁盘空间耗尽导致。

---

## 四、处理方法

执行以下命令启动 `vmware-sps` 服务：

```bash
service-control --start vmware-sps
```

启动完成后，可再次检查服务状态：

```bash
service-control --status vmware-sps
```

正常情况下应返回：

```text
Running:
 vmware-sps
```

---

## 五、处理结果

启动 `vmware-sps` 服务后：

- vSphere Client 不再提示“无法连接到 Profile-Driven Storage Service”
- PBM `/pbm/sdk` 错误消失
- vCenter 下各 ESXi 主机均可正常创建虚拟机
- 无需重启 ESXi 主机
- 无需重启整个 vCenter
- 无需修改 datastore 或虚拟机配置

---

## 六、最终根因

本次故障的直接原因是：

```text
vCenter 的 vmware-sps 服务处于 Stopped 状态
```

由于 `vmware-sps` 停止，vCenter 无法完成虚拟机创建前的 PBM 存储策略预检查，从而导致所有 ESXi 主机通过 vCenter 创建虚拟机时统一报错。

---

## 七、常用检查命令

### 检查 SPS 服务

```bash
service-control --status vmware-sps
```

### 启动 SPS 服务

```bash
service-control --start vmware-sps
```

### 重启 SPS 服务

仅在服务显示 Running，但 PBM 功能仍异常时使用：

```bash
service-control --restart vmware-sps
```

### 检查相关服务

```bash
service-control --status vmware-vpxd
service-control --status vmware-vpxd-svcs
service-control --status vmware-stsd
```

### 检查所有 vCenter 服务

```bash
service-control --status --all
```

### 检查磁盘空间

```bash
df -h
```

### 查看 SPS 日志

```bash
tail -n 200 /var/log/vmware/vmware-sps/sps.log
```

### 查看 vMon 日志

```bash
tail -n 200 /var/log/vmware/vmon/vmon.log
```

---

## 八、后续建议

如果 `vmware-sps` 后续再次自动停止，不建议只反复手动启动，应进一步检查：

1. SPS 服务日志中是否存在证书、SSO、权限或数据库错误
2. vCenter 是否发生过异常断电或非正常重启
3. vCenter 证书是否临近过期或已经过期
4. `/storage/log`、`/storage/db` 等分区是否空间不足
5. vCenter 是否刚完成升级、补丁安装或恢复操作
6. `vmware-sps` 是否频繁崩溃或启动后自动退出

建议重点查看：

```bash
grep -iE "error|exception|certificate|permission|sso|database|failed" \
/var/log/vmware/vmware-sps/sps.log | tail -n 100
```

---

## 九、故障结论摘要

```text
故障现象：
vCenter 下所有 ESXi 创建虚拟机时报 PBM 错误。

直接原因：
vCenter 的 vmware-sps 服务停止。

处理命令：
service-control --start vmware-sps

处理结果：
服务启动后，虚拟机恢复正常创建。
```
