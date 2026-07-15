# MySQL备份与恢复操作手册

> 恢复警告：停止 MySQL 和清空数据目录会造成服务中断或永久数据丢失。恢复前必须验证备份可读、记录原数据目录、停止业务写入并制作目录级快照；先打印并人工核对 MYSQL_DATADIR，再执行带空变量保护的清理命令。密码优先放入权限为 600 的客户端配置文件，不要写入命令历史。

## 背景与目标

本文用于统一说明 MySQL 常见备份与恢复方式，包括：

- 基于 `mysqldump` 的逻辑备份、导出与导入
- 基于 `Percona XtraBackup` 的物理全量备份、增量备份、恢复与异机恢复

两种方案适用场景不同：

- `mysqldump`：适合按库、按表导出，适合迁移、初始化从库、导出单库或单表数据
- `XtraBackup`：适合整实例物理备份与恢复，适合大数据量、全量备份、增量备份、灾备恢复

## 环境说明

- MySQL 8.0
- Linux 系统，示例命令包含 `yum`、`systemctl`、`tar`、`docker`
- 备份目录示例：`/backup/mysql/`
- 常见数据目录示例：
  - `/var/lib/mysql`
  - `/var/lib/mysql`
  - `/data/mysql`
  - `/docker/mysql/data`

使用前请先确认本机实际 `datadir`，避免恢复时把备份回写到错误目录。可优先检查：

```bash
mysql -uroot -p -e "SHOW VARIABLES LIKE 'datadir';"
```

或查看配置文件中的 `datadir`。

## 方案选择建议

### 选择 `mysqldump` 的场景

- 需要导出指定库或指定表
- 需要跨环境迁移 SQL
- 需要给从库导入初始化数据
- 备份结果希望是 SQL 文件，便于查看和编辑

### 选择 `XtraBackup` 的场景

- 数据量较大，不适合长时间逻辑导出
- 需要整实例物理备份
- 需要增量备份链
- 需要更快的全库恢复

### 两者的关键区别

- `mysqldump` 是逻辑备份，产物是 SQL
- `XtraBackup` 是物理备份，产物是数据文件目录
- `mysqldump` 可以备份单库、单表
- `XtraBackup` 只能备份整个实例，不能只备份单个数据库

## mysqldump 逻辑备份与导入

### 适用说明

初始化从库时：

- 传统复制模式：可以使用任意形式导入，例如 `mysqldump`、Navicat 等
- GTID 模式：导入数据中必须包含 GTID 信息，通常保留 `--set-gtid-purged=AUTO`

### 推荐命令

#### 1. 指定库导出

```bash
# 将主库的数据导入到从库 ----------传统模式用可以任何形式导入(mysqldump/navicat/xxxx)
# 将主库的数据导入到从库 ----------GTID模式必须要有GITD值的数据
# 1、指定库导出 ---- 指定appdb库 ---- 传统模式用可以去掉--set-gtid-purged=AUTO参数
mysqldump --databases appdb --triggers --routines --events --master-data=2 --single-transaction --flush-privileges --flush-logs --force --quick --set-gtid-purged=AUTO -u root -p -v > backup.sql
```

说明：

- `--triggers --routines --events`：保留触发器、存储过程、事件
- `--master-data=2`：记录复制位点信息，适合主从初始化
- `--single-transaction`：适合 InnoDB 在线一致性导出
- `--set-gtid-purged=AUTO`：GTID 模式建议保留；传统模式可按需去掉

#### 2. 模糊匹配库导出

```bash
# 2、模糊匹配库导出 ---- 模糊匹配包含o2o的库 ---- 传统模式用可以去掉--set-gtid-purged=AUTO参数，也可以保留
mysql -u root -p -e "SHOW DATABASES LIKE '%app%'" 2>/dev/null | grep -v "Database" | xargs mysqldump -u root -p -v --databases --triggers --routines --events --master-data=2 --single-transaction --flush-privileges --flush-logs --force --quick --set-gtid-purged=AUTO > backup.sql
```

适用场景：

- 同一业务前缀下存在多个数据库
- 需要一次性导出一组命名规则相同的库

#### 3. 指定表导出

```bash
# 3、指定表导出 ---- 指定appdb库里面的ya表
mysqldump --triggers --routines --events --master-data=2 --single-transaction --flush-privileges --flush-logs --force --quick -u root -p -v appdb sample_table > backup.sql
# mysqldump其他参数？
```

适用场景：

- 仅恢复或迁移某张业务表
- 需要临时抽取局部数据

### 导入命令

```bash
# 从库导入数据
mysql -u root -p -v < backup.sql
```

### 使用建议

- GTID 复制场景优先保留 `--set-gtid-purged=AUTO`
- 非 GTID 场景可根据实际情况省略该参数
- 逻辑备份适合精细化导出，但大库导出和恢复耗时通常高于物理备份

## Percona XtraBackup 安装

### 软件下载

```text
参考: https://docs.percona.com/percona-xtrabackup/8.0/yum-download-rpm.html
下载地址: https://www.percona.com/downloads

percona-xtrabackup-80-8.0.35-34.1.el8.x86_64.rpm
```

### 安装命令

```bash
# 安装依赖包
yum install libev libgcrypt openssl zlib libaio -y

# 安装xtrabackup
yum localinstall percona-xtrabackup-80-8.0.35-34.1.el8.x86_64.rpm -y

# 验证安装
xtrabackup --version
```

## XtraBackup 备份操作

### 说明

- 备份结果以目录形式存在
- 只能备份整个实例，不能备份单个数据库
- 从库执行备份时可保留 `--slave-info`，便于后续复制恢复

### 全量备份

```bash
# ================= 备份 =================  数据是以文件夹形式存在
# 只能备份整个实例，不能备份单个数据库
# 全量备份
xtrabackup \
  --backup \
  --target-dir=/backup/mysql/2025-12-15/2025-12-15-full \
  --user=root \
  --password='<MYSQL_PASSWORD>' \
  --parallel=4 \
  --slave-info

# --datadir=  # 数据目录。默认取/etc/my.cnf
```

建议：

- `--parallel=4` 可按 CPU 和磁盘性能调整
- 若配置文件位置标准且 `datadir` 已配置，通常可不显式指定 `--datadir`
- 如果实例有多个配置来源，应显式指定 `--datadir`

### 增量备份

```bash
# 如果需要增量备份
# 增量备份第一次,--incremental-basedir=指向全量备份目录,后续指向上一次备份目录
xtrabackup \
  --backup \
  --incremental-basedir=/backup/mysql/2025-12-15/2025-12-15-full \
  --target-dir=/backup/mysql/2025-12-15/2025-12-15-full-01 \
  --user=root \
  --password='<MYSQL_PASSWORD>' \
  --parallel=4 \
  --slave-info
# 增量备份第二次
xtrabackup \
  --backup \
  --incremental-basedir=/backup/mysql/2025-12-15/2025-12-15-full-01 \
  --target-dir=/backup/mysql/2025-12-15/2025-12-15-full-02 \
  --user=root \
  --password='<MYSQL_PASSWORD>' \
  --parallel=4 \
  --slave-info
# 增量备份第三次
xtrabackup \
  --backup \
  --incremental-basedir=/backup/mysql/2025-12-15/2025-12-15-full-02 \
  --target-dir=/backup/mysql/2025-12-15/2025-12-15-full-03 \
  --user=root \
  --password='<MYSQL_PASSWORD>' \
  --parallel=4 \
  --slave-info
```

要求：

- 增量链必须严格连续
- 后一次增量的 `--incremental-basedir` 必须指向前一次备份目录
- 恢复前必须先做 `prepare` 合并

## XtraBackup 恢复操作

### 方案一：仅恢复全量备份

该方案适用于只有一次全量备份，无增量链的情况。

```bash
# ================= 恢复 =================
# 只恢复全量备份
xtrabackup --prepare --target-dir=/backup/mysql/2025-12-15/2025-12-15-full # 这一步很重要，否则恢复时会报错
systemctl stop mysqld && \
rm -rf -- "${MYSQL_DATADIR:?MYSQL_DATADIR 未设置}/"* && \
chown -R mysql.mysql /var/lib/mysql && \
xtrabackup --copy-back --target-dir=/backup/mysql/2025-12-15/2025-12-15-full --datadir=/var/lib/mysql && \
chown -R mysql:mysql /var/lib/mysql && \
systemctl start mysqld
```

说明：

- 恢复时 `--datadir` 应与实际 MySQL 数据目录一致
- 原命令中同时出现 `/var/lib/mysql` 与 `/data/mysql`，实际执行时不应混用
- 清空数据目录前必须确认路径无误

### 方案二：恢复全量 + 增量备份

该方案适用于已建立增量链、希望恢复到最新备份点的场景。

```bash
# 恢复全量+增量备份----注意，增量备份必须复制一份出来做还原，不要破坏原备份
# 需要将增量合并到全量里
# 先让全量变成可合并状态
xtrabackup --prepare --apply-log-only --target-dir=/backup/mysql/2025-12-15/2025-12-15-full
# 合并第一个增量，必须要严格按照顺序
xtrabackup \
  --prepare \
  --apply-log-only \
  --target-dir=/backup/mysql/2025-12-15/2025-12-15-full \
  --incremental-dir=/backup/mysql/2025-12-15/2025-12-15-full-01
# 合并第二个增量
xtrabackup \
  --prepare \
  --apply-log-only \
  --target-dir=/backup/mysql/2025-12-15/2025-12-15-full \
  --incremental-dir=/backup/mysql/2025-12-15/2025-12-15-full-02
# 最后prepare一下 很重要，否则恢复时会报错
xtrabackup --prepare --target-dir=/backup/mysql/2025-12-15/2025-12-15-full
# 开始恢复,注意，如果是宝塔安装的mysql，就去宝塔关闭mysql而不是命令stop
systemctl stop mysqld && \
rm -rf -- "${MYSQL_DATADIR:?MYSQL_DATADIR 未设置}/"* && \
chown -R mysql.mysql /var/lib/mysql && \
xtrabackup --copy-back --target-dir=/backup/mysql/2025-12-15/2025-12-15-full --datadir=/var/lib/mysql && \
chown -R mysql:mysql /var/lib/mysql && \
systemctl start mysqld
```

关键点：

- 增量合并必须按顺序执行
- 中间合并阶段使用 `--apply-log-only`
- 最后一次 `prepare` 不再带 `--apply-log-only`
- 恢复时建议使用备份副本进行合并，不直接破坏原始备份目录

### 方案三：恢复链条的简化复制示例

该示例适合已经确认备份链结构，仅需快速恢复某一组备份数据时使用。

```bash
# ================= 复制用
xtrabackup --prepare --apply-log-only --target-dir=/backup/mysql/2026-01-14/2026-01-14-full # 先让全量变成可合并状态
xtrabackup \
  --prepare \
  --apply-log-only \
  --target-dir=/backup/mysql/2026-01-14/2026-01-14-full \
  --incremental-dir=/backup/mysql/2026-01-14/2026-01-14-full-02  # 合并增量，按照顺序
xtrabackup --prepare --target-dir=/backup/mysql/2026-01-14/2026-01-14-full # 最后prepare一下 很重要，否则恢复时会报错
# 开始恢复,注意，如果是宝塔安装的mysql，就去宝塔关闭mysql而不是命令stop
systemctl stop mysqld && \
rm -rf -- "${MYSQL_DATADIR:?MYSQL_DATADIR 未设置}/"* && \
chown -R mysql.mysql /var/lib/mysql && \
xtrabackup --copy-back --target-dir=/backup/mysql/2026-01-14/2026-01-14-full --datadir=/var/lib/mysql && \
chown -R mysql:mysql /var/lib/mysql && \
systemctl start mysqld
```

适用说明：

- 该写法本质上仍是“全量 + 增量”恢复
- 示例中只合并了 `full-02`，前提是它就是当前需要接入的那一级增量
- 如果存在 `full-01`、`full-02`、`full-03` 等连续链条，则必须按实际顺序逐级合并，不能跳过

## 备份压缩与解压

适合将物理备份目录归档保存或传输。

```bash
# 压缩命令和解压命令
# 压缩
tar -I zstd -cvf /backup/mysql/2025-12-15/2025-12-15-full.tar.zst -C /backup/mysql/2025-12-15/ 2025-12-15-full
# 解压
tar -I zstd -xvf /backup/mysql/2025-12-15/2025-12-15-full.tar.zst -C /backup/mysql/2025-12-15/
```

## 恢复到其他目录或 Docker 临时实例

该方案适合以下场景：

- 临时拉起一个独立 MySQL 做数据验证
- 在原实例之外进行数据比对
- Docker 容器中挂载独立数据目录做恢复

```bash
# =================== 恢复到其他目录  比如docker临时拉起数据库
# --copy-back步骤
xtrabackup --no-defaults \
  --copy-back \
  --target-dir=/backup/mysql/2026-02-04/2026-02-04-full \
  --datadir=/docker/mysql/data \
  --innodb_data_home_dir=/docker/mysql/data \
  --innodb_log_group_home_dir=/docker/mysql/data
# 踩坑  如果docker-compose起不来
# 注意my.cnf关键配置要一致，比如
lower_case_table_names=1
# 权限
# 先查镜像里 mysql 用户的 uid/gid
IMG="registry.example.com/database/mysql:8.0.36"
docker run --rm --entrypoint bash "$IMG" -c 'id mysql'
# 假设输出 uid/gid 是 999:999（以你实际输出为准），执行：
chown -R 999:999 /MysqlData/docker-mysql-data
chmod 750 /MysqlData/docker-mysql-data
# 查看日志
docker logs -f --tail=200 mysql-master
```

注意事项：

- `--no-defaults` 适合避免宿主机本地 MySQL 配置干扰恢复目录
- 容器中的 `my.cnf` 关键参数必须与原实例兼容，特别是 `lower_case_table_names`
- 容器镜像内 `mysql` 用户 UID/GID 可能与宿主机不同，必须以镜像实际输出为准调整目录权限

## 推荐操作准则

### 密码处理

示例中出现了明文密码写法，正式环境建议改为以下任一方式：

- 使用交互式 `-p`
- 使用受控的参数文件
- 使用受限权限的备份账号

不建议在长期保留的脚本中直接写入生产密码。

### 数据目录处理

执行以下命令前必须再次确认目录：

```bash
rm -rf -- "${MYSQL_DATADIR:?MYSQL_DATADIR 未设置}/"*
```

因为恢复脚本中包含清空数据目录操作，一旦路径错误会导致不可逆的数据删除。

### 服务停止方式

- 标准系统服务可使用 `systemctl stop mysqld`
- 如果 MySQL 由宝塔等面板接管，应通过对应面板停止服务，避免状态不一致

### 权限修复

恢复后通常需要重新修正属主属组：

```bash
chown -R mysql:mysql /你的实际数据目录
```

若是容器目录，需改为镜像内 `mysql` 用户真实 UID/GID。

## 常见问题与排查

### `xtrabackup --copy-back` 时报错

优先检查：

- 是否先执行了 `xtrabackup --prepare`
- 增量恢复时是否完成了最终一次不带 `--apply-log-only` 的 `prepare`
- 目标数据目录是否为空
- `--datadir` 是否与实际目录一致

### 恢复后 MySQL 无法启动

优先检查：

- 数据目录属主属组是否正确
- 配置文件中的 `datadir` 是否与恢复目录一致
- Docker 场景下 `lower_case_table_names` 等关键参数是否一致
- 错误日志中是否存在表空间、redo log、权限相关报错

### 增量恢复后数据不完整

优先检查：

- 增量目录是否按顺序合并
- 是否遗漏某一级增量
- 是否直接在原备份目录上反复试验导致链条损坏

### 主从初始化后复制异常

优先检查：

- 当前是否为 GTID 模式
- 导出时是否保留 `--set-gtid-purged=AUTO`
- 导入后的复制位点或 GTID 集是否正确衔接

## 建议的落地实践

- 需要单库、单表迁移时优先使用 `mysqldump`
- 需要整机备份和快速恢复时优先使用 `XtraBackup`
- 生产环境保留“全量 + 增量 + 压缩归档”组合
- 恢复演练时先在测试目录或 Docker 实例验证，再执行正式切换
- 每次恢复前都先确认 `datadir`、权限、配置文件和备份链完整性

## 参考资料

- [Percona XtraBackup 8.0](https://docs.percona.com/percona-xtrabackup/8.0/)
- [Percona 增量备份文档](https://docs.percona.com/percona-xtrabackup/8.0/create-incremental-backup.html)
