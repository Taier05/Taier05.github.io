# Maven 本地元数据损坏导致依赖解析失败：排查与恢复

> 本文由一次多模块 Java 项目构建故障整理而成。服务器地址、构建用户、工作区和业务模块名称均已泛化。文中的缓存处理命令只针对已经确认损坏的依赖元数据；执行前应确保没有其他构建任务正在共享同一本地仓库。

一次 Maven 多模块构建在依赖解析阶段失败。表面上是业务模块无法打包，真正的直接原因却是构建用户本地仓库中的多份 `maven-metadata-*.xml` 变成了 0 字节，而项目又使用了 `RELEASE` 动态版本。备份并移走目标依赖的损坏元数据后，重新执行原构建命令恢复正常。

## 故障现象

现场环境使用 Anolis OS 8.10、JDK 8 和 Maven 3.5.4，并行构建多个 Maven 模块。脱敏后的命令如下：

```bash
su - REPLACE_WITH_BUILD_USER
cd /srv/ci/workspace/demo-project
mvn clean package -Dmaven.test.skip=true -Dmaven.compile.fork=true -T 4 -Pdev
```

构建日志中的关键信息为：

```text
[WARNING] The metadata .../org/jetbrains/annotations/maven-metadata-mirror.xml is invalid: input contained no data
[WARNING] The metadata .../org/jetbrains/annotations/maven-metadata-central.xml is invalid: input contained no data

[INFO] service-module ... FAILURE
[INFO] app-module ... SKIPPED
[INFO] BUILD FAILURE

Failed to resolve version for org.jetbrains:annotations:jar:RELEASE
Could not find metadata org.jetbrains:annotations/maven-metadata.xml in local
```

`input contained no data` 指向元数据内容异常，`annotations:jar:RELEASE` 则说明失败发生在动态版本解析阶段。后续模块显示 `SKIPPED` 是依赖链中断的结果，不应误判为这些模块自身编译失败。

## 排查证据

### 1. POM 使用动态版本

失败模块包含类似依赖：

```xml
<dependency>
    <groupId>org.jetbrains</groupId>
    <artifactId>annotations</artifactId>
    <version>RELEASE</version>
    <scope>compile</scope>
</dependency>
```

这里没有固定具体版本，Maven 需要读取仓库元数据以确定实际版本。

### 2. 构建用户的本地元数据为空

必须检查实际构建用户使用的仓库，而不是 root 自己的 `~/.m2`：

```bash
BUILD_HOME='/home/REPLACE_WITH_BUILD_USER'
METADATA_DIR="$BUILD_HOME/.m2/repository/org/jetbrains/annotations"

find "$METADATA_DIR" -maxdepth 1 -type f \
  -name 'maven-metadata-*' \
  -printf '%s %TY-%Tm-%Td %TH:%TM:%TS %f\n'
```

现场确认多份仓库元数据 XML 及其校验文件为 0 字节，`resolver-status.properties` 还记录了最近更新时间。这些不是普通业务 JAR，而是 Maven 解析动态版本时依赖的元数据和更新状态。

本地仓库可能由 `settings.xml`、`-Dmaven.repo.local` 或 CI 配置改写，处理前应从构建日志和 effective settings 确认真实路径：

```bash
mvn help:effective-settings -Doutput=/tmp/effective-settings.xml
```

该文件可能包含仓库账号或内部地址，对外分享前必须脱敏，检查后也应按环境安全要求处理。

### 3. 远端仓库可正常返回元数据

排查时，从构建机访问对应远端仓库，得到 HTTP 200 和非空、可解析的 XML。这说明当时的直接故障点位于本地缓存。

这个证据不能反推空文件最初生成时远端仓库、网络或代理一定正常。直接原因已经确认，不代表底层形成原因已经查明。

### 4. 不要把旧产物归因于本次构建

故障发生在中途：前置模块生成的新 JAR 可以通过 ZIP 完整性检查，失败模块和后续跳过模块的目录中仍残留旧文件，其中甚至有 0 字节 JAR。

因此不能说“本次失败生成了这些空包”。Maven 未进入后续模块的打包阶段，旧 `target` 中的文件只是历史残留。

## 直接故障链

```text
POM 使用 RELEASE 动态版本
          ↓
Maven 读取本地仓库元数据解析具体版本
          ↓
元数据 XML 为 0 字节，解析失败
          ↓
目标模块依赖解析失败
          ↓
后续依赖模块被跳过
```

Maven 仓库策略的 `updatePolicy` 默认值是 `daily`。已有的更新状态可能使 Maven 当天继续沿用本地缓存，不能期待每次重跑原命令都会重新下载；具体行为仍受仓库和镜像配置影响。

本案例只确认了依赖解析失败的直接原因。文件为何变成 0 字节没有充分证据，可能涉及下载中断、代理响应、磁盘或文件系统、并发写入、异常退出等因素，不能从单条系统日志直接定性。

## 定向恢复损坏元数据

### 1. 确认没有并行构建

同一用户或多个任务共享本地仓库时，移动元数据可能与正在运行的 Maven 进程冲突。先通过 CI 调度状态和进程列表确认维护窗口：

```bash
pgrep -a -u REPLACE_WITH_BUILD_USER -f '(^|/)mvn([[:space:]]|$)|org.codehaus.plexus.classworlds.launcher.Launcher'
```

发现其他构建任务时先停止本次处理，并通过正常的 CI 流程协调，不要直接杀掉未知任务。

### 2. 备份并移走损坏文件

以实际构建用户执行：

```bash
set -euo pipefail

METADATA_DIR="$HOME/.m2/repository/org/jetbrains/annotations"
BACKUP_DIR="$HOME/maven-metadata-backup-$(date +%Y%m%d-%H%M%S)"

test -d "$METADATA_DIR"
install -d -m 0700 "$BACKUP_DIR"

find "$METADATA_DIR" -maxdepth 1 -type f \
  \( -name 'maven-metadata-*.xml' \
     -o -name 'maven-metadata-*.xml.sha1' \
     -o -name 'maven-metadata-*.xml.md5' \
     -o -name 'resolver-status.properties' \) \
  -print0 |
while IFS= read -r -d '' file; do
  mv -- "$file" "$BACKUP_DIR/"
done
```

处理范围仅限于已经确认的 `org/jetbrains/annotations` 目录。没有删除整个 `~/.m2/repository`，也没有删除已缓存的具体版本 JAR 和 POM。

仓库 ID 不同，元数据文件名也会不同。应依据实际日志和目录内容确认，不能把示例文件名写成无条件删除命令。

### 3. 重新执行原构建

```bash
cd /srv/ci/workspace/demo-project
mvn clean package -Dmaven.test.skip=true -Dmaven.compile.fork=true -T 4 -Pdev
```

`clean` 会清理进入相应生命周期的模块输出目录，执行前应确认其中没有唯一且需要保留的产物。恢复后应看到完整 Reactor Summary 和最终的 `BUILD SUCCESS`。

本案例没有更换 JDK、Maven 版本、线程数或 POM，定向刷新损坏元数据后原构建恢复。

> 命令中的 `-Dmaven.compile.fork=true` 按现场参数保留。Maven Compiler Plugin 的标准用户属性是 `maven.compiler.fork`。不能仅凭这个现场拼写就断言编译器已经 fork；是否调整应单独验证，不属于缓存恢复动作。

## 为什么重新拉代码没有用

源码工作区和 Maven 本地仓库位于不同位置：

| 位置 | 主要内容 | 删除工作区是否清理 |
| --- | --- | --- |
| `/srv/ci/workspace/demo-project` | 源码、POM、模块 `target` | 是 |
| `$HOME/.m2/repository` | 依赖、插件和仓库元数据 | 否 |

删除工作区再拉代码后，Maven 仍会读取同一份损坏缓存。因此本案例无需扩大到工作区重建。

这也不是所有依赖解析错误的通用答案。如果远端根本不存在依赖、认证失败、镜像配置错误或网络不可达，应针对对应证据处理。

## 恢复后的验证

### 1. 检查 Reactor Summary

确认所有预期模块均为 `SUCCESS`，Maven 退出码为 `0`，并确保发布阶段不会在构建失败后继续取用旧包。

### 2. 验证 JAR 容器完整性

```bash
unzip -tq app-module/target/app.jar
```

该命令只验证 JAR 作为 ZIP 容器是否完整，不能替代应用启动和业务验证。

### 3. 比对发布前后哈希

```bash
sha256sum app-module/target/app.jar
```

在构建端和目标端计算并比对 SHA-256，可以证明传输前后文件内容一致，但无法证明源包逻辑正确。

### 4. 复核重新下载的元数据

```bash
find "$HOME/.m2/repository/org/jetbrains/annotations" -maxdepth 1 \
  -type f -name 'maven-metadata-*.xml' -size +0c -print
```

确认元数据非空，并保留本次构建日志。不要仅以“命令没有报错”作为全部验收依据。

## 后续改进

1. **固定依赖版本。** 将 `RELEASE` 改为经过验证的明确版本，减少对动态元数据的依赖并提升可复现性。
2. **构建成功后才发布。** CI 必须检查 Maven 退出码和本次产物，不能沿用旧 `target` 文件。
3. **优先定向处理缓存。** 先备份具体依赖目录，避免为单个损坏文件清空整个本地仓库。
4. **隔离并发写入。** 评估并行任务是否共享同一个本地仓库，必要时为任务配置独立缓存或使用受控缓存代理。
5. **保留系统与构建时间线。** 如果空文件复发，关联构建日志、仓库代理、磁盘、文件系统和虚拟化平台记录，再判断底层原因。

`-U` 可以要求 Maven检查远端更新，但不是修复所有损坏依赖的通用开关。本案例采用的是先备份并移走指定元数据，再执行原命令。

## 参考资料

- [Maven POM Reference：Repository Policy](https://maven.apache.org/pom.html#repositories)
- [Maven Compiler Plugin：fork 参数](https://maven.apache.org/plugins/maven-compiler-plugin/compile-mojo.html#fork)
- [Maven CLI Options Reference](https://maven.apache.org/ref/current/maven-embedder/cli.html)
