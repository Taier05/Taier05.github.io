# Linux 网卡 Bond 配置与维护手册

## 背景与目标

在多网口服务器场景中，可通过 Linux Bond 将多块物理网卡聚合为一个逻辑接口，以实现链路冗余、故障切换或带宽增强。本文基于 `nmcli` 命令整理 Bond 的常用模式、创建方式、模式切换方法、删除回退流程以及运行状态检查方法，适用于使用 NetworkManager 管理网络连接的 Linux 系统。

## 环境说明

- 网络管理工具：`nmcli`
- 逻辑接口名称：`bond0`
- 示例物理网卡：`eno1np0`、`eno2np1`
- 示例地址：
  - IP：`<NETWORK_CIDR>`
  - 网关：`<IP_ADDRESS>`
  - DNS：`<IP_ADDRESS>,<IP_ADDRESS>`

实际部署时，应按现场环境替换网卡名称、IP、网关及 DNS。

## Bond模式说明

Bond 支持多种工作模式，适用场景不同：

- `balance-rr`：轮询（Round-Robin）
- `active-backup`：主动-备份
- `balance-xor`：异或平衡
- `broadcast`：广播
- `802.3ad`：链路聚合控制协议（LACP）
- `balance-tlb`：适应性传输负载平衡
- `balance-alb`：适应性负载平衡

### 选择建议

- 需要最稳妥的主备切换时，优先使用 `active-backup`。
- 交换机支持 LACP，且希望规范化链路聚合时，使用 `802.3ad`。
- 仅在明确理解交换机侧配合要求时，才建议使用 `balance-rr` 等负载分担模式。

## 模式切换

将 `bond0` 切换为主备模式：

```bash
# 切换轮询模式
nmcli connection modify bond0 bond.options "mode=active-backup"

# 重新加载连接
# 在修改模式后，需要重新激活连接以应用更改：
nmcli connection up bond0
```

说明：

- 命令实际设置的是 `active-backup`，如需切换为其他模式，可将 `mode=` 后的值替换为目标模式。
- 修改完成后必须重新拉起连接，否则新模式不会立即生效。

## 创建Bond接口

以下命令用于创建 Bond 接口并加入两块从属网卡。命令中的注释、变量和步骤可直接保留，便于现场修改后执行。

```bash
# 命令
# 创建堆叠   注意更改IP地址 网关 DNS 网卡名称
ENT1=eno1np0 && \
ENT2=eno2np1 && \
_MODE=balance-rr && \
nmcli connection add type bond ifname bond0 mode $_MODE && \
nmcli connection modify bond-bond0 ipv4.addresses "<NETWORK_CIDR>" && \
nmcli connection modify bond-bond0 ipv4.gateway "<IP_ADDRESS>" && \
nmcli connection modify bond-bond0 ipv4.dns "<IP_ADDRESS>,<IP_ADDRESS>" && \
nmcli connection modify bond-bond0 ipv4.method manual && \
nmcli connection add type ethernet ifname $ENT1 master bond0 && \
nmcli connection add type ethernet ifname $ENT2 master bond0 && \
nmcli con show && \
nmcli con up bond-slave-$ENT1 && \
nmcli con up bond-slave-$ENT2 && \
nmcli con up bond-bond0 && \
nmcli con show && \
cat /proc/net/bonding/bond0
```

### 步骤说明

1. 定义从属网卡变量 `ENT1`、`ENT2`。
2. 指定 Bond 模式变量 `_MODE`。
3. 创建逻辑接口 `bond0`。
4. 为 Bond 接口配置静态 IP、网关、DNS。
5. 将两块物理网卡加入 `bond0`。
6. 依次拉起从属接口和 Bond 接口。
7. 通过连接列表和内核状态文件确认结果。

### 适用场景建议

- `balance-rr`：适合实验、验证或已确认交换机与网络路径支持轮询分发的场景。
- `active-backup`：适合生产环境中的高可用主备链路，配置简单，兼容性通常更好。

如果现场以稳定性优先，建议将脚本中的 `_MODE=balance-rr` 调整为 `_MODE=active-backup` 后再执行。

## 删除Bond并恢复独立网卡

当需要取消 Bond 配置并恢复物理网卡独立使用时，可执行以下命令：

```bash
# 删除堆叠
ENT1=eno1np0 && \
ENT2=eno2np1 && \
nmcli connection delete bond-bond0 && \
nmcli connection delete bond-slave-$ENT1 && \
nmcli connection delete bond-slave-$ENT2 && \
nmcli connection add type ethernet ifname $ENT1 && \
nmcli connection add type ethernet ifname $ENT2 && \
systemctl restart network
```

说明：

- 删除前应确认当前远程访问链路不会因此中断。
- 新增独立以太网连接后，若系统仍由 NetworkManager 管理网络，通常也可通过 `nmcli connection up` 方式拉起连接。
- `systemctl restart network` 是否可用取决于发行版网络服务实现；如该服务不存在，应改用现场实际的网络管理方式。

## 运行状态检查

### 查看Bond工作模式与链路状态

```bash
# 查看模式
cat /proc/net/bonding/bond0
```

或：

```bash
nmcli connection show bond-bond0 | grep mode=
```

### 建议重点核对的信息

- 当前 Bond 模式是否与预期一致
- Active Slave 是否正确
- 各从属网卡链路状态是否为 `up`
- MII Status 是否正常

## 注意事项

- 执行前确认系统使用的是 NetworkManager；若为传统网络脚本管理，命令和连接名称可能不同。
- `bond0` 是接口名，`bond-bond0` 是 `nmcli` 自动生成的连接名，操作时不要混淆。
- 负载分担类模式通常需要交换机侧配合；未配套时可能出现丢包、回环或链路异常。
- 远程主机变更网络前应准备带外管理通道，避免因配置错误导致失联。
- 生产环境推荐先在维护窗口执行，并在变更前记录原有网络配置。

## 常见问题与排查

### 1. 修改模式后未生效

处理方法：

- 执行 `nmcli connection up bond0` 重新激活连接。
- 再次使用 `cat /proc/net/bonding/bond0` 确认实际模式。

### 2. Bond创建成功但业务不通

排查方向：

- 检查 IP、网关、DNS 是否填写正确。
- 检查交换机侧是否支持当前 Bond 模式。
- 检查从属网卡名称是否与实际系统一致。

### 3. 看不到Bond状态文件

排查方向：

- 确认 `bond0` 已成功创建并拉起。
- 确认 Bond 内核模块已正常工作。

### 4. 删除Bond后网络未恢复

排查方向：

- 检查独立网卡连接是否已重新创建。
- 检查是否需要手动补充 IP 配置。
- 检查系统中是否存在 `network` 服务，必要时改用 `nmcli` 或发行版对应网络服务恢复连接。
