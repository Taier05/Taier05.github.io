# vCenter Web 控制台 Missing JWT 故障排查

> 适用场景：vCenter 8.x（VCSA）
> 现象：vSphere Client 打开虚拟机 **Web 控制台失败**，提示“无法与虚拟机 Web 控制台建立连接”。
> 本次环境：通过 **IP `<IP_ADDRESS>`** 访问 vCenter（不使用域名）。

---

## 1. 现象与关键线索

### 1.1 vSphere Client 现象
- 登录 vCenter UI 后，打开某主机/虚拟机的 **Web 控制台**报错：
  - **无法与虚拟机 Web 控制台建立连接**
- vCenter UI 首页提示：
  - **授权数据同步失败**
- UI 下方任务/告警还出现：
  - 插件/反向代理相关失败（例如 vSAN/LCM 插件下载/部署 503 等）

### 1.2 关键日志（rhttpproxy）
`/var/log/vmware/rhttpproxy/rhttpproxy.log` 频繁出现：
- `Missing JWT`
- `JWT verification failed`
- `URI: /clusters?uri=/extension-login`

这说明：**vCenter 反代链路/插件/鉴权 token（JWT）无法正确生成/校验或携带**，不是单纯 ESXi 902 端口网络问题。

---

## 2. 快速排除项（确认不是资源/磁盘）

### 2.1 磁盘与 inode
```bash
df -h
df -i
du -sh /storage/log /storage/core /storage/db 2>/dev/null
```
本次结果：空间/ inode 都正常（排除磁盘满导致服务起不来/超时）。

---

## 3. 核心定位：服务状态与“硬阻塞点”

### 3.1 HVC（Web 控制台后端）状态
HTML5 Web Console 依赖 `vmware-hvc`。若它不运行，控制台必挂。

```bash
/usr/lib/vmware-vmon/vmon-cli --status hvc
service-control --status vmware-hvc
```

本次看到：
- `hvc`：`STOPPED`，`HealthState: UNHEALTHY`，且 restart 会 **timeout**
- 这是控制台打不开的“硬阻塞点”之一

### 3.2 vpxd-svcs（invsvc/authz）状态
授权同步失败通常与 `vpxd-svcs`（inventory/authz）有关。

```bash
service-control --status vmware-vpxd-svcs
service-control --restart vmware-vpxd-svcs
```

本次看到：
- `vmware-vpxd-svcs`：**Stopped**
- 重启失败：`vmon-cli RC=4` / `A system error occurred`

### 3.3 vpxd.log 关键报错：invsvc 503 + 证书过期
查看 vpxd 相关日志：
```bash
tail -n 200 /var/log/vmware/vpxd/vpxd.log | egrep -i "invsvc|authz|loginBySamlToken|503|handshake|certificate expired|jwt|token|trust|failed"
```

本次关键命中：
- `loginBySamlToken ... code: 503(Service Unavailable)`（访问 `/invsvc/vmomi/sdk`）
- `Failed to connect to Authz service`
- `Failed to SSL handshake ... sslv3 alert certificate expired`

> 结论：**invsvc/authz 服务不可用（503）+ 内部 SSL 握手失败（证书过期）**
> 直接导致：授权数据同步失败、插件/反代失败、JWT 失败、Web 控制台失败。

---

## 4. 根因确认：Machine SSL 证书已过期

查看 Machine SSL 证书有效期：
```bash
/usr/lib/vmware-vmafd/bin/vecs-cli entry list --store MACHINE_SSL_CERT --text \
 | egrep -i "Not After|Subject:|Subject Alternative Name|IP Address|DNS:" -n
```

本次看到：
- `Not After : <EXPIRED_DATE>`（**已过期**）
- SAN 里包含 `IP Address:<IP_ADDRESS>`

> 证书过期会造成 vCenter 内部组件之间的 HTTPS/mTLS 互信失败 →
> `vpxd-svcs` 起不来 / `hvc` 起不来 / 授权数据同步失败 / rhttpproxy Missing JWT 等连锁问题。

---

## 5. 解决方案：重置全部证书（VMCA 统一重新签发）

> **高风险变更**：证书重置会影响 Machine SSL、Solution User、STS 及依赖 vCenter 信任链的外部产品。执行前应确认当前证书模式，在同一 SSO 域的所有 vCenter 节点上创建一致的离线快照或可恢复备份，并预留维护窗口。若使用外部 CA 或混合证书模式，应优先按 Broadcom 对应流程处理。

### 5.1 使用 certificate-manager 重置证书
执行：
```bash
/usr/lib/vmware-vmca/bin/certificate-manager
```

在菜单中选择：
- **8. Reset all Certificates**

然后选择：
- `Do you wish to generate all certificates using configuration file : Option[Y/N]?` → `y`

输入 SSO 管理员账号（示例）：
- `<ADMIN_ACCOUNT>`

按提示填写证书信息（示例）：
- Country：`CN`
- Name：`<ORGANIZATION>`
- Organization：`IT`
- State：`Guangdong`
- Locality：`Shenzhen`
- **IPAddress：`<IP_ADDRESS>`**（关键：保证你继续用 IP 访问）
- Hostname：填写 FQDN（例如 `<VCENTER_FQDN>`；工具要求 FQDN 不能填 IP）
- VMCA 'Name'：例如 `<ORGANIZATION>`（VMCA 根证书 CN 标识）

> 说明：你坚持“只用 IP 访问”是可以的。关键是 **SAN 里必须包含 `IP Address:<IP_ADDRESS>`**。
> Hostname 字段只是 DNS 类型 SAN/主机名信息，用 `<VCENTER_FQDN>` 即可。

### 5.2 证书重置完成后的服务重启（建议）
若工具未自动重启，可手动执行：
```bash
service-control --stop --all
service-control --start --all
```

> 注意：`service-control --restart` 一次只能重启一个服务；不要一次传多个服务名。

---

## 6. 修复后验证（必须做）

### 6.1 验证 Machine SSL 有效期与 SAN
```bash
/usr/lib/vmware-vmafd/bin/vecs-cli entry list --store MACHINE_SSL_CERT --text \
 | egrep -i "Not After|Subject Alternative Name|IP Address|DNS:" -n
```

本次修复后看到（示例）：
- `Not After : <NEW_EXPIRY_DATE>`（有效期已更新）
- SAN：`IP Address:<IP_ADDRESS>, DNS:<VCENTER_FQDN>`

### 6.2 验证关键服务恢复
```bash
service-control --status vmware-vpxd-svcs
service-control --status vmware-hvc
/usr/lib/vmware-vmon/vmon-cli --status hvc
```

期望：
- `vmware-vpxd-svcs`：Running
- `vmware-hvc`：Running

### 6.3 验证 JWT 错误是否消失（可选）
触发一次打开控制台后查看：
```bash
tail -n 200 /var/log/vmware/rhttpproxy/rhttpproxy.log | egrep -i "Missing JWT|JWT verification failed|extension-login|401|403"
```
正常情况下 `Missing JWT` 会显著减少/消失。

### 6.4 浏览器侧处理
证书变更后建议：
- 清理 `https://<IP_ADDRESS>` 站点缓存/Cookie/旧证书例外记录
- 无痕窗口重新登录测试一次

---

## 7. 结果
- vCenter UI 打开虚拟机 Web 控制台恢复正常
- “授权数据同步失败”随之消失/恢复
- `vpxd-svcs`、`hvc` 正常 Running
- rhttpproxy 不再持续刷 `Missing JWT`

---

## 8. 经验总结（以后快速定位）
遇到：
- 控制台打不开 + `Missing JWT`
- UI 提示“授权数据同步失败”
- 插件/反代 503

优先检查三件事：
1) **证书是否过期**
   - `vecs-cli ... MACHINE_SSL_CERT` 看 Not After
2) **vpxd-svcs 是否 Running**
   - 授权/Inventory/Authz 的关键组件
3) **hvc 是否 Running**
   - Web 控制台后端服务，Stopped 就必挂

若发现证书过期，应先确认当前证书模式、受影响证书范围和关联产品，再按 Broadcom 对应流程选择仅替换 Machine SSL 或重置全部证书；不要把 Option 8 当作所有场景的默认第一步。

## 官方参考

- [Broadcom：使用 vSphere Certificate Manager 替换证书](https://knowledge.broadcom.com/external/article/318946)
- [Broadcom：vCert 过期证书处理工具](https://knowledge.broadcom.com/external/article/385107)
