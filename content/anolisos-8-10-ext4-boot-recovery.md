# Anolis OS 8.10 启动失败：EXT4 修复与硬件排查

> 本文由一次实际启动故障处置整理而成，磁盘路径、UUID、PCI 地址和业务服务名均已泛化。文件系统修复会写入磁盘，误选设备或在文件系统已挂载时操作可能造成进一步损坏。生产环境应先确认备份、维护窗口和控制台入口；疑似硬件故障时，优先保护数据并在副本上分析。

一台安装 Anolis OS 8.10 的服务器启动后进入 dracut emergency shell，根文件系统检查失败。首次修复 EXT4 元数据后系统一度恢复，但重启又出现 block group descriptor checksum 和 inode bitmap 错误。这意味着排障不能停留在“反复执行 fsck”：需要区分文件系统的直接故障、修复后的系统文件问题，以及可能持续破坏数据的存储、内存、PCIe、供电或软件因素。

## 故障现象

启动阶段出现类似信息：

```text
Entering emergency mode.
Generating "/run/initramfs/rdsosreport.txt"
```

随后看到根分区检查失败：

```text
<ROOT_DEVICE> contains a file system with errors, check forced.
fsck failed with exit status 4.
Failed to start File System Check on <ROOT_DEVICE>.
Dependency failed for /sysroot.
```

`e2fsck` 返回码 `4` 表示仍有文件系统错误未修复。结合根设备无法挂载，可以判断本次无法进入系统的直接原因是 EXT4 元数据不一致。

现场还可能同时出现 systemd generator 或应用服务配置错误，例如：

```text
/usr/lib/systemd/system-generators/<GENERATOR> failed with exit status 127
<APPLICATION_SERVICE>.service: Invalid URL
```

这些错误需要在文件系统恢复后继续检查，但不能仅凭出现顺序就把它们判定为第一次启动失败的根因。文件损坏本身也可能导致二进制、动态库或配置内容异常。

## 处理原则

整个恢复过程遵循四条原则：

1. 先确认设备和文件系统类型，不能凭记忆套用分区名。
2. 文件系统必须处于未挂载状态，才执行有效且安全的检查或修复。
3. 先只读评估并尽量保留元数据证据，再执行写入式修复。
4. 修复后若很快再次损坏，停止反复 `fsck`，转向硬件与写入链路排查。

## 确认根设备和文件系统类型

在 initramfs 或救援环境中执行：

```bash
lsblk -o NAME,TYPE,FSTYPE,FSVER,SIZE,MOUNTPOINTS,UUID
blkid
cat /proc/cmdline
```

重点核对内核参数中的：

```text
root=UUID=<ROOT_UUID>
```

解析 UUID 对应的真实设备：

```bash
readlink -f /dev/disk/by-uuid/REPLACE_WITH_ROOT_UUID
```

后续示例统一使用变量，实际执行时必须替换为核对后的路径：

```bash
ROOT_DEVICE='/dev/disk/by-uuid/REPLACE_WITH_ROOT_UUID'
```

如果根文件系统位于 LUKS、LVM、MD RAID 或其他设备映射之上，应对承载 EXT4 的逻辑设备执行检查，例如 `/dev/mapper/REPLACE_WITH_ROOT_LV`，不能直接对底层 PV、RAID 成员盘或加密容器运行 `e2fsck`。

还要先确认文件系统确实是 EXT2、EXT3 或 EXT4：

```bash
blkid "$ROOT_DEVICE"
```

如果实际为 XFS，应使用 XFS 对应的检查与恢复流程，不能运行 `e2fsck`。

## 确认文件系统没有挂载

检查设备和常见的系统根挂载点：

```bash
findmnt --source "$ROOT_DEVICE"
findmnt /sysroot
findmnt /mnt/sysroot
lsblk -o NAME,FSTYPE,MOUNTPOINTS
```

发现目标文件系统已挂载时，应先退出使用该挂载点的进程并安全卸载。不要把“命令没有输出”当作唯一依据，要同时核对 `findmnt` 和 `lsblk`。

`e2fsck` 官方手册明确说明，通常不能在已挂载文件系统上运行。即使使用 `-n` 不写入，挂载期间得到的检查结果也可能无效。

## 修复前保留证据

如果存在另一块健康磁盘、外接介质或已确认可写的网络位置，可以先保存 EXT4 元数据镜像：

```bash
mkdir -p /mnt/recovery
e2image -Q "$ROOT_DEVICE" /mnt/recovery/root-before-repair.e2i
sha256sum /mnt/recovery/root-before-repair.e2i
```

`/mnt/recovery` 必须位于其他健康文件系统，不能放在正在修复的根文件系统中。元数据镜像可能包含目录名、文件名和其他环境信息，应限制访问权限并按敏感证据保存。

如果读取设备时持续出现 I/O error、timeout、controller reset，或设备反复离线，不要继续在原盘上写入式修复。此时应优先制作可恢复副本或联系存储、硬件支持人员。

## 先进行只读检查

确认设备正确且未挂载后执行：

```bash
e2fsck -f -n "$ROOT_DEVICE"
check_rc=$?
printf 'e2fsck read-only exit code: %s\n' "$check_rc"
```

参数含义：

- `-f`：即使文件系统看起来 clean，也执行完整检查。
- `-n`：所有修复问题都回答 no，不写入文件系统。

只读检查的后续阶段可能报告一些在真正修复时会被前序阶段消除的问题，因此不要仅按报错条数估算损坏程度。需要结合错误类型、设备日志和备份情况制定修复方案。

## 执行受控修复

优先使用预自动修复模式：

```bash
e2fsck -p "$ROOT_DEVICE"
repair_rc=$?
printf 'e2fsck repair exit code: %s\n' "$repair_rc"
```

`-p` 只自动处理可以安全修复的问题；遇到需要管理员判断的损坏时会停止，并通过输出和返回码提示。相比对所有问题一律回答 yes 的 `-y`，它更适合作为生产恢复的第一步。

常见返回码如下：

| 返回码 | 含义 |
| --- | --- |
| `0` | 没有错误 |
| `1` | 文件系统错误已修复 |
| `2` | 错误已修复，系统应重启 |
| `4` | 仍有文件系统错误未修复 |
| `8` | 工具或设备操作错误 |
| `16` | 用法或参数错误 |
| `32` | 检查被用户取消 |
| `128` | 共享库错误 |

返回码可能是多个条件之和，判断时应同时阅读完整输出。`1` 或 `2` 不等于修复失败；`4` 或包含 `4` 的组合值表示仍有未解决的文件系统问题。

如果 `-p` 要求人工处理，应先保存完整输出，由熟悉 EXT4 和业务数据的人员评估，再使用交互模式：

```bash
e2fsck -f "$ROOT_DEVICE"
```

不要把以下命令作为默认操作：

```bash
e2fsck -f -y "$ROOT_DEVICE"
```

`-y` 会对所有修复问题自动回答 yes。只有在设备已核对、证据和备份已保留、接受潜在数据丢失，并经过明确变更授权时才考虑使用。

## 从 GRUB 进入 pre-mount 环境

系统没有自动进入 emergency shell 时，可以在 GRUB 中手工设置断点：

1. 在启动菜单选中目标内核并按 `e`。
2. 找到以 `linux` 或 `linuxefi` 开头的内核参数行。
3. 在行尾追加：

```text
rd.break=pre-mount
```

4. 按 `Ctrl`+`x` 启动。

`rd.break=pre-mount` 是 dracut 支持的断点，会在根文件系统挂载阶段前进入 shell。不同磁盘栈和 initramfs 内容可能导致设备尚未组装，或者没有包含 `e2fsck`。遇到这种情况，应使用 Anolis OS 安装介质的 Rescue 环境，并重新核对 LUKS、LVM 或 RAID 映射。

进入 shell 后重复以下检查，不能因为使用了 pre-mount 就省略：

```bash
lsblk -o NAME,TYPE,FSTYPE,MOUNTPOINTS,UUID
findmnt /sysroot
findmnt /mnt/sysroot
```

## 修复后的静态验证

修复完成后再次进行只读完整检查：

```bash
e2fsck -f -n "$ROOT_DEVICE"
verify_rc=$?
printf 'e2fsck verification exit code: %s\n' "$verify_rc"
```

理想结果是返回 `0`，且输出不再包含未修复错误。如果返回 `1`、`2` 或 `4`，要重新阅读输出，不要只看最后一句。

`e2fsck` 只能验证和修复文件系统元数据一致性，不能证明每个业务文件内容正确，也不是数据恢复工具。系统能够启动后还需要校验关键软件包、配置、数据库和业务数据。

## 文件系统再次损坏时停止反复修复

如果出现以下链路，应把它视为持续性风险：

```text
修复后只读检查返回 0
        ↓
重新启动或短时间运行
        ↓
再次出现 descriptor checksum、bitmap 或 metadata 错误
```

可能原因包括但不限于：

- NVMe 介质、控制器或固件异常。
- PCIe 链路出现 AER、reset、timeout 或掉盘。
- 内存错误导致待写入的数据或元数据被破坏。
- 供电、主板或散热不稳定。
- 内核、驱动或存储软件缺陷。
- 不正常断电、强制复位或其他非预期写入中断。

一次 `e2fsck` clean 或一份 SMART 正常报告都不能单独排除这些问题。继续反复写入原盘可能覆盖恢复线索或扩大数据损失，应先保护数据、降低写入并收集证据。

## 检查 NVMe、PCIe 和内核日志

在当前启动环境检查内核信息：

```bash
dmesg -T | grep -iE 'nvme|pcie|aer|i/o error|timeout|reset|abort|corrupt|ext4-fs error'
```

系统恢复后，如果持久化日志可用，还应检查上一次启动：

```bash
journalctl -k -b -1 --no-pager \
  | grep -iE 'nvme|pcie|aer|i/o error|timeout|reset|abort|corrupt|ext4-fs error'
```

查看 NVMe 健康与错误日志：

```bash
smartctl -x /dev/nvme0
nvme smart-log /dev/nvme0
nvme error-log /dev/nvme0
```

重点关注：

- `Critical Warning`
- `Available Spare`
- `Percentage Used`
- `Media and Data Integrity Errors`
- `Error Information Log Entries`
- 控制器 reset、timeout、AER 和 I/O error

设备路径应以 `lsblk`、`nvme list` 和实际控制器拓扑为准。没有发现 I/O error 只能说明已采集日志中没有直接证据，不能据此断言硬件完全健康。

## 检查内存和平台稳定性

在维护窗口通过 Memtest86+、MemTest86 或服务器厂商诊断工具进行完整内存测试。至少完成一个完整 Pass；只要出现非零错误，就不能忽略。

同时检查：

- BMC SEL 中的 ECC、PCIe、掉电、温度和电源告警。
- 内核 EDAC/MCE/RAS 日志。
- NVMe、BIOS、BMC 和主板固件的已知问题与兼容性。
- 设备温度、插槽接触、背板、线缆和双路电源状态。

如果错误只在特定内核或驱动版本下复现，还需要把软件回归纳入调查，不能把所有重复损坏都简单归因于 SSD。

## 文件系统正常后排查 systemd 和图形界面

当 EXT4 已通过检查、根文件系统能够稳定挂载，但系统仍卡在图形启动阶段时，可以在 GRUB 内核参数末尾临时追加：

```text
systemd.unit=multi-user.target
```

进入纯命令行目标后执行：

```bash
systemctl --failed --no-pager
systemctl get-default
systemctl status gdm --no-pager -l
systemctl status graphical.target --no-pager -l
journalctl -b -p err..alert --no-pager
```

对于 generator 返回 `127` 的问题，检查文件是否存在、解释器和依赖是否完整，以及它属于哪个软件包：

```bash
file /usr/lib/systemd/system-generators/REPLACE_WITH_GENERATOR
rpm -qf /usr/lib/systemd/system-generators/REPLACE_WITH_GENERATOR
```

对于服务单元中的 URL 或语法错误，使用实际服务名检查：

```bash
systemctl cat REPLACE_WITH_APPLICATION_SERVICE.service
systemd-analyze verify /etc/systemd/system/REPLACE_WITH_APPLICATION_SERVICE.service
```

这里的尖括号表示占位符，执行前必须替换。不要因为单个非关键服务失败就反复修改根文件系统；先确认它是否处于启动关键路径。

## 推荐处置流程

```text
确认根设备、映射层和文件系统类型
        ↓
确认 EXT4 未挂载
        ↓
保存元数据镜像与现场日志
        ↓
e2fsck -f -n 只读评估
        ↓
e2fsck -p 受控修复
        ↓
再次只读检查并解释返回码
        ↓
重启并验证系统、软件包和业务数据
        ↓
若短时间内再次损坏，停止反复 fsck
        ↓
保护数据，排查 NVMe / 内存 / PCIe / 供电 / 内核驱动
        ↓
若文件系统稳定但图形界面失败，再排查 systemd / GDM
```

## 关键结论

- 首次无法挂载 `/sysroot` 的直接原因是根 EXT4 文件系统存在未修复错误。
- 文件系统损坏是一项现场事实，但它本身不等同于底层根因。
- `e2fsck` 保证的是元数据一致性，不保证文件内容和业务数据完整。
- 修复后迅速复发是重要证据，应优先排查持续破坏写入的硬件或软件链路。
- SMART 没有明显错误不能排除内存、PCIe、供电、固件和间歇性设备问题。
- systemd generator、GDM 或应用配置问题应在文件系统稳定后分层处理。

## 参考资料

- [Anolis OS 8.10 官方镜像目录](https://mirrors.openanolis.cn/anolis/8.10/)
- [e2fsck(8) 官方手册页](https://man7.org/linux/man-pages/man8/e2fsck.8.html)
- [Red Hat Enterprise Linux 8：检查与修复文件系统](https://docs.redhat.com/en/documentation/red_hat_enterprise_linux/8/html-single/managing_file_systems/index)
- [dracut.cmdline(7)：rd.break 启动断点](https://man7.org/linux/man-pages/man7/dracut.cmdline.7.html)
