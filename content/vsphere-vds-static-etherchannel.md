# vSphere vDS 与静态 EtherChannel 配置手册

> 中断风险提示：静态 EtherChannel 要求交换机端口与 vDS/dvPortgroup 的 Route based on IP hash 完全匹配。不要把静态 Port-Channel 与 vDS 的动态 LACP LAG 混用。迁移管理 VMkernel 前必须准备 DCUI 或带外入口、保留可回退的 vSS 管理路径，并一次只处理一台非 vCenter 所在主机。

> 适用场景：交换机侧使用**静态 LAG**（手动配置 Port-Channel，不跑 LACP），ESXi 8.0.2，vCenter 8.0.3。
> 目标：把多台 ESXi 通过 vDS 统一接入，并用两口网卡做链路汇聚；同时**安全处理 vCenter 所在的 ESXi 主机**，避免“迁移管理网导致 vCenter/主机失联”。

---

## 1. 背景与关键原则

- 本文采用的设计是：每台 ESXi 两个物理口（例如 vmnic0/vmnic1）做 **静态 LAG**，在 vDS/端口组侧使用 **“基于 IP 哈希的路由（Route based on IP hash）”**。
- **关键原则（非常重要）**：
  **vDS 端口组使用 IP Hash 时，交换机侧必须把对应的物理端口加入同一个 Port-Channel（静态 on 或等效模式），并且两条上行都应处于 Active。**
  只要任意一侧不匹配（比如交换机没聚合、或端口组不是 IP Hash），就可能出现丢包/主机失联。

---

## 2. 变更前准备（强烈建议先做）

### 2.1 网络规划（建议写清楚）
| 项目 | 建议 |
|---|---|
| 管理网络（MGMT） | VLAN/网段、网关、DNS、NTP（确保一致） |
| VM 业务网络（VM） | VLAN/网段、是否需要 Trunk、是否有多 VLAN |
| vMotion 网络（可选但推荐独立） | 建议单独 VMkernel（vmk1）+ 独立 VLAN/网段，避免占用管理网 |
| 存储网络（如 iSCSI/NFS/vSAN） | MTU、VLAN、带宽规划（若要做“主机+存储一起迁移”，更要保证链路质量） |

> 为快速迁移，直接在 vmk0 勾选 vMotion 也可用；生产环境建议使用独立 VMkernel 接口，边界更清晰、策略更易控制。

### 2.2 变更保护（回退手段）
- 确认具备 **ESXi 控制台/DCUI** 或带外管理（iDRAC/iLO/IPMI），以便网络断了还能救回。
- 每台 ESXi 建议保留/准备一个 **标准 vSwitch（vSS）临时管理口方案**（后面处理“vDS 端口占用无法移除”会用到）。
- 建议在动 vCenter 所在主机前：**先完成其他主机的汇聚**，并选一台作为 vCenter 迁移目标主机。

---

## 3. vCenter 上创建 vDS（vDS-Production）

1) vCenter → **网络** → 新建 **分布式交换机 vDS**
- 名称：`vDS-Production`
- 版本：8.0.0（按环境选择）
- 上行链路数：2
- 默认端口组：不创建（取消勾选），后面手动建更可控

> 交换机侧与 vSphere 侧必须采用一致的静态聚合模式。

---

## 4. 创建分布式端口组（dvPortgroup）

建议至少两个：
- `PG-MGMT`：给 VMkernel（管理口 vmk0）用
- `PG-VM`：给虚拟机业务网络用

> 可选增强：再建 `PG-vMotion`（给 vmk1）、`PG-Storage` 等，按实际网络规划。

### 4.1 端口组通用设置（与初稿一致，但补充注意点）

在 **绑定和故障切换（Teaming and failover）**：
- 负载均衡：**基于 IP 哈希的路由（IP Hash）**
- 网络故障检测：仅链路状态
- 上行链路：两条都 Active（不做 Standby）

**补充建议：**
- VLAN：务必在端口组里设置正确（Access VLAN 就填 VLAN ID；Trunk 就用 VLAN Trunking 范围）。
- MTU：如果 vMotion/存储网络需要巨帧，确保 vDS、dvPortgroup、交换机 Port-Channel 全链路 MTU 一致。

---

## 5. 批量加入“非 vCenter 所在主机”到 vDS（推荐顺序：先交换机后 vCenter）

> 为降低网络中断风险，建议先完成交换机端口聚合，再在 vCenter 中添加主机并迁移网络：
> **先在交换机配置 Port-Channel → 再在 vCenter 迁移网卡/VMkernel/虚拟机网络。**

对每台非 vCenter 所在主机（示例：esxi-host-a.example.internal）：

### 5.1 交换机侧（先做）
- 把 ESXi 的两口物理线对应的交换机端口加入同一个 **Port-Channel**（静态 on）
- 配置为 trunk/允许 VLAN（至少包含 MGMT、VM 等所需 VLAN）
- 建议开启边缘端口（PortFast edge trunk）/关闭不必要的保护策略（按交换机型号和组织规范配置）

### 5.2 vCenter 侧：添加与管理主机
右键 `vDS-Production` → **添加和管理主机** → 添加主机：
1) 选择 ESXi 主机（如 esxi-host-a.example.internal）
2) **管理物理适配器**：
   - vmnic0 → 上行链路1
   - vmnic1 → 上行链路2
3) **管理 VMkernel 适配器**：
   - 把 vmk0 迁移到 `PG-MGMT`
4) **迁移虚拟机网络**：
   - 把虚拟机网络迁移到 `PG-VM`（没虚拟机可跳过）
5) 完成后验证：
   - vCenter 能否正常管理该主机
   - ESXi Web（`https://<ESXI_HOST>`）是否可达
   - 虚拟机业务是否正常

> 按此流程重复，直到只剩 vCenter 所在 ESXi 主机未加入。

---

## 6. vCenter 所在 ESXi 主机（关键安全流程）

**vCenter 所在主机应最后处理**，并先迁移 vCenter VM，避免迁移管理网络时失去控制入口。

假设：vCenter 所在 ESXi 主机是 `esxi-vcenter-host.example.internal`，目标迁移主机是 `esxi-target-host.example.internal`。

### 6.1 启用 vMotion（两台主机都要）
- 在两台 ESXi 上编辑用于迁移的 VMkernel 接口（示例为 vmk0）→ 勾选 **vMotion** 服务

> 生产环境更推荐新建 vmk1 专用于 vMotion；临时复用 vmk0 也可完成在线迁移，但应评估管理流量与迁移流量相互影响。

### 6.2 迁移 vCenter 虚拟机（计算 + 存储一起迁移）
在 vCenter 里选中 vCenter 这台 VM：
- 迁移 → 选择类型：**更改计算资源和存储**
- 计算资源：选择目标主机 `esxi-target-host.example.internal`
- 存储：选择目标存储
- 网络：选择目标网络 `PG-VM`（按实际环境选择）
- vMotion 优先级：默认即可
- 开始迁移

**验证建议：**
- 全程持续执行 `ping`，观察迁移期间是否丢包
- 迁移完成后登录 vCenter UI 确认服务正常

### 6.3 为什么“主机+存储迁移”也能不中断？（简述原理）
- **vMotion**：先在目标主机预创建 VM，内存采用“预拷贝（pre-copy）”反复同步；最后短暂切换执行点（switchover），切换窗口通常很小，但仍应通过业务探测确认实际影响。
- **Storage vMotion**：存储数据后台搬迁，同时保持写入一致性；与 vMotion 组合后，可以同时迁移计算资源和存储。

### 6.4 现在再处理 esxi-vcenter-host.example.internal 的 vDS + LAG
- 按第 5 节的“先交换机聚合 → 再 vCenter 添加/迁移”流程，把 esxi-vcenter-host.example.internal 加入 vDS 并完成汇聚。

---

## 7. 验证清单（做完必须逐项过一遍）

### 7.1 vCenter / vDS 侧
- vDS → Hosts：所有主机状态正常、未出现不同步/告警
- dvPortgroup：IP Hash 生效、两条 uplink Active
- 健康检查（可选）：vDS 健康检查 / VLAN/MTU

### 7.2 ESXi 主机侧（命令验证）
在 ESXi Shell：
- 查看物理网卡：`esxcli network nic list`
- 查看 VMkernel：`esxcli network ip interface list`
- 查看到网关连通：`vmkping <网关IP>`
- vMotion 互通（如果单独网段/MTU）：`vmkping -I vmkX -d -s 8972 <对端IP>`（按 MTU 调整）

### 7.3 故障演练（推荐做）
- 临时拔掉一根上行线/Down 一个交换机端口：
  - 管理是否还能访问？
  - 虚拟机业务是否正常？
  - 观察 vDS uplink failover 状态

---

## 8. 常见问题与排查

### 8.1 vDS “不同步”/主机配置下发异常
常见思路：
- 确认主机在 vCenter 中是 Connected 状态
- 重启 ESXi 侧管理代理（谨慎操作，业务低峰）：重启 hostd/vpxa（仅在需要时）
- 检查 vDS uplink/端口组配置是否与交换机聚合匹配（尤其是 IP Hash + Port-Channel）

### 8.2 无法从 vDS 移除主机：提示端口仍被 vmk0 占用
典型报错类似：某 dvPort “仍在已连接到 … nic=vmk0 …”
含义：**vmk0 仍绑定在 vDS 的 dvPort 上，因此 vCenter 不允许移除主机。**

处理思路（安全做法）：
1) 在该 ESXi 上准备一个临时 **标准 vSwitch（vSS）+ PortGroup（同 VLAN）**
2) 把 vmk0 从 dvPortgroup 迁移回 vSS 的 PortGroup（在 vCenter 的“添加和管理主机 → 管理 VMkernel 适配器”里操作）
3) 确认管理网恢复、主机可达后，再从 vDS 移除主机/清理端口占用

> 若常规迁移路径受阻，可新建临时 vDS 承接网络，再从旧 vDS 中移除主机；操作前必须确认回滚入口。

### 8.3 最后手段：新建 vDS 迁移
如果某个 vDS 已绑定多主机且状态异常、迁移/移除卡死：
- 可以新建一个 vDS，把主机逐台迁移过去；
- 待旧 vDS 上所有主机迁走后，再清理旧 vDS。

---

## 9. 变更记录模板
- 每台主机的 Port-Channel 编号、交换机端口号、允许 VLAN 列表
- vDS/dvPortgroup 的 VLAN、MTU、Teaming 策略
- vCenter VM 迁移时间点、迁移目标主机/存储

---

### 附：关键配置原则
- 静态 LAG、ESXi 8.0.2、vCenter 8.0.3
- vDS：vDS-Production，上行 2，不建默认端口组
- dvPortgroup：PG-MGMT / PG-VM，IP Hash，链路状态检测，两 uplink Active
- 先处理非 vCenter 主机，vCenter 所在主机最后；先把 vCenter VM 迁走再做汇聚

## 参考资料

- [Broadcom EtherChannel 与 IP Hash 配置说明](https://knowledge.broadcom.com/external/article/321425)
