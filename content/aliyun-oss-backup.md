# 阿里云 OSS 文件传输与备份操作手册

## 背景与目标

本文用于规范服务器侧通过 `ossutil` 向阿里云 OSS 执行文件上传、下载、目录同步与结果校验的操作流程，适用于备份归档、文件分发和对象存储日常维护场景。

## 环境说明

- 操作系统：Linux 服务器
- 工具：`ossutil 2.x`
- 典型数据路径：`/BF/xtrabackup/`
- 典型 Bucket：`oss://example-backup/`

使用前需确认以下信息：

- `AccessKey ID`
- `AccessKey Secret`
- Bucket 所在地域，例如 `cn-hangzhou`
- 对应 Endpoint

实践建议：

- 优先使用具备最小权限的 RAM 子账号，不建议长期使用主账号密钥。
- `ossutil 2.x` 默认使用 V4 签名，`region` 应正确配置，否则可能报错 `region must be set in sign version 4`。
- ECS 与 OSS 同地域时优先使用内网 Endpoint，以降低流量成本并提升传输速度。

## 安装 `ossutil`

### 推荐方式：官方安装脚本

适用场景：服务器可直接访问阿里云公共下载地址，且希望快速完成安装。

```shell
sudo yum install -y unzip
sudo -v
curl https://gosspublic.alicdn.com/ossutil/install.sh | sudo bash
ossutil version
```

说明：

- 安装完成后通常可直接使用 `ossutil` 命令。
- 若系统 PATH 未立即生效，可重新登录 shell 后再验证版本。

### 备用方式：手工下载并安装

适用场景：无法直接使用安装脚本，或需要手工控制安装过程。

```shell
sudo yum install -y unzip
curl -o ossutil-2.2.0-linux-amd64.zip https://gosspublic.alicdn.com/ossutil/v2/2.2.0/ossutil-2.2.0-linux-amd64.zip
unzip ossutil-2.2.0-linux-amd64.zip
cd ossutil-2.2.0-linux-amd64
chmod 755 ossutil
sudo mv ossutil /usr/local/bin/
sudo ln -s /usr/local/bin/ossutil /usr/bin/ossutil
ossutil version
```

说明：

- 若 `/usr/bin/ossutil` 已存在，可省略软链接步骤。
- 离线环境可先在可联网机器下载压缩包，再传至目标服务器安装。

## 凭证与连接配置

首次使用执行：

```shell
ossutil config
```

关键配置项说明：

- `AccessKey ID`：访问 OSS 的账号标识
- `AccessKey Secret`：对应密钥
- `Region`：Bucket 地域，例如 `cn-hangzhou`
- `Endpoint`：访问入口地址，可按网络环境选择

Endpoint 选择建议：

### 内网 Endpoint

适用场景：ECS 与 OSS 位于同地域，且通过阿里云内网访问。

```text
https://oss-cn-hangzhou-internal.aliyuncs.com
```

优势：

- 速度更稳定
- 流量成本更低

### 公网 Endpoint

适用场景：非阿里云内网环境，或跨公网访问 OSS。

```text
https://oss-cn-hangzhou.aliyuncs.com
```

注意：

- `endpoint` 必须与 Bucket 实际地域一致。
- Bucket 地域不匹配时，常见报错为 `The bucket you are attempting to access must be addressed using the specified endpoint`。

## 单文件上传与下载

### 上传单文件

适用场景：备份包、压缩文件、单个制品归档。

```shell
ossutil cp /BF/xtrabackup/2025-12-11/2025-12-11-full.tar.zst \
  oss://example-backup/site-a/2025-12-11/2025-12-11-full.tar.zst
```

后台上传：

```shell
nohup ossutil cp \
  /BF/xtrabackup/2025-12-11/2025-12-11-full.tar.zst \
  oss://example-backup/site-a/2025-12-11/2025-12-11-full.tar.zst \
  > /opt/xtrabackup-upload.log 2>&1 &
```

查看日志：

```shell
tail -f /opt/xtrabackup-upload.log
```

### 下载单文件

适用场景：恢复备份、回拉单个对象到本地服务器。

```shell
ossutil cp \
  oss://example-backup/site-a/2025-12-11/2025-12-11-full.tar.zst \
  /BF/xtrabackup/2025-12-11/2025-12-11-full.tar.zst
```

后台下载：

```shell
nohup ossutil cp \
  oss://example-backup/site-a/2025-12-11/2025-12-11-full.tar.zst \
  /BF/xtrabackup/2025-12-11/2025-12-11-full.tar.zst \
  > /opt/xtrabackup-download.log 2>&1 &
```

## 目录传输方案

### 方案一：`cp -r` 递归上传

适用场景：一次性上传整个目录，对历史对象是否变化不敏感。

```shell
ossutil cp -r /BF/xtrabackup/2025-12-11/ \
  oss://example-backup/site-a/2025-12-11/
```

特点：

- 命令直接
- 适合初次上传完整目录

### 方案二：`sync` 目录同步

适用场景：需要重复执行、增量更新、长期同步目录内容。

```shell
ossutil sync /BF/xtrabackup/2025-12-11/ \
  oss://example-backup/site-a/2025-12-11/
```

特点：

- 更适合持续同步
- 重复执行更方便

选择建议：

- 首次整体上传可优先使用 `cp -r`。
- 周期性备份同步、补传和增量更新建议使用 `sync`。

## 传输后校验

对象传输完成后，建议至少完成以下检查。

### 列出对象

```shell
ossutil ls oss://example-backup/site-a/2025-12-11/
```

### 查看对象属性

```shell
ossutil stat oss://example-backup/site-a/2025-12-11/2025-12-11-full.tar.zst
```

### 计算本地哈希

```shell
ossutil hash /BF/xtrabackup/2025-12-11/2025-12-11-full.tar.zst
```

建议确认：

- 目标对象是否存在
- 文件大小是否符合预期
- 关键备份文件是否需要额外做哈希校验

## 备份场景推荐流程

```shell
nohup ossutil cp \
  /BF/xtrabackup/2025-12-11/2025-12-11-full.tar.zst \
  oss://example-backup/site-a/2025-12-11/2025-12-11-full.tar.zst \
  > /opt/xtrabackup-upload.log 2>&1 &
```

推荐执行顺序：

1. 在本地完成备份打包，并确认文件已写入完成。
2. 执行后台上传命令，避免终端断开导致任务中止。
3. 通过 `tail -f` 持续观察日志输出。
4. 上传结束后执行 `ossutil stat` 或 `ossutil ls` 确认对象已生成。
5. 对关键备份执行哈希校验，确保内容完整。

## 常用命令速查

```shell
ossutil ls oss://bucket/
ossutil stat oss://bucket/path/file
ossutil cp local-file oss://bucket/path/file
ossutil cp oss://bucket/path/file local-file
ossutil cp -r local-dir/ oss://bucket/path/
ossutil sync local-dir/ oss://bucket/path/
ossutil rm oss://bucket/path/file
ossutil rm -r oss://bucket/path/
ossutil du oss://bucket/path/
ossutil presign oss://bucket/path/file
```

其他常见子命令：

```text
mb
rb
mkdir
append
cat
set-props
restore
revert
hash
```

## 常见问题与排查

### Bucket Endpoint 不匹配

现象：

```text
The bucket you are attempting to access must be addressed using the specified endpoint
```

处理方式：

- 登录 OSS 控制台确认 Bucket 地域。
- 重新检查 `Region` 和 `Endpoint` 是否对应。
- 内网与公网 Endpoint 不要混用到错误地域。

### 上传慢或传输失败

优先排查：

- 是否误用了公网 Endpoint
- ECS 与 OSS 是否处于同地域
- 服务器磁盘空间是否充足
- 日志中是否存在超时、网络中断或权限报错

### `AccessDenied`

常见原因：

- AccessKey 配置错误
- RAM 权限不足
- Bucket 策略限制访问

处理建议：

- 重新执行 `ossutil config` 校验凭证
- 检查 RAM 授权策略是否具备目标 Bucket 的读写权限
- 检查 Bucket Policy、对象 ACL 和网络访问限制

## 注意事项

- 后台执行时应为上传和下载分别使用不同日志文件，便于区分任务状态。
- 大文件传输前先确认目标目录和本地磁盘空间，避免中途中断。
- 使用内网 Endpoint 的前提是服务器网络路径确实可达内网 OSS 地址。
- 关键数据恢复前，建议先下载到临时目录完成校验，再投入正式使用。
