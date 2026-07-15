# Linux 服务器病毒扫描与 KVRT 使用说明

## 背景与目标

在 Linux 服务器上进行恶意软件排查时，通常需要兼顾以下两类场景：

- 具备图形环境，可直接启动可视化查杀工具。
- 仅能通过终端登录，需要以命令行方式静默执行全盘扫描。

本文给出基于 Kaspersky Virus Removal Tool for Linux (`kvrt.run`) 的使用方法，并补充 `ClamAV` 作为 CentOS 等环境下的可选方案。

## 环境说明

- 适用对象：Linux 服务器
- 工具文件：`kvrt.run`
- 下载来源：

```bash
wget https://devbuilds.s.kaspersky-labs.com/kvrt_linux/latest/kvrt.run
```

## KVRT 使用步骤

### 1. 下载扫描工具

在可联网环境执行：

```bash
wget https://devbuilds.s.kaspersky-labs.com/kvrt_linux/latest/kvrt.run
```

如果目标服务器无法直接访问外网，可先在其他机器下载，再上传到目标 Linux 服务器。

### 2. 赋予执行权限

```bash
chmod +x kvrt.run
```

### 3. 执行扫描

#### 方案一：图形界面查杀

适用场景：

- 服务器具备桌面环境或 X11 转发能力
- 需要人工选择扫描范围或交互式处理风险项

执行命令：

```bash
./kvrt.run
```

说明：

- 启动后会弹出可视化界面进行杀毒操作。
- 该方式更适合临时人工排查，不适合批量自动化任务。

#### 方案二：命令行静默扫描

适用场景：

- 仅有 SSH 终端环境
- 需要无人值守执行
- 需要全盘扫描并减少交互

执行命令：

```bash
./kvrt.run -- -accepteula -silent -dontencrypt -allvolumes
```

参数说明：

- `-accepteula`：接受许可协议，避免交互阻塞。
- `-silent`：静默运行，适合远程终端或自动化执行。
- `-dontencrypt`：禁用加密处理，便于直接查看结果文件或扫描行为。
- `-allvolumes`：扫描所有卷，适用于全盘排查。

推荐建议：

- 服务器排查优先使用命令行静默模式。
- 若只做单机人工分析，且具备图形环境，可使用图形界面模式。

## 原始命令与注释保留

以下内容可直接作为操作参考：

```bash
wget https://devbuilds.s.kaspersky-labs.com/kvrt_linux/latest/kvrt.run


# 上传 kvrt.run 到linux服务器
# chmod +x kvrt.run
# ./kvrt.run  运行会弹出可视化界面杀毒
# 命令方式：./kvrt.run -- -accepteula -silent -dontencrypt -allvolumes

# 其他linux centos杀毒软件
# clamav
```

## 多方案与适用场景

### KVRT

适用场景：

- 临时应急查杀
- 需要快速获取并执行单文件扫描工具
- 需要图形模式与静默模式两种操作方式

特点：

- 部署简单，直接下载后授权执行即可。
- 更适合事件响应、手工巡检或一次性排查。

### ClamAV

适用场景：

- CentOS 或其他 Linux 发行版中需要常驻型开源查毒方案
- 需要与系统包管理、定时任务或日常巡检流程结合

选择建议：

- 如果目标是快速排查当前服务器是否存在恶意文件，优先使用 `KVRT`。
- 如果目标是建立长期查毒机制或纳入系统运维基线，可进一步评估 `ClamAV`。

## 注意事项

- `kvrt.run` 执行前需要具备可执行权限。
- 图形模式依赖图形界面环境；纯终端服务器通常应选择静默模式。
- 全盘扫描可能持续较长时间，建议在业务低峰期执行。
- 如果目标主机不能联网，应先在外部下载后再上传。
- 在生产环境执行前，应确认磁盘、CPU 与 I/O 资源余量，避免对在线业务造成明显影响。

## 常见问题与排查方式

### 无法执行 `kvrt.run`

检查项：

```bash
chmod +x kvrt.run
```

如果仍无法执行，进一步确认：

- 当前目录是否正确
- 文件是否完整上传
- 当前账户是否具备执行权限

### 图形界面无法弹出

可能原因：

- 当前服务器无桌面环境
- SSH 会话未启用图形转发

处理建议：

- 直接改用命令行静默模式：

```bash
./kvrt.run -- -accepteula -silent -dontencrypt -allvolumes
```

### 需要长期查毒方案

处理建议：

- 当前文档优先覆盖 `KVRT` 的应急使用方式。
- 若需要长期、周期性查毒，可将 `ClamAV` 作为后续标准化方案进行部署与维护。
