# OpenVPN 多场景部署与安全运维手册

> 安全提示：本文已移除真实人员名称、现网公网地址、业务网段和网关。新部署优先使用 AEAD 数据加密并禁用压缩；明文密码文件校验脚本仅作为旧环境兼容示例，生产环境应接入 PAM、LDAP、RADIUS、OIDC 或其他支持哈希及集中吊销的认证体系。修改路由、防火墙或默认出口前必须准备带外访问和回滚方案。

## 背景与目标

本文档用于在 Linux 服务器上部署基于 OpenVPN 的远程接入服务，覆盖以下几类典型场景：

- 内网互通：客户端仅访问指定内网网段，其他流量仍走本地网络。
- 外网跳板：客户端全部流量经 VPN 转发，适合作为统一出口或临时跳板。
- 多环境独立实例：不同业务环境使用独立配置、独立网段或独立客户端配置文件。
- 客户端接入审计：基于账号密码认证，并可在连接和断开时执行通知脚本。

下文同时保留旧环境的兼容思路；新部署示例使用 `tun`、AEAD 数据加密、禁用压缩，并以 `.ovpn` 单文件分发客户端配置。传输层可按网络条件选择 UDP 或 TCP。

## 环境说明

服务端环境以 CentOS/RHEL 系为主，安装方式如下：

```bash
yum -y install openvpn easy-rsa
```

Easy-RSA 初始化目录示例：

```bash
rpm -ql easy-rsa
mkdir -p /etc/openvpn/easy-rsa
cp /usr/share/doc/easy-rsa/vars.example /etc/openvpn/easy-rsa/vars
cp -r /usr/share/easy-rsa/3.2.1/* /etc/openvpn/easy-rsa/
cd /etc/openvpn/easy-rsa
./easyrsa init-pki
```

## 典型云网络拓扑

### VPC 对等连接

![OpenVPN 通过 VPC 对等连接访问多个 VPC](/assets/images/openvpn-vpc-peering.png "VPC 对等连接场景：每个目标 VPC 都需要独立对等连接和 VPN 地址池回程路由")

### 云企业网 CEN / 转发路由器

![OpenVPN 通过云企业网访问多个 VPC](/assets/images/openvpn-cen-tr.png "CEN/TR 场景：集中发布 VPN 地址池路由，并在目标安全组中允许该网段")

## 证书与密钥生成

按以下顺序生成服务端所需材料：

```bash
cd /etc/openvpn/easy-rsa
./easyrsa build-ca  #输入两次密码后按提示填写并妥善保管 CA 口令
./easyrsa gen-req server nopass
./easyrsa sign server server  #回车后输入yes，还需输入之前创建CA根证书设置的密码
./easyrsa gen-dh
cd /etc/openvpn/easy-rsa/pki
openvpn --genkey secret ta.key
```

## 服务端基础配置

`/etc/openvpn/server.conf`

### 方案一：内网互通

适用场景：

- 仅需访问指定内网网段。
- 不希望客户端默认流量全部经过 VPN。
- 常用于办公网、IDC 私网、ESXi 管理网等定向访问。

配置

```conf
port 1194
proto tcp
dev tun
user openvpn
group openvpn

#相关证书配置路径
ca /etc/openvpn/easy-rsa/pki/ca.crt
cert /etc/openvpn/easy-rsa/pki/issued/server.crt
key /etc/openvpn/easy-rsa/pki/private/server.key
dh /etc/openvpn/easy-rsa/pki/dh.pem
tls-auth /etc/openvpn/easy-rsa/pki/ta.key 0

#配置网络信息  如果内部有防火墙，一定要放开这个IP
server 10.8.0.0 255.255.255.0

#配置账号密码的认证方式
auth-user-pass-verify /etc/openvpn/checkpwd.sh via-file    # 密码验证脚本
script-security 3
verify-client-cert none
username-as-common-name
# client-to-client  # 仅在明确允许 VPN 客户端互访时启用
# duplicate-cn      # 默认不启用，避免同一身份并发复用

#为客户端推送路由，目标是以下网段的流量才走vpn线路
push "route 10.20.0.0 255.255.0.0"
push "route 10.30.0.0 255.255.0.0"
push "route 198.51.100.10 255.255.255.255"

allow-compression no
data-ciphers AES-256-GCM:AES-128-GCM
keepalive 10 120
persist-key
persist-tun
verb 3

log-append /etc/openvpn/logs/openvpn.log
status /etc/openvpn/logs/openvpn-status.log

# client-connect /etc/openvpn/connect.sh           # 新连接连接时执行脚本
# client-disconnect /etc/openvpn/disconnect.sh     # 有连接退出时执行脚本
```

选择建议：

- 当不同业务环境网段存在冲突时，优先为每个实例分配独立的 VPN 地址池，例如 `10.8.0.0/24`、`10.9.0.0/24`。
- 若客户端只需访问少量网段，尽量按网段精确推送路由，避免把无关流量导入 VPN。

### 方案二：外网跳板

适用场景：

- 客户端需要统一从 VPN 服务端出口访问外网。
- 需要临时借助境内或云主机网络出口访问目标系统。
- 需要对客户端 DNS 做统一控制。

配置要点：

`/etc/openvpn/server.conf`中添加

```conf
port 1194
proto tcp
dev tun
user openvpn
group openvpn

#相关证书配置路径
ca /etc/openvpn/easy-rsa/pki/ca.crt
cert /etc/openvpn/easy-rsa/pki/issued/server.crt
key /etc/openvpn/easy-rsa/pki/private/server.key
dh /etc/openvpn/easy-rsa/pki/dh.pem
tls-auth /etc/openvpn/easy-rsa/pki/ta.key 0

#配置网络信息  如果内部有防火墙，一定要放开这个IP
server 10.8.0.0 255.255.255.0

#配置账号密码的认证方式
auth-user-pass-verify /etc/openvpn/checkpwd.sh via-file    # 密码验证脚本
script-security 3
verify-client-cert none
username-as-common-name
# client-to-client  # 仅在明确允许 VPN 客户端互访时启用
# duplicate-cn      # 默认不启用，避免同一身份并发复用

#为客户端推送路由
push "redirect-gateway def1 bypass-dhcp"  # 关键：将所有流量重定向到VPN
push "dhcp-option DNS 114.114.114.114"  # 可选：指定DNS
push "dhcp-option DNS 8.8.8.8"

allow-compression no
data-ciphers AES-256-GCM:AES-128-GCM
keepalive 10 120
persist-key
persist-tun
verb 3

log-append /etc/openvpn/logs/openvpn.log
status /etc/openvpn/logs/openvpn-status.log

# client-connect /etc/openvpn/connect.sh           # 新连接连接时执行脚本
# client-disconnect /etc/openvpn/disconnect.sh     # 有连接退出时执行脚本
```

选择建议：

- `redirect-gateway` 会接管客户端默认路由，应只用于跳板或统一出口场景。
- 若客户端所在办公网与服务端推送网段冲突，优先在客户端使用 `pull-filter ignore` 精准忽略特定路由，而不是直接删除服务端推送策略。

## 账号密码认证

密码文件示例：

`/etc/openvpn/pwd-file`

```text
user-a replace-with-strong-password
user-b replace-with-strong-password
user-c replace-with-strong-password
```

推荐校验脚本如下：

`/etc/openvpn/checkpwd.sh`

```bash
#!/bin/bash
PASSFILE="/etc/openvpn/pwd-file"
LOG_FILE="/etc/openvpn/logs/openvpn-password.log"
TIME_STAMP=$(date "+%Y-%m-%d %T")

readarray -t lines < "$1"
username=${lines[0]}
password=${lines[1]}

if [ ! -r "${PASSFILE}" ]; then
  echo "${TIME_STAMP}: Could not open password file \"${PASSFILE}\" for reading." >> "${LOG_FILE}"
  exit 1
fi

CORRECT_PASSWORD=$(awk '!/^;/&&!/^#/&&$1=="'"${username}"'"{print $2;exit}' "${PASSFILE}")
if [ -z "${CORRECT_PASSWORD}" ]; then
  echo "${TIME_STAMP}: User does not exist: username=\"${username}\"." >> "${LOG_FILE}"
  exit 1
fi

if [ "${password}" = "${CORRECT_PASSWORD}" ]; then
  echo "${TIME_STAMP}: Successful authentication: username=\"${username}\"." >> "${LOG_FILE}"
  exit 0
fi

echo "${TIME_STAMP}: Incorrect password: username=\"${username}\"." >> "${LOG_FILE}"
exit 1
```

```bash
chmod +x /etc/openvpn/checkpwd.sh
```

注意：

- 不建议在认证失败日志中记录明文密码。
- 现有账号文件中包含多个环境账号清单，实际部署时应按实例拆分，避免所有环境共用同一份完整账号列表。

## 客户端配置

推荐客户端模板：

`客户端配置.ovpn`

```conf
client
proto tcp
dev tun
auth-user-pass
remote <服务端公网IP> 1194
tls-auth ta.key 1
remote-cert-tls server
data-ciphers AES-256-GCM:AES-128-GCM
auth-nocache
persist-key
persist-tun
allow-compression no
verb 3

<ca>
#此处粘贴/etc/openvpn/easy-rsa/pki/ca.crt复制的内容
</ca>

<tls-auth>
#此处粘贴在/etc/openvpn/easy-rsa/pki/ta.key复制的内容
</tls-auth>
key-direction 1
```

客户端分发建议：

- Windows 可直接导入 `.ovpn` 或放入 `C:\Program Files\OpenVPN\config`。

  - openvpn客户端官方下载连接

    https://openvpn.net/community-downloads/

- macOS 可使用 Tunnelblick。

  - macos端下载

    https://tunnelblick.net/

- 安装 OpenVPN GUI 时如提示安装 TAP 驱动，应允许安装。

## 办公网络冲突规避客户端

适用场景：

- 客户端本地网络与服务端推送路由重叠。
- 仅需使用 VPN 的部分路由，不希望影响本地办公网络访问。

客户端示例：

`客户端配置.ovpn`中添加

```conf
pull-filter ignore "route 192.168.100.0 255.255.255.0"
pull-filter ignore "route 192.168.200.0 255.255.255.0"
pull-filter ignore "route 172.31.0.0 255.255.0.0"
```

说明：

- 该方案适合保留服务端统一配置，同时为特定客户端做差异化规避。
- 现有样例中第三条 `pull-filter ignore` 的网段与掩码写法混杂，正式使用时应与服务端下发格式保持一致。

完整示例：

`客户端配置.ovpn`

```bash
client
proto tcp
dev tun
auth-user-pass
remote <服务端公网IP> 1194

pull-filter ignore "route 192.168.100.0 255.255.255.0"
pull-filter ignore "route 192.168.200.0 255.255.255.0"
pull-filter ignore "route 172.31.0.0 255.255.0.0"

tls-auth ta.key 1
remote-cert-tls server
data-ciphers AES-256-GCM:AES-128-GCM
auth-nocache
persist-key
persist-tun
allow-compression no
verb 3

<ca>
#此处粘贴/etc/openvpn/easy-rsa/pki/ca.crt复制的内容
</ca>

<tls-auth>
#此处粘贴在/etc/openvpn/easy-rsa/pki/ta.key复制的内容
</tls-auth>
key-direction 1
```

## 可选的连接通知脚本

若需要在客户端上线或下线时发送通知，可启用：

```conf
client-connect /etc/openvpn/connect.sh
client-disconnect /etc/openvpn/disconnect.sh
```

推荐脚本写法如下：

```bash
#!/bin/bash

DINGTALK_WEBHOOK="https://oapi.dingtalk.com/robot/send?access_token=<token>"
curl -sS "${DINGTALK_WEBHOOK}" \
  -H 'Content-Type: application/json' \
  -d "{
    \"msgtype\": \"text\",
    \"text\": {
      \"content\": \"openvpn发现新连接: ${common_name}[${trusted_ip}:${trusted_port}] -> $(hostname -s)[${ifconfig_pool_remote_ip}] [$(date '+%H:%M:%S')]\"
    }
  }" >/dev/null
```

下线脚本仅需调整通知内容即可。

注意：

- 现有脚本中的 JSON 末尾存在多余逗号，严格来说不是合法 JSON，应去除。
- 不应将机器人 Token 直接硬编码进长期保存的脚本，建议改为环境变量或单独权限受控的配置文件。

## 系统配置与服务启动

启用 IP 转发：

```bash
printf 'net.ipv4.ip_forward = 1\n' > /etc/sysctl.d/99-openvpn-forward.conf
sysctl --system
```

开放防火墙端口：

```bash
firewall-cmd --zone=public --add-port=1194/tcp --permanent
firewall-cmd --reload
firewall-cmd --list-all
```

如内网主机需要访问 VPN 客户端地址段，还需放行 VPN 网段，例如：

```bash
firewall-cmd --permanent --add-rich-rule='rule family="ipv4" source address="10.8.0.0/24" accept'
firewall-cmd --reload
```

Systemd 服务文件示例：

```ini
[Unit]
Description=OpenVPN service for %I
After=network.target

[Service]
Type=simple
ExecStart=/usr/sbin/openvpn --config /etc/openvpn/%i.conf
Restart=on-failure
User=root
Group=root

[Install]
WantedBy=multi-user.target
```

常用命令：

```bash
mkdir -p /etc/openvpn/logs   # 需要先创建目录再启动服务
systemctl start openvpn@server
systemctl status openvpn@server
systemctl stop openvpn@server
systemctl enable openvpn@server
systemctl restart openvpn@server
```

## 路由与互通配置

如果内网其他主机也要访问 VPN 客户端地址段，需要在网关或上游设备添加静态路由。

路由器示例：

- 目的地址：`10.8.0.0`
- 掩码：`255.255.255.0`
- 网关：`<OpenVPN 服务器内网 IP>`

Linux 示例：

```bash
dnf install net-tools -y
route add -net 10.8.0.0 netmask 255.255.255.0 gw <OPENVPN_GATEWAY_IP>
route del -net 10.8.0.0 netmask 255.255.255.0 gw <OPENVPN_GATEWAY_IP>

ip route add 10.8.0.0/24 via <VPN_GATEWAY_A> dev ens34
ip route add 10.9.0.0/24 via <VPN_GATEWAY_B> dev ens34
ip route del 10.8.0.0/24 via <VPN_GATEWAY_A> dev ens34
```

ESXi 示例：

```bash
esxcli network ip route ipv4 add --network 10.8.0.0/24 --gateway <VPN_GATEWAY_A>
esxcli network ip route ipv4 add --network 10.9.0.0/24 --gateway <VPN_GATEWAY_B>
esxcli network ip route ipv4 remove --network=10.8.0.0/24 --gateway=<VPN_GATEWAY_A>
esxcli network ip route ipv4 list
```

## 管理接口

启用管理接口：

```conf
vim /etc/openvpn/server.conf
management 127.0.0.1 7505

systemctl restart openvpn@server.service
```

连接方式：

```bash
nc 127.0.0.1 7505
```

常用命令：

```text
status
kill USER
```

用途：

- 查看在线用户与虚拟 IP 分配情况。
- 主动断开指定账号连接。

## 常见问题与排查

### 服务启动失败

排查顺序：

1. 查看 `systemctl status openvpn@server`。
2. 查看 `/etc/openvpn/logs/openvpn.log` 或 `/var/log/openvpn/server.log`。
3. 检查证书路径、脚本路径、配置文件名与 systemd 实例名是否匹配。

重点检查项：

- `checkpwd.sh` 是否有执行权限。
- `auth-user-pass-verify` 的路径与 `via-file`/`via-env` 是否和脚本实现一致。
- 日志目录是否已提前创建。

### 客户端能连上但访问不到内网

优先检查：

- 服务端是否已正确 `push route`。
- 服务端是否开启 `net.ipv4.ip_forward=1`。
- 服务端及内网网关是否已为 `10.8.0.0/24` 或 `10.9.0.0/24` 配置回程路由。
- 内网防火墙是否已放行 VPN 网段。

### 客户端连接超时

优先检查：

- 服务器防火墙是否已放行 `1194/tcp`。
- 云厂商安全组或控制台 ACL 是否允许对应端口。
- 客户端 `remote` 地址与端口是否正确，尤其注意 `备用实例` 环境使用 `1195`。

### 连接后本地办公网异常

原因通常为服务端推送路由与本地网段冲突。

处理建议：

- 若只需访问特定内网，使用“内网互通”方案，不要启用 `redirect-gateway`。
- 若必须使用统一服务端配置，可在客户端加入 `pull-filter ignore`，仅忽略冲突路由。

### 压缩参数不兼容

旧环境可能同时出现 `comp-lzo` 与 `compress lzo`。这些选项已弃用且会增加压缩侧信道风险；新配置应删除两者，并在客户端和服务端统一使用 `allow-compression no`。

## 运维建议

- 每个业务环境建议使用独立配置文件、独立地址池和独立客户端分发文件。
- 账号文件、通知脚本凭据、证书私钥应最小权限保存，避免直接提交到代码仓库。
- 多个环境若路由策略完全不同，优先拆分为独立实例，不建议在单实例中堆叠大量互斥路由策略。
- 保持 `duplicate-cn` 禁用，并为每个用户或终端分配独立身份，便于审计、吊销和限制并发。

## 参考资料

- [OpenVPN 2.6 官方手册](https://openvpn.net/community-docs/community-articles/openvpn-2-6-manual.html)
