# 服务器 BMC 密码重置与固件升级安全手册

> 本文用于已获授权的服务器运维场景。示例中的用户 ID、密码、文件名和固件版本均为占位符，不对应任何真实环境。BMC 凭据重置和固件升级都可能影响带外管理能力；执行前应确认设备厂商、精确型号与硬件修订版，并准备物理控制台或其他回退入口。

BMC（Baseboard Management Controller）独立于主机操作系统，负责远程控制台、传感器、事件日志和电源管理。忘记 BMC 密码时，可以在具备本机管理员权限的操作系统中通过 IPMI 工具重置；固件升级则应优先使用设备厂商提供的管理界面、升级包和操作说明。

## 先确认操作边界

执行前至少确认以下事项：

- 已获得目标服务器和 BMC 的变更授权。
- 已通过资产标签、序列号或主板信息核对设备身份。
- 已确认厂商、服务器或主板型号，以及硬件 Revision。
- 已记录 BMC 网络配置、现有用户、告警与关键配置。
- 具备本地控制台、KVM 或现场人员等备用入口。
- 固件升级安排在维护窗口，并确认供电稳定。

不要把生产密码直接写入脚本、工单、聊天记录或 Git 仓库。本文也不使用任何真实密码作为示例。

## 方案一：使用通用 ipmitool 重置密码

`ipmitool` 适用于实现了标准 IPMI 接口的设备，通常比厂商专用工具更通用。以下命令需要在目标服务器本机以有权限的账户执行。

### 1. 检查本地 IPMI 设备

```bash
ls -l /dev/ipmi* /dev/ipmi/* 2>/dev/null
ipmitool mc info
```

如果找不到 IPMI 设备，应先检查内核模块、BIOS/BMC 设置和厂商支持情况，不要直接尝试未知工具。

### 2. 列出 BMC 用户

多数设备使用 Channel 1，但不同厂商可能不同：

```bash
ipmitool channel info 1
ipmitool user list 1
```

根据输出确认目标账号对应的用户 ID。不要默认管理员一定是 ID `2`，也不要误改其他服务账号。

### 3. 设置新密码

为避免密码进入 Shell 历史，可先静默读取到临时变量：

```bash
read -rsp 'New BMC password: ' BMC_PASSWORD
printf '\n'
ipmitool user set password <USER_ID> "$BMC_PASSWORD"
unset BMC_PASSWORD
```

密码仍会在命令执行期间作为进程参数短暂传递，因此应在受控的本机管理会话中操作，避免与不可信用户共享主机。密码应由密码管理器随机生成，并符合设备支持的长度和字符限制。

### 4. 验证并收尾

使用新密码登录 BMC Web 或远程管理接口，至少验证：

- 账号可以正常认证。
- HTML5 KVM 或远程控制台可打开。
- 传感器、SEL 日志和电源状态可读取。
- 原有自动化采集账号没有受到影响。

验证成功后，将新凭据放入受控的密码管理系统，并清理终端滚屏、临时变量和可能产生的操作记录副本。

## 方案二：使用 Supermicro IPMICFG

`IPMICFG` 是 Supermicro 提供的厂商工具，不应因为文件能够执行就假定它适用于其他品牌设备。优先从 [Supermicro 官方 IPMI Utilities 页面](https://www.supermicro.com/en/solutions/management-software/ipmi-utilities) 获取工具，并核对目标平台支持情况。

```bash
chmod 700 IPMICFG-Linux.x86_64
./IPMICFG-Linux.x86_64 -user list
```

确认目标用户 ID 后，再设置新密码：

```bash
read -rsp 'New BMC password: ' BMC_PASSWORD
printf '\n'
./IPMICFG-Linux.x86_64 -user setpwd <USER_ID> "$BMC_PASSWORD"
unset BMC_PASSWORD
```

Supermicro 官方 FAQ 给出的基本流程同样是先执行 `-user list`，再使用 `-user setpwd <USER_ID> <PASSWORD>`。如果设备不是 Supermicro，优先采用该厂商管理界面、官方工具或标准 `ipmitool`。

## 在 ESXi 上临时执行厂商工具

ESXi 的 `execInstalledOnly` 用于限制未经系统安装的二进制文件执行。将它设为 `0` 会临时降低主机安全保护，只能在维护授权下、确定工具来源和完整性后短时使用。

### 1. 记录当前状态

```bash
esxcli system settings advanced list -o /User/execInstalledOnly
```

如果当前值不是预期状态，应先停止操作并确认安全基线。

### 2. 校验工具并临时放开限制

```bash
sha256sum IPMICFG-Linux.x86_64
chmod 700 IPMICFG-Linux.x86_64
esxcli system settings advanced set -o /User/execInstalledOnly -i 0
```

哈希值必须与受信任来源提供的校验值一致。随后只执行必要的用户查询和密码修改操作。

### 3. 无论操作是否成功都立即恢复限制

```bash
esxcli system settings advanced set -o /User/execInstalledOnly -i 1
esxcli system settings advanced list -o /User/execInstalledOnly
```

不要把恢复安全限制留到“之后再做”。Broadcom 的 ESXi 安全故障文档也要求在异常关闭后将 `execInstalledOnly` 恢复为 `TRUE`。如果工具执行中断，应先恢复此设置，再继续排查。

## BMC 固件升级

固件包必须与厂商、精确型号和 Revision 一致。不同 Revision 即使名称接近，也可能使用不同的 BMC 映像。

### 升级前检查

1. 在设备管理页记录当前 BMC、BIOS 和 CPLD 版本。
2. 导出 BMC 配置，并记录网络、用户、LDAP、告警和证书设置。
3. 阅读升级包内的 Release Notes 和 README，确认升级路径及是否需要中间版本。
4. 从厂商支持页下载固件，校验文件大小、签名或 SHA-256。
5. 确认双路电源正常、供电稳定，并停止非必要的远程管理自动化。
6. 准备物理控制台或现场支持，避免升级失败后失去带外入口。

### 推荐升级方式

优先使用 BMC Web 管理界面的固件升级功能，因为它通常会检查映像类型与平台兼容性。如果升级包明确提供 Linux 工具，应严格按照包内说明执行，不要仅凭文件名直接运行未知脚本。

示例检查流程：

```bash
unzip -l <BMC_FIRMWARE_PACKAGE>.zip
sha256sum <BMC_FIRMWARE_PACKAGE>.zip
unzip <BMC_FIRMWARE_PACKAGE>.zip -d bmc-firmware
find bmc-firmware -maxdepth 2 -type f -print
```

只有在 README 明确要求时，才执行厂商升级程序：

```bash
cd bmc-firmware/<VERSION_DIRECTORY>
less README*
sudo bash <VENDOR_UPDATE_SCRIPT>.sh
```

升级期间不要断电、重启主机、关闭浏览器会话或中断升级进程。BMC 自身重启会导致管理页面和监控短时中断，但不应据此盲目重启业务操作系统。

### 升级后验证

- BMC 管理地址可达，Web 与远程控制台可正常登录。
- 固件版本与计划版本一致。
- 网络、用户、LDAP、证书和告警配置没有丢失。
- 温度、风扇、电源、磁盘等传感器读数正常。
- SEL 中没有新增的固件、供电或硬件异常。
- 监控平台重新获取到 BMC 指标。

## 常见失败与处理

### 用户 ID 或 Channel 不正确

不要反复尝试不同 ID。重新执行用户列表和 Channel 查询，并对照设备手册确认。

### 新密码被设备拒绝

旧平台可能限制密码长度或字符集。使用密码管理器重新生成符合厂商规则的随机密码，不要降级为可猜测的固定口令。

### ESXi 工具无法执行

先检查文件哈希、权限、CPU 架构和平台支持。若临时关闭过 `execInstalledOnly`，无论是否定位成功，都应先恢复为原值。

### 固件升级后管理地址不可达

等待 Release Notes 指定的重启时间，再通过本地控制台检查网络设置和 BMC 状态。不要连续断电或重复刷写；如果版本、校验或平台匹配存在疑问，应停止操作并联系厂商支持。

## 参考资料

- [Supermicro：IPMICFG 修改 IPMI 账号密码](https://www.supermicro.com/en/support/faqs/faq.php?faq=32161)
- [Supermicro：IPMI Utilities 官方下载页](https://www.supermicro.com/en/solutions/management-software/ipmi-utilities)
- [Broadcom：ESXi execInstalledOnly 安全配置相关说明](https://knowledge.broadcom.com/external/article/312109/esxi-boot-failures-due-to-system-configu.html)
- [GIGABYTE MZ72-HB2 产品与支持页面](https://www.gigabyte.com/Enterprise/Server-Motherboard/MZ72-HB2-rev-3x)
