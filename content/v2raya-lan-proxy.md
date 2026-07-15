# v2rayA 容器部署与局域网代理使用手册

## 背景与目标

本文用于在 Linux 主机上通过 Docker 部署 `v2rayA`，并将该主机作为局域网内其他机器的代理出口使用。内容覆盖容器启动、Web 端基础配置、客户端代理变量设置、Docker 拉镜像代理以及常见验证方法。

## 环境说明

- 宿主机已安装 Docker。
- 宿主机允许使用 `host` 网络模式。
- `v2rayA` Web 管理端口为 `2017`。
- 局域网客户端通过 HTTP/HTTPS 或 SOCKS5 代理访问外网。
- 镜像版本使用：`swr.cn-south-1.myhuaweicloud.com/yalex/v2raya:<IP_ADDRESS>`

## 部署步骤

### 1. 创建数据目录

推荐使用绝对路径保存配置，避免当前工作目录变化导致挂载路径不一致：

```bash
mkdir -p /docker/v2raya
```

### 2. 启动容器

推荐命令如下，配置目录与前面的数据目录保持一致：

```bash
docker run -d \
  --name v2raya \
  --network=host \
  -e V2RAYA_ADDRESS=<IP_ADDRESS>:2017 \
  -v /lib/modules:/lib/modules:ro \
  -v /etc/resolv.conf:/etc/resolv.conf \
  -v /docker/v2raya:/etc/v2raya \
  --restart=always \
  --privileged \
  swr.cn-south-1.myhuaweicloud.com/yalex/v2raya:<IP_ADDRESS>
```

说明：

- `--network=host` 直接使用宿主机网络，便于开放 Web 管理端口和代理端口。
- `--privileged` 与 `/lib/modules` 挂载通常用于透明代理、路由及相关内核能力场景。
- 若确实希望把配置保存在当前目录，也可以把挂载改为 `-v ./v2raya:/etc/v2raya`，但需要确保容器启动目录固定。

### 3. 访问 Web 管理页面

浏览器访问：

```text
http://<IP_ADDRESS>:2017/
```

实际使用时，应将 `<IP_ADDRESS>` 替换为宿主机真实可访问地址。

## Web 端基础配置

容器启动后，在 Web 页面完成以下操作：

1. 导入节点。
2. 启用大陆白名单模式。
3. 选择目标节点并点击连接。
4. 在左上角执行启动。

## 局域网客户端代理使用

当其他内网机器需要通过该宿主机访问外网时，可以直接设置代理环境变量。

### 方案一：HTTP/HTTPS 代理

适用场景：

- `curl`、`wget`、包管理器、容器构建等常见 CLI 工具。
- 大多数仅识别 `http_proxy` 和 `https_proxy` 的程序。

通用写法：

```bash
export http_proxy=http://内网IP:20172
export https_proxy=http://内网IP:20172
```

示例：

```bash
export http_proxy=http://<IP_ADDRESS>:20172
export https_proxy=http://<IP_ADDRESS>:20172
```

```bash
export http_proxy=http://<IP_ADDRESS>:20172
export https_proxy=http://<IP_ADDRESS>:20172
```

```bash
export http_proxy=http://<IP_ADDRESS>:7897
export https_proxy=http://<IP_ADDRESS>:7897
```

### 方案二：SOCKS5 代理

适用场景：

- 需要统一转发更多协议流量。
- 客户端程序支持 `all_proxy` 或 SOCKS5。

推荐写法：

```bash
export all_proxy=socks5h://<IP_ADDRESS>:7897
```

说明：

- `socks5h` 会将域名解析交给代理端处理，通常更适合代理访问外部域名。
- 如果程序只认 HTTP 代理，则优先使用上一节的 HTTP/HTTPS 方式。

### 方案选择建议

- 优先选 `HTTP/HTTPS`：兼容性最好，适合大多数命令行工具。
- 选 `SOCKS5`：适用于明确支持 SOCKS 的程序，尤其是需要远端 DNS 解析的场景。
- 如果代理端实际开放端口不是 `20172` 或 `7897`，应以宿主机当前真实监听端口为准。

## 命令行临时代理设置

如需在当前终端中一次性设置多种代理变量，可使用：

```bash
export https_proxy=http://<IP_ADDRESS>:7897
export http_proxy=http://<IP_ADDRESS>:7897
export all_proxy=socks5://<IP_ADDRESS>:7897
```

如果希望单条命令临时生效，也可以写成：

```bash
https_proxy=http://<IP_ADDRESS>:7897 \
http_proxy=http://<IP_ADDRESS>:7897 \
all_proxy=socks5://<IP_ADDRESS>:7897 \
curl https://ipinfo.io/
```

## 取消代理

取消当前终端代理环境：

```bash
export http_proxy=
export https_proxy=
export all_proxy=
```

## Docker 拉取镜像代理配置

当宿主机拉取镜像需要走代理时，可为 Docker 服务单独配置代理。

### 1. 创建配置目录

```bash
mkdir -p /etc/systemd/system/docker.service.d
```

### 2. 写入代理配置

文件路径：

```text
/etc/systemd/system/docker.service.d/proxy.conf
```

配置示例：

```ini
[Service]
Environment="HTTP_PROXY=http://<IP_ADDRESS>:20172/"
Environment="HTTPS_PROXY=http://<IP_ADDRESS>:20172/"
Environment="NO_PROXY=localhost,<IP_ADDRESS>,.example.com"
```

### 3. 重载并重启 Docker

```bash
systemctl daemon-reload
systemctl restart docker
```

说明：

- 该配置仅在 Docker 守护进程访问外网需要代理时使用。
- 如果当前网络环境下 Docker 可直接拉取镜像，则无需额外配置。

## 连通性验证

### 查看出口公网 IP

```bash
curl https://ipinfo.io/
```

### 查看当前 IP 信息

```bash
curl cip.cc
```

验证思路：

- 未启用代理时，返回结果通常显示本地网络出口。
- 启用代理后，若出口地址发生变化，则说明代理已经生效。

## 注意事项

- 文中的 IP 地址均为示例，部署时必须替换为实际宿主机地址。
- `2017` 用于 `v2rayA` Web 管理界面，不等同于客户端实际代理端口。
- `20172`、`7897` 属于文档中的已使用代理端口示例，实际端口需以当前服务监听状态为准。
- 局域网客户端若无法访问外网，应同时检查宿主机防火墙、路由转发和代理服务监听地址。

## 常见问题与排查

### Web 页面可以打开，但客户端无法走代理

排查方向：

- 确认 Web 端已导入节点、已连接节点并已启动。
- 确认客户端设置的代理端口与服务真实监听端口一致。
- 确认客户端访问的是宿主机内网 IP，而不是不可达地址。

### 命令行工具仍然直连外网

排查方向：

- 检查当前终端是否已正确执行 `export`。
- 确认目标程序是否继承了当前 shell 环境变量。
- 对不支持 `all_proxy` 的程序，改用 `http_proxy` 和 `https_proxy`。

### Docker 仍然无法拉取镜像

排查方向：

- 确认 `/etc/systemd/system/docker.service.d/proxy.conf` 内容无误。
- 执行 `systemctl daemon-reload` 与 `systemctl restart docker` 后重新尝试。
- 检查代理地址是否可从宿主机直接访问。
