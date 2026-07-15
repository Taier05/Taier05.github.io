# MySQL 8.0 RPM 安装与数据目录迁移手册

## 背景与目标

本文用于在基于 EL8 的 Linux 环境中，通过 RPM Bundle 方式安装 MySQL 8.0，完成数据库初始化、服务启停、自定义数据目录配置，以及在必要时执行数据目录迁移、重新初始化和高权限账号创建。

适用场景：

- 服务器无法直接使用在线仓库，需要手动下载 RPM 安装包
- 需要将 MySQL 数据目录放置到独立磁盘或自定义路径，例如 `/MysqlData/mysqldata`
- 需要对新实例进行初始化，或对已有实例重新初始化

## 环境说明

- 操作系统：EL8 系列发行版
- 安装方式：MySQL 官方 RPM Bundle 离线安装
- 依赖工具：`dnf`、`tar`、`systemctl`

官方 RPM 下载归档地址：

```text
https://downloads.mysql.com/archives/community/
```

示例安装包：

```text
mysql-8.0.36-1.el8.x86_64.rpm-bundle.tar
```

## 安装前准备

先安装依赖包：

```bash
# 安装依赖包
dnf install -y libaio
```

下载 RPM Bundle 后解压到本地目录：

```bash
# 解压安装包
mkdir mysql-install
tar xvf mysql-8.0.36-1.el8.x86_64.rpm-bundle.tar -C mysql-install
```

安装前建议先检查系统中是否已有旧版 MySQL 相关组件，避免包冲突：

```bash
# 安装
rpm -qa | grep -i mysql # 检查是否已经安装过mysql
dnf install -y --allowerasing mysql-install/mysql-community-*.rpm
```

说明：

- `--allowerasing` 用于处理已有冲突包的替换场景
- 如果环境中已存在 MariaDB 或旧版 MySQL，执行安装前应确认兼容性及数据保留策略

## 数据目录与配置准备

默认情况下 MySQL 使用系统默认数据目录。若计划使用自定义目录，例如 `/MysqlData/mysqldata`，建议在初始化前完成目录创建与授权。

```bash
# 修改配置
vim /etc/my.cnf
# 如果指定的数据目录为/MysqlData/mysqldata，则先创建好：
mkdir -p /MysqlData/mysqldata
chown -R mysql:mysql /MysqlData/mysqldata
chmod -R 755 /MysqlData/mysqldata
```

推荐在 `/etc/my.cnf` 中至少确认以下内容与实际目录一致：

```ini
[mysqld]
datadir=/MysqlData/mysqldata
socket=/var/lib/mysql/mysql.sock
```

说明：

- `datadir` 必须与实际初始化目录一致
- 如果使用了自定义 socket、log、pid 路径，也需要同步检查目录权限

## 初始化数据库

在确认目录已创建、权限正确、配置已生效后，执行初始化：

```bash
# 初始化数据库
mysqld --initialize --user=mysql --datadir=/MysqlData/mysqldata  # 提前创建好/MysqlData/mysqldata目录
#注意：这会生成一个临时 root 密码，记录日志中显示的密码
```

注意事项：

- `--initialize` 会生成系统表并创建临时 `root` 密码
- 临时密码通常可从 MySQL 日志中获取，后续首次登录必须先修改密码
- 初始化目录必须为空目录；若目录中已有旧数据文件，初始化通常会失败

## 启动与设置开机自启

初始化完成后启动服务：

```bash
# 启动服务
systemctl start mysqld
systemctl enable mysqld
systemctl status mysqld
```

如果启动失败，优先检查以下内容：

- `/etc/my.cnf` 中的 `datadir` 是否与实际目录一致
- 数据目录属主属组是否为 `mysql:mysql`
- 目录权限是否允许 MySQL 进程访问
- 初始化是否已成功完成

## 首次登录与基础安全配置

使用初始化生成的临时密码登录：

```bash
# 配置数据库
mysql -u root -p
ALTER USER 'root'@'localhost' IDENTIFIED BY '<DB_PASSWORD>'; # 修改root密码才能下一步操作
set global validate_password.policy=0; # 关闭密码复杂度验证
set global validate_password.length=1; # 密码长度限制
```

说明：

- 首次登录后，必须先执行 `ALTER USER` 修改 `root` 密码，否则后续操作可能被拒绝
- `validate_password.policy=0` 与 `validate_password.length=1` 适用于测试、临时环境或需要兼容弱密码策略的场景

选择建议：

- 生产环境：不建议关闭密码复杂度校验，也不建议将密码长度限制设为 1
- 测试环境：可临时使用上述策略，但应明确访问边界并做好网络限制

## 数据目录迁移方案

当 MySQL 已安装并运行，但需要将数据目录迁移到新路径时，可采用以下方式。

适用场景：

- 原磁盘空间不足
- 需要迁移到独立数据盘
- 需要统一目录规划

操作步骤：

```bash
# 如果需要更改数据目录
systemctl stop mysqld
cp -r /var/lib/mysql/* /MysqlData/mysqldata/
chown -R mysql:mysql /MysqlData/mysqldata
chmod -R 755 /MysqlData/mysqldata
systemctl start mysqld
```

补充建议：

- 执行迁移前，应先在 `/etc/my.cnf` 中将 `datadir` 调整为新目录
- 迁移完成后再启动服务，避免仍指向旧目录
- 若环境启用了 SELinux，还需同步处理新目录的安全上下文
- 生产环境建议优先使用保留权限与属性的复制方式，例如 `rsync -a` 或 `cp -a`；当前命令适合简单场景

## 重新初始化方案

当实例需要彻底重建时，可以执行重新初始化流程。

适用场景：

- 初始化失败且目录状态已混乱
- 当前实例无需保留原始数据
- 需要重建一个全新的空实例

操作步骤：

```bash
# 如果需要重新初始化
systemctl stop mysqld
cp -r /MysqlData/mysqldata /MysqlData/mysqldata_backup
rm -rf /MysqlData/mysqldata/*
配置好/etc/my.cnf
mysqld --initialize --user=mysql --datadir=/MysqlData/mysqldata #注意：这会生成一个临时 root 密码，记录日志中显示的密码
systemctl start mysqld
```

注意事项：

- 执行 `rm -rf /MysqlData/mysqldata/*` 前，必须确认备份已完成且当前目录路径无误
- 重新初始化会导致原实例中的库、表、用户、授权信息全部失效
- 若只是迁移目录，不应执行重新初始化

## 高权限远程账号创建

如需创建具备全局权限的远程管理账号，可执行以下语句：

```sql
# 创建大权限账号-可选
create user 'app_admin'@'%' identified by '<DB_PASSWORD>';
grant all on *.* to 'app_admin'@'%' WITH GRANT OPTION;
flush privileges;
```

适用场景：

- 运维管理平台需要远程接入
- 临时排障需要跨主机登录管理

风险说明：

- `'%'` 表示允许任意来源地址连接，暴露面较大
- `WITH GRANT OPTION` 允许该账号继续向其他账号授予权限，风险较高

选择建议：

- 生产环境建议限制来源地址，例如指定堡垒机网段或运维节点 IP
- 非必要情况下，不建议授予 `WITH GRANT OPTION`

## 推荐实施顺序

### 新服务器首次部署

1. 下载 RPM Bundle 并安装 `libaio`
2. 解压并安装 MySQL RPM 包
3. 配置 `/etc/my.cnf`
4. 创建并授权数据目录
5. 执行初始化
6. 启动并设置开机自启
7. 使用临时密码登录并修改 `root` 密码
8. 根据环境策略决定是否调整密码复杂度

### 已有实例迁移数据目录

1. 停止 MySQL 服务
2. 修改 `/etc/my.cnf` 中的 `datadir`
3. 将旧目录数据复制到新目录
4. 修正属主属组和权限
5. 启动服务并验证实例状态

### 空实例重建

1. 停止 MySQL 服务
2. 备份原数据目录
3. 清空目标数据目录
4. 确认 `/etc/my.cnf`
5. 重新执行初始化
6. 启动服务并重新完成密码设置

## 常见问题与排查

### 服务无法启动

重点检查：

- `systemctl status mysqld`
- 数据目录是否存在且为空或已完整迁移
- `mysql:mysql` 权限是否正确
- `/etc/my.cnf` 中 `datadir` 是否配置错误

### 初始化后无法登录

重点检查：

- 是否使用了日志中生成的临时 `root` 密码
- 是否已先执行 `ALTER USER` 修改密码

### 修改数据目录后启动异常

重点检查：

- 新目录中的文件是否复制完整
- 配置文件是否仍指向旧目录
- 目录权限与安全策略是否阻止访问

## 注意事项

- 生产环境不要直接沿用示例密码，应替换为符合安全要求的实际密码
- 关闭密码复杂度校验仅适合低风险环境
- 创建远程全权限账号前，应先评估网络访问范围和审计要求
- 涉及数据目录迁移和重新初始化时，必须先确认备份可用
