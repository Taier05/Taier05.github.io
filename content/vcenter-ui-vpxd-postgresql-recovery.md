# vCenter UI 故障：服务依赖与 PostgreSQL 损坏修复复盘

## 基本信息

- 故障对象: `vCenter Server 8.0.3`
- 管理地址: `<IP_ADDRESS>`
- 故障日期: `2026-03-11`
- 故障现象: `https://<IP_ADDRESS>/ui/` 无法正常打开，后续恢复后短暂出现页面一直转圈
- 处理方式: 通过 SSH 登录系统进行服务、日志、数据库和 SSO 组件排查与修复

## 故障现象

用户反馈 vCenter Web UI 无法打开，但 SSH 可以登录服务器。

排查初期确认到以下现象:

- `5480` 管理端口可访问
- `443` 业务端口初期不可访问
- `vmware-rhttpproxy`、`vmware-vpxd`、`vsphere-ui` 存在停止状态
- 磁盘、内存资源正常，无明显空间不足或内存耗尽问题

## 根因分析

此次故障不是单点问题，而是两层问题叠加导致。

### 1. vCenter 关键依赖链未完整启动

在 `2026-03-11 08:33` 左右，`vmware-vmon` 重启后，部分基础服务未完整恢复，导致:

- `vmdird` 停止
- `vmcad` 停止
- `lookupsvc` 停止
- `vmware-stsd` 停止
- `vmware-vapi-endpoint` 停止
- `vmware-envoy` / `vmware-envoy-sidecar` 停止

这直接带来两个后果:

- `vpxd-prestart.py` 调用 `vmafd-cli get-machine-id --server-name localhost` 失败
- `vpxd` 无法连接本地 SSO 端点 `http://localhost:1080`

典型报错:

- `Error 1021: Could not connect to the local service VMware AFD`
- `Error 9127: Could not connect to VMware Directory Service via LDAP`
- `Connection refused: localhost:1080`

### 2. PostgreSQL 系统统计信息 toast 损坏

在恢复完目录服务和 SSO 依赖后，`vpxd` 仍然启动失败。继续排查 `vpxd.log` 发现数据库错误:

`ERROR: missing chunk number 0 for toast value 89086 in pg_toast_2619`

初看像是业务表 `vc.vpx_event_arg_8` 损坏，但进一步确认:

- `pg_toast_2619` 实际对应 `pg_catalog.pg_statistic`
- 损坏的是 PostgreSQL 系统统计信息 toast
- 该统计信息与 `vc.vpx_event_arg_8` 相关

因此本质上是:

- 数据库业务表本体仍可读
- 但 `vpxd` 在执行查询计划或访问统计信息时触发系统统计 toast 损坏
- 最终导致 `vpxd` 初始化失败

## 处理过程

### 1. 基础健康检查

检查了以下内容:

- 磁盘空间 `df -h`
- 内存使用 `free -h`
- 服务状态 `service-control --status --all`
- `vmware-vmon` 日志

结果:

- 存储空间充足
- 内存充足
- 无明显资源瓶颈

### 2. 恢复反向代理和 UI 基础访问

确认并恢复:

- `vmware-rhttpproxy`
- `vsphere-ui`

恢复后:

- `https://<IP_ADDRESS>/ui/` 可返回 `HTTP 200`

### 3. 修复目录服务链路

发现 `vpxd` 预启动失败，原因是本地 AFD / Directory 链路不可用。执行恢复:

- 启动 `vmdird`
- 启动 `vmcad`

验证结果:

- `389/636/2012/2020` 端口恢复监听
- `vmafd-cli get-machine-id --server-name localhost` 可正常返回 machine-id

### 4. 修复 SSO 依赖链

继续恢复以下服务:

- `lookupsvc`
- `vmware-stsd`
- `vmware-vapi-endpoint`
- `vmware-envoy`
- `vmware-envoy-sidecar`

验证结果:

- `localhost:1080` 恢复监听
- `443` 恢复监听
- WebSSO 流程恢复

### 5. 处理数据库统计信息损坏

> **高风险且不可通用照抄**：直接修改 PostgreSQL 系统目录可能造成进一步损坏。下面记录的是本次现场在完成备份、确认对象映射并具备回滚条件后的动作，不代表所有 `missing chunk` 错误都适用。生产环境应优先使用 VCSA 文件级备份并联系 Broadcom 支持，至少先在副本或恢复环境中验证。

在 `vpxd` 仍然失败后，继续分析 PostgreSQL 元数据，确认:

- 损坏来自 `pg_catalog.pg_statistic`
- 与 `vc.vpx_event_arg_8` 统计信息有关

处理方式:

1. 删除该表对应的统计信息
2. 重新执行 `ANALYZE`

执行逻辑:

```sql
delete from pg_statistic where starelid='vc.vpx_event_arg_8'::regclass;
analyze vc.vpx_event_arg_8;
```

处理后:

- `vmware-vpxd` 启动成功

### 6. 补齐完整服务集

为避免 UI 能打开但内部功能异常，后续执行:

```bash
service-control --start --all
```

最终补齐了绝大多数自动服务，关键组件全部恢复。

## 最终结果

最终确认以下核心服务已恢复:

- `vmware-vpxd`
- `vmware-vpxd-svcs`
- `vsphere-ui`
- `vmware-rhttpproxy`
- `lookupsvc`
- `vmware-stsd`
- `vmware-vapi-endpoint`
- `vmware-envoy`
- `vmware-envoy-sidecar`
- `vmdird`
- `vmcad`

验证结果:

- `https://<IP_ADDRESS>/ui/` 返回 `HTTP 200`
- `https://<IP_ADDRESS>/sdk/` 可正常响应
- 用户侧再次访问 `https://<IP_ADDRESS>/ui/` 已恢复正常

## 影响范围

- vCenter Web UI 访问异常
- SSO 登录链路异常
- 部分 inventory / API 后端服务不可用
- 在服务未全部恢复前，页面可能出现持续转圈

未发现以下问题:

- 磁盘满
- 内存不足
- 证书过期导致的直接中断

## 修复中涉及的关键结论

- `5480` 可访问但 `443` 异常，说明设备未宕机，问题集中在业务服务链路
- `vpxd` 是 UI 的核心依赖，`vsphere-ui` 单独运行不代表登录后功能正常
- `vmdird/vmcad/lookupsvc/sts/envoy` 是 `vpxd` 正常启动的重要前置依赖
- `pg_toast_2619` 对应的是 `pg_catalog.pg_statistic`，不是业务表 toast，本次修复重点是重建统计信息而不是恢复业务数据

## 后续建议

### 建议立即执行

- 做一次 vCenter 文件级备份
- 导出当前快照或备份点信息
- 观察未来 24 小时内 `vpxd`、`vsphere-ui`、`vmdird` 是否稳定

### 建议后续安排

- 检查近期是否存在异常重启、存储抖动或数据库层异常
- 检查宿主机磁盘和底层存储健康状态
- 检查 `/var/log/vmware/vpxd/`、`/var/log/vmware/vmon/`、`/var/log/vmware/vmafdd/` 的后续报错趋势
- 在维护窗口内评估一次完整健康检查

## 风险说明

虽然本次已恢复业务，但出现 `pg_statistic` toast 损坏说明数据库层曾发生过异常状态。当前修复方式是有效且可运行的，但仍建议尽快完成备份，并关注是否再次出现数据库统计信息或服务链路异常。

## 附加说明

排障过程中曾创建辅助恢复表:

- `<RECOVERY_TABLE>`

该表是排障过程中的临时备份快照，不影响当前运行。清理前必须再次核实对象用途、备份有效性和保留要求，本文不提供直接删除命令。
