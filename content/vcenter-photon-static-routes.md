# vCenter (Photon OS 4) 持久化静态路由配置方法

> 变更提示：网络配置错误可能导致 vCenter Server Appliance 失联。修改前应确认有 VAMI、虚拟机控制台或 ESXi 带外入口，备份原 .network 文件并记录当前路由。优先使用 networkctl reload 和 networkctl reconfigure eth0 只重载目标接口，避免直接重启整个 systemd-networkd。

> 适用：VMware Photon OS 4.0（基于 systemd / systemd-networkd 管理网卡）
> 目标：把以下两条路由**持久化**，重启后仍存在
>
> - `<VPN_CIDR_A> via <VPN_GATEWAY_A> dev eth0`
> - `<VPN_CIDR_B> via <VPN_GATEWAY_B> dev eth0`

---

## 1. 背景与原理

`ip route add ...` 这种方式只会写入**运行时路由表**，重启或网络服务重启后会丢失。
Photon OS 4 常见做法是把静态路由写到 **systemd-networkd 的 `.network` 配置**里，通过 `[Route]` 段落实现持久化。

---

## 2. 操作步骤（推荐流程）

### 2.1 确认 eth0 使用的 `.network` 配置文件

执行：

```bash
networkctl status eth0 | sed -n 's/.*Network File: //p'
```

预期会得到类似结果（示例）：

- `/etc/systemd/network/10-eth0.network`
- `/etc/systemd/network/99-dhcp-en.network`

> 这个输出的文件路径就是**需要修改的配置文件**。

如果没有显示 `Network File` 或找不到文件，用兜底方式搜索：

```bash
grep -Rns "Name=eth0" /etc/systemd/network/*.network
```

---

### 2.2 备份并编辑该 `.network` 文件

先备份（将 `<文件名>` 替换为上一步查到的真实文件）：

```bash
cp -a /etc/systemd/network/<文件名> /etc/systemd/network/<文件名>.bak
```

编辑文件：

```bash
vi /etc/systemd/network/<文件名>
```

在文件末尾追加以下两段（**两段 `[Route]` 要分开写**）：

```ini
[Route]
Destination=<VPN_CIDR_A>
Gateway=<VPN_GATEWAY_A>

[Route]
Destination=<VPN_CIDR_B>
Gateway=<VPN_GATEWAY_B>
```

> 注意：不要破坏原来的 `[Match] / [Network] / [DHCP]` 等段落，只需要追加 `[Route]`。

---

### 2.3 重启 networkd 并验证

使配置生效：

```bash
networkctl reload
networkctl reconfigure eth0
```

验证路由是否存在：

```bash
ip route | egrep '<VPN_CIDR_A>|<VPN_CIDR_B>'
```

---

## 3. 如果系统里没有合适的 `.network` 文件（可选兜底）

当 `/etc/systemd/network/` 下没有匹配 eth0 的配置文件时，可以新建一个（常见 DHCP 场景）：

```bash
cat >/etc/systemd/network/10-eth0.network <<'EOF'
[Match]
Name=eth0

[Network]
DHCP=yes

[Route]
Destination=<VPN_CIDR_A>
Gateway=<VPN_GATEWAY_A>

[Route]
Destination=<VPN_CIDR_B>
Gateway=<VPN_GATEWAY_B>
EOF

networkctl reload
networkctl reconfigure eth0
ip route | egrep '<VPN_CIDR_A>|<VPN_CIDR_B>'
```

---

## 4. 排错与注意事项

### 4.1 路由没生效，先看日志

```bash
journalctl -u systemd-networkd -b --no-pager | tail -n 200
networkctl status eth0
```

### 4.2 网关不在直连网段时（特殊情况）

如果 `Gateway` 不在 eth0 的直连网段，可能需要在对应 `[Route]` 段里增加：

```ini
GatewayOnLink=yes
```

> 若网关位于 `<MANAGEMENT_CIDR>` 直连网段内，通常不需要该参数。

### 4.3 为什么不建议“开机脚本里写 ip route add”
- 可能出现网络没起来就执行，导致命令失败；
- 部分 appliance 会在开机后重写网络配置；
- `.network` 配置方式更标准、更稳定。

---

## 5. 完成验收

- 重启网络服务或重启系统后，执行：
  ```bash
  ip route | egrep '<VPN_CIDR_A>|<VPN_CIDR_B>'
  ```
  仍能看到两条路由，即持久化成功。

## 参考资料

- [Photon OS 4 静态网络配置](https://vmware.github.io/photon/docs-v4/administration-guide/managing-network-configuration/setting-a-static-ip-address/)
