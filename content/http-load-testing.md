# HTTP 压测工具使用与结果分析手册

## 背景与目标

本文用于沉淀两类常见 HTTP 压测方式：

- `oha`：适合快速发起命令行压测，验证单接口吞吐、时延与错误分布。
- `JMeter`：适合执行 `.jmx` 测试计划，覆盖秒杀、搬家、全链路等复杂压测场景，并生成可视化报告。

## 工具选择建议

### 选择 `oha` 的场景

- 需要快速验证单个 URL 的基础性能表现。
- 关注并发、总请求量、压测持续时间、QPS、响应时间分布等核心指标。
- 不需要 GUI，也不依赖复杂测试计划文件。

### 选择 `JMeter` 的场景

- 已有 `.jmx` 测试计划，或需要构建更完整的业务压测流程。
- 需要导出 HTML 报告，便于复盘和对比。
- 需要覆盖多接口、多步骤或全链路压测。

## oha 使用说明

### 项目地址

<https://github.com/hatoo/oha>

### 常用参数

```bash
# 常用oha参数说明
-n <请求总数>
-z <持续时间>
-c <并发数>
```

参数说明：

- `-n`：指定总请求数，适合控制压测样本量。
- `-z`：指定持续时间，适合按固定时长观察系统表现。
- `-c`：指定并发数，直接影响压测强度。

### 示例命令

```bash
# 测试1000次，持续10秒，并发100个
oha -n 1000 -z 10s -c 100 http://www.example.com/
```

说明：

- 同时指定 `-n` 和 `-z` 时，可用于限制请求总量并控制压测窗口。
- URL 可替换为实际业务接口地址。

### 输出结果解读

`oha` 的关键输出项可按以下方式理解：

```text
Success rate # 成功率
Total # 总请求时间
Slowest # 最慢请求时间
Fastest # 最快请求时间
Average # 平均请求时间
Requests/sec # 每秒请求数(QPS)

Total data # 总数据量
Size/request # 单次请求数据量
Size/sec # 每秒数据量

Response time histogram: # 响应时间直方图

Response time distribution # 响应时间分布

Details (average, fastest, slowest) # 详细信息
  DNS+dialup:   0.0466 secs, 0.0118 secs, 0.0680 secs # DNS解析+TCP连接时间
  DNS-lookup:   0.0000 secs, 0.0000 secs, 0.0000 secs # DNS解析时间 0000表示没有DNS解析

Status code distribution: # 状态码分布
  [200] 601 responses # 200状态码的响应数量

Error distribution: # 错误分布
  [615] connection error # 615 次连接错误
  [100] aborted due to deadline  # 100 次请求被中止
  [100] timeout # 100 次请求超时
```

重点关注以下指标：

- `Success rate`：判断接口是否在目标压测强度下稳定成功。
- `Average`、`Slowest`、`Response time distribution`：判断整体时延与长尾情况。
- `Requests/sec`：衡量吞吐能力。
- `Status code distribution`：定位异常 HTTP 状态码。
- `Error distribution`：区分连接失败、超时、截止时间中止等问题类型。
- `DNS+dialup` 与 `DNS-lookup`：用于判断网络解析与连接建立是否成为瓶颈。

## JMeter 部署与使用

### Linux 部署

```bash
### linux 部署
# 下载 tgz 包
https://jmeter.apache.org/download_jmeter.cgi

# 解压到指定目录
tar xvf apache-jmeter-5.6.3.tgz -C /opt/

# 配置环境变量
vim /etc/profile
JMETER_HOME=/opt/apache-jmeter-5.6.3
PATH=${JMETER_HOME}/bin:$PATH

source /etc/profile

# 测试
jmeter -v

# 启动 jmeter
jmeter
```

建议：

- 将 `JMETER_HOME` 与实际安装版本保持一致。
- 修改 `/etc/profile` 后执行 `source /etc/profile`，确保当前会话立即生效。
- 先用 `jmeter -v` 验证安装是否成功，再决定是否启动 GUI。

### 命令行执行测试计划

适用于服务器环境、CI 环境或无需图形界面的批量压测。

```bash
# 命令方式启动
jmeter -n -t 团购秒杀压测.jmx -l 2.jtl -e -o report_folder
# 参数说明
-n 表示不启动 GUI 界面
-t 指定测试计划文件
-l 指定结果文件
-e 表示在命令行输出错误信息
-o 指定结果文件保存路径
```

另一组示例：

```bash
jmeter -n -t 服务器搬家全链路压测.jmx -l 2.jtl -e -o report_folder
```

适用建议：

- `团购秒杀压测.jmx`：适合高并发、突发流量场景。
- `服务器搬家全链路压测.jmx`：适合系统迁移、链路切换、端到端回归验证。

如果不同 `.jmx` 文件对应不同业务场景，应分别维护测试数据、断言、线程组和报告目录，避免结果互相覆盖。

### 报告导出与查看

```bash
# 生产的报告report_folder 导出到电脑打开index.html即可查看
```

建议：

- 每次执行压测时使用独立的 `report_folder`，便于结果留档与横向对比。
- 报告目录生成后，重点查看吞吐量、响应时间百分位、错误率和失败请求详情。

### 内存配置

在生成报告或执行大规模压测时，JMeter 默认内存可能不足，可按以下方式调整：

```bash
# jmeter 设置内存，不然无法生成报告
vim /opt/apache-jmeter-5.6.3/bin/jmeter
: "${HEAP:="-Xms20g -Xmx20g -XX:MaxMetaspaceSize=512m"}"
```

说明：

- `-Xms20g` 与 `-Xmx20g` 提供较大的堆内存，适合大结果集或较重的报告生成任务。
- 若机器内存不足，不应直接照搬 `20g`，应按宿主机资源合理下调。
- 如果仅做中小规模压测，可使用更保守的堆配置，避免与被测系统争抢资源。

## 多方案对比与落地建议

### 方案一：使用 `oha` 进行快速接口压测

适合以下目标：

- 验证接口在固定并发下的极限吞吐。
- 快速观察 QPS、平均时延、错误类型。
- 临时排查网络连接、超时和状态码异常。

优点：

- 命令简单，上手快。
- 输出直接，适合终端中快速判断结果。

限制：

- 不适合复杂业务编排。
- 不直接依赖测试计划文件，复用复杂场景能力较弱。

### 方案二：使用 `JMeter` 进行脚本化压测

适合以下目标：

- 执行固定的业务压测脚本。
- 生成结构化测试报告。
- 覆盖秒杀、迁移、全链路验证等业务场景。

优点：

- 可维护 `.jmx` 测试计划。
- 适合长期回归和多人协作。

限制：

- 部署和资源消耗高于 `oha`。
- 生成报告时对内存更敏感。

### 选择建议

- 单接口、快速验证：优先使用 `oha`。
- 复杂业务流、标准化报告、长期复用：优先使用 `JMeter`。
- 若先做容量摸底，再做业务回归，可先用 `oha` 快速找到压测区间，再用 `JMeter` 执行完整场景验证。

## 注意事项

- 压测前应确认目标环境是否允许压测，避免影响生产业务。
- `oha` 中出现大量 `connection error`、`timeout` 或 `aborted due to deadline` 时，应同时检查网络、网关、负载均衡、应用线程池与超时配置。
- JMeter 报告目录参数 `-o` 如果指向已存在目录，通常需要先清理或更换路径，以免报告生成失败。
- 大规模 JMeter 压测不要只关注被测服务，也要关注压测机本身的 CPU、内存、磁盘与网络。
- 如果压测结果需要长期对比，应固定并发、时长、测试数据、压测机规格和网络路径。

## 常见问题与排查方式

### `oha` 出现大量连接错误

排查方向：

- 目标地址是否可达。
- 域名解析是否正常。
- 服务端连接数、监听队列或网关限流是否成为瓶颈。
- 并发值是否超过当前环境承载能力。

### `oha` 出现超时或截止中止

排查方向：

- 服务端响应时间是否持续升高。
- 下游依赖是否存在阻塞。
- 被测接口是否存在数据库慢查询、锁竞争或线程池耗尽。

### JMeter 无法生成报告或执行过程中内存不足

处理建议：

- 调整 `HEAP` 参数。
- 减少单次保留的结果数据量。
- 按场景拆分压测计划，避免一次性加载过多线程组与结果集。

### JMeter 报告查看方式

处理方式：

- 生成 `report_folder` 后，将目录导出到本地。
- 直接打开 `index.html` 查看报告内容。
