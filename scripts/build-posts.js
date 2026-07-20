#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const contentDir = path.join(root, 'content');
const postsDir = path.join(root, 'posts');
const assetVersion = '20260720-batch-8';

const posts = [
  {
    sourceTitle: 'Calico CNI 网络模式详解与 Kubernetes 部署配置指南',
    title: 'Calico CNI 网络模式选择、部署与变更手册',
    slug: 'calico-network-modes-deployment', category: 'Kubernetes', symbol: 'CNI',
    summary: '对比 IP-in-IP、VXLAN、CrossSubnet 与无封装网络，覆盖 Operator 部署、IPPool 变更、验证和回滚。',
    tags: ['Calico', 'CNI']
  },
  {
    sourceTitle: 'OpenVPN 多场景部署与运维手册',
    title: 'OpenVPN 多场景部署与安全运维手册',
    slug: 'openvpn-multi-scenario-operations', category: '平台运维', symbol: 'VPN',
    summary: '覆盖内网互通、统一出口、多 VPC 路由、客户端冲突规避、认证安全与日常故障排查。',
    tags: ['OpenVPN', '网络']
  },
  {
    sourceTitle: 'vCenter (Photon OS 4) 持久化静态路由配置方法',
    title: 'vCenter Photon OS 4 持久化静态路由',
    slug: 'vcenter-photon-static-routes', category: '平台运维', symbol: 'RT',
    summary: '使用 systemd-networkd 为 Photon OS 4 配置持久化静态路由，并通过局部 reload 与 reconfigure 降低网络中断风险。',
    tags: ['vCenter', '路由']
  },
  {
    sourceTitle: 'vCenter + ESXi 分布式交换机（vDS）+ 静态 LAG（Port-Channel/EtherChannel）配置笔记（优化版）',
    title: 'vSphere vDS 与静态 EtherChannel 配置手册',
    slug: 'vsphere-vds-static-etherchannel', category: '平台运维', symbol: 'vDS',
    summary: '梳理 vDS、静态 Port-Channel 与 IP Hash 的一致性要求，以及管理网络和 vCenter 虚拟机的安全迁移顺序。',
    tags: ['vDS', 'EtherChannel']
  },
  {
    sourceTitle: 'RedisInsight 内网部署与访问控制配置手册',
    title: 'RedisInsight 内网部署与访问控制手册',
    slug: 'redisinsight-intranet', category: 'Redis', symbol: 'UI',
    summary: '使用 Docker Compose 部署 RedisInsight，并通过 Nginx Basic Auth、网络限制和凭据隔离收紧访问边界。',
    tags: ['RedisInsight', '访问控制']
  },
  {
    sourceTitle: 'MySQL GTID主从复制部署与故障处理手册',
    title: 'MySQL GTID 复制部署与故障处理手册',
    slug: 'mysql-gtid-replication', category: 'MySQL', symbol: 'GTID',
    summary: '覆盖 MySQL 8.0 GTID 与位点复制配置、初始化、状态验证，以及中继日志和异常事务处理。',
    tags: ['GTID', '复制']
  },
  {
    sourceTitle: 'Headlamp 多集群只读接入与发布手册',
    title: 'Headlamp 多集群只读接入与发布手册',
    slug: 'headlamp-multi-cluster-readonly', category: 'Kubernetes', symbol: 'HLM',
    summary: '通过最小权限 RBAC、多集群 kubeconfig 和 Gateway API，为 Headlamp 建立受控的只读访问入口。',
    tags: ['Headlamp', 'RBAC']
  },
  {
    sourceTitle: 'Helm 与 ChartMuseum 私有仓库部署操作手册',
    title: 'Helm 与 ChartMuseum 私有仓库操作手册',
    slug: 'helm-chartmuseum-repository', category: 'Kubernetes', symbol: 'HELM',
    summary: '整理 Helm 仓库、Chart 生命周期、ChartMuseum 部署与推送流程，并补充认证、TLS 和存储安全建议。',
    tags: ['Helm', 'ChartMuseum']
  },
  {
    sourceTitle: 'RedisShake 实时同步部署与配置手册',
    title: 'RedisShake 实时同步部署与配置手册',
    slug: 'redisshake-realtime-sync', category: 'Redis', symbol: 'SYNC',
    summary: '使用 sync_reader 和 redis_writer 实现 Redis 全量加增量同步，说明冲突键、版本兼容和割接验证策略。',
    tags: ['RedisShake', '数据迁移']
  },
  {
    sourceTitle: 'Kubernetes 中 ProxySQL 读写分离部署与运维手册',
    title: 'Kubernetes 中部署 ProxySQL 读写分离',
    slug: 'proxysql-kubernetes-read-write-split', category: 'MySQL', symbol: 'PXY',
    summary: '在 Kubernetes 中部署 ProxySQL，配置后端主从、查询路由、业务入口，并验证读写落点与故障回落。',
    tags: ['ProxySQL', '读写分离']
  },
  {
    sourceTitle: 'Rook-Ceph 生产部署与分层存储运维手册',
    title: 'Rook-Ceph 生产部署与分层存储运维手册',
    slug: 'rook-ceph-production-storage', category: 'Kubernetes', symbol: 'CEPH',
    summary: '覆盖 Rook-Ceph 部署、SSD/HDD 分层池、Gateway、对象存储、容量规划及 OSD 安全更换流程。',
    tags: ['Rook-Ceph', '存储']
  },
  {
    sourceTitle: 'MySQL备份与恢复操作手册',
    title: 'MySQL 备份与恢复操作手册',
    slug: 'mysql-backup-restore', category: 'MySQL', symbol: 'BAK',
    summary: '对比 mysqldump 与 Percona XtraBackup，整理全量、增量备份、恢复链合并和恢复验证流程。',
    tags: ['备份', 'XtraBackup']
  },
  {
    sourceTitle: '一次 MySQL 生产库误删除事故恢复实战：延迟从库 + Binlog 实现数据找回',
    title: 'MySQL 误删库恢复：延迟复制与 Binlog 实战',
    slug: 'mysql-drop-database-delayed-replica-pitr', category: 'MySQL', symbol: 'PITR',
    summary: '复盘一次误删库事故，说明如何冻结延迟副本、定位危险 GTID、恢复到误操作前并安全完成业务切换。',
    tags: ['延迟复制', 'PITR']
  },
  {
    sourceTitle: 'Nightingale 监控平台部署与扩展采集手册',
    title: 'Kubernetes 中部署 Nightingale 与扩展采集',
    slug: 'nightingale-kubernetes-deployment', category: '可观测性', symbol: 'N9E',
    summary: '使用 Helm 部署 Nightingale，比较 Prometheus 与 VictoriaMetrics 存储方案，并扩展 Kubernetes 和 Elasticsearch 指标采集。',
    tags: ['Nightingale', 'Categraf']
  },
  {
    sourceTitle: 'vSphere 监控接入与 Categraf 部署手册',
    title: 'vSphere 监控接入与 Categraf 部署手册',
    slug: 'vsphere-monitoring-categraf', category: '可观测性', symbol: 'VS',
    summary: '对比 vmware_exporter 中转与 Categraf 直连两种采集链路，覆盖凭据管理、部署验证和常见故障排查。',
    tags: ['vSphere', 'Categraf']
  },
  {
    sourceTitle: 'iDRAC 指标采集部署与 Categraf 对接手册',
    title: 'iDRAC 指标采集与 Categraf 对接手册',
    slug: 'idrac-monitoring-categraf', category: '可观测性', symbol: 'BMC',
    summary: '在 Kubernetes 中部署 iDRAC Exporter，通过 Categraf 批量采集服务器 BMC 指标，并说明凭据与网络安全边界。',
    tags: ['iDRAC', 'BMC']
  },
  {
    sourceTitle: 'ESXi主机磁盘SMART监控部署与接入手册',
    title: 'ESXi 主机磁盘 SMART 监控部署手册',
    slug: 'esxi-smart-monitoring', category: '可观测性', symbol: 'SMART',
    summary: '通过 SSH 调用 esxcli 采集 ESXi 磁盘 SMART 信息，以 Prometheus 指标暴露并接入 Categraf。',
    tags: ['ESXi', 'SMART']
  },
  {
    sourceTitle: '网络设备SNMP监控采集部署手册',
    title: '网络设备 SNMP 监控与 Categraf 采集手册',
    slug: 'network-snmp-categraf', category: '可观测性', symbol: 'SNMP',
    summary: '使用 Categraf SNMP 插件采集网络设备系统与接口指标，覆盖 OID 配置、连通性验证和采集稳定性排查。',
    tags: ['SNMP', '网络设备']
  },
  {
    sourceTitle: '日志链路压测与瓶颈排查操作手册',
    title: '日志链路压测与瓶颈定位操作手册',
    slug: 'log-pipeline-load-testing', category: '可观测性', symbol: 'LOG',
    summary: '使用可控日志生成器逐级提升流量，并结合 Kafka Lag、Logstash PQ 和 Elasticsearch 写入指标定位持续吞吐瓶颈。',
    tags: ['日志链路', '压测']
  },
  {
    sourceTitle: 'Categraf-Ceph 无法采集 Ceph Metrics 事件记录',
    title: 'Categraf 无法采集 Ceph Metrics：503 故障复盘',
    slug: 'categraf-ceph-metrics-503', category: '可观测性', symbol: 'CEPH',
    summary: '从采集端 503 追踪到 Ceph mgr Prometheus 模块的陈旧缓存策略，并记录主备切换、验证和安全回滚方法。',
    tags: ['Categraf', 'Ceph']
  },
  {
    sourceTitle: 'Redis AOF 损坏导致实例启动失败处理文档',
    title: 'Redis AOF 损坏导致启动失败的修复与验证',
    slug: 'redis-aof-corruption-recovery', category: 'Redis', symbol: 'AOF',
    summary: '通过日志和 redis-check-aof 确认多段 AOF 损坏，完成备份、风险评估、修复及持久化状态验证。',
    tags: ['AOF', '故障恢复']
  },
  {
    sourceTitle: 'vCenter UI 无法打开虚拟机 Web 控制台排障笔记（Missing JWT / 授权数据同步失败）',
    title: 'vCenter Web 控制台 Missing JWT 故障排查',
    slug: 'vcenter-web-console-missing-jwt', category: '平台运维', symbol: 'JWT',
    summary: '沿着 HVC、vpxd-svcs、内部 SSL 和 Machine SSL 证书链，定位 Web 控制台与授权同步同时失败的根因。',
    tags: ['vCenter', '证书']
  },
  {
    sourceTitle: 'vCenter UI 故障修复文档',
    title: 'vCenter UI 故障：服务依赖与 PostgreSQL 损坏修复复盘',
    slug: 'vcenter-ui-vpxd-postgresql-recovery', category: '平台运维', symbol: 'VC',
    summary: '复盘 vCenter 服务依赖链未完整启动与 PostgreSQL 统计信息损坏叠加导致的 UI 故障，并明确高风险数据库操作边界。',
    tags: ['vCenter', 'PostgreSQL']
  },
  {
    sourceTitle: 'Kubernetes 1.34 高可用集群部署与 Calico 网络配置手册',
    title: 'Kubernetes 1.34 高可用集群与 Calico 部署手册',
    slug: 'kubernetes-1-34-ha-calico', category: 'Kubernetes', symbol: 'K8s',
    summary: '从系统初始化、容器运行时到控制平面高可用与 Calico 网络，完整搭建生产级 Kubernetes 集群。',
    tags: ['高可用', 'Calico']
  },
  {
    sourceTitle: 'Kubernetes 中 NGINX Gateway Fabric 的部署配置与运维实践',
    title: 'NGINX Gateway Fabric 部署、配置与运维实践',
    slug: 'nginx-gateway-fabric', category: 'Kubernetes', symbol: 'GW',
    summary: '围绕 Gateway API 梳理 NGF 的安装、路由、TLS、策略、监控与日常故障排查。',
    tags: ['Gateway API', 'NGINX']
  },
  {
    sourceTitle: 'Linux网卡Bond绑定配置与维护手册',
    title: 'Linux 网卡 Bond 配置与维护手册',
    slug: 'linux-bond', category: 'Linux', symbol: 'BND',
    summary: '说明常用 Bond 模式、NetworkManager 配置流程，以及切换和故障验证方法。',
    tags: ['网络', 'Bond']
  },
  {
    sourceTitle: 'vCenter 创建虚拟机报 PBM / Profile-Driven Storage Service 错误处理记录',
    title: 'vCenter PBM / SPS 服务异常排查记录',
    slug: 'vcenter-pbm-sps-troubleshooting', category: '平台运维', symbol: 'VC',
    summary: '从 SPS 服务、核心依赖和磁盘空间入手，复盘虚拟机创建失败的定位与恢复过程。',
    tags: ['vCenter', '故障复盘']
  },
  {
    sourceTitle: 'v2rayA容器部署与局域网代理使用手册',
    title: 'v2rayA 容器部署与局域网代理使用手册',
    slug: 'v2raya-lan-proxy', category: '平台运维', symbol: 'NET',
    summary: '记录容器化部署、局域网代理参数，以及终端、Docker 与 systemd 服务的代理配置。',
    tags: ['代理', 'Docker']
  },
  {
    sourceTitle: 'HTTP压测工具使用与结果分析手册',
    title: 'HTTP 压测工具使用与结果分析手册',
    slug: 'http-load-testing', category: '工具方法', symbol: 'HTTP',
    summary: '对比 oha 与 JMeter 的使用场景，说明并发参数、指标含义和结果分析方法。',
    tags: ['性能测试', 'oha']
  }
];

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function inlineMarkdown(text) {
  const code = [];
  let value = text.replace(/`([^`]+)`/g, (_, content) => {
    const token = `\u0000CODE${code.length}\u0000`;
    code.push(`<code>${escapeHtml(content)}</code>`);
    return token;
  });

  value = escapeHtml(value)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');

  code.forEach((html, index) => {
    value = value.replace(`\u0000CODE${index}\u0000`, html);
  });
  return value;
}

function splitTableRow(line) {
  return line.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim());
}

function renderMarkdown(markdown) {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const output = [];
  const headings = [];
  let paragraph = [];
  let list = null;
  let headingNumber = 0;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    output.push(`<p>${inlineMarkdown(paragraph.join(' '))}</p>`);
    paragraph = [];
  };

  const flushList = () => {
    if (!list) return;
    const tag = list.type === 'ol' ? 'ol' : 'ul';
    output.push(`<${tag} class="article-list">`);
    for (const item of list.items) {
      output.push(`<li class="list-depth-${Math.min(item.depth, 3)}">${inlineMarkdown(item.text)}</li>`);
    }
    output.push(`</${tag}>`);
    list = null;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    if (index === 0 && /^#\s+/.test(line)) continue;

    const fence = line.match(/^```\s*([\w.+-]*)\s*$/);
    if (fence) {
      flushParagraph(); flushList();
      const codeLines = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index])) {
        codeLines.push(lines[index]); index += 1;
      }
      const language = fence[1] ? ` class="language-${escapeHtml(fence[1])}"` : '';
      output.push(`<pre><code${language}>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      flushParagraph(); flushList();
      const level = heading[1].length === 1 ? 2 : heading[1].length;
      const id = `section-${++headingNumber}`;
      const text = heading[2].replace(/`/g, '');
      headings.push({ level, id, text });
      output.push(`<h${level} id="${id}">${inlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }

    const image = line.match(/^!\[([^\]]*)\]\((\/assets\/[A-Za-z0-9_./-]+\.(?:png|jpe?g|webp|gif))(?:\s+"([^"]*)")?\)$/i);
    if (image) {
      flushParagraph(); flushList();
      const alt = escapeHtml(image[1]);
      const src = escapeHtml(image[2]);
      const caption = image[3] ? `<figcaption>${escapeHtml(image[3])}</figcaption>` : '';
      output.push(`<figure class="article-figure"><img src="${src}" alt="${alt}" loading="lazy" decoding="async" />${caption}</figure>`);
      continue;
    }

    if (/^\s*(?:---+|\*\*\*+)\s*$/.test(line)) {
      flushParagraph(); flushList(); output.push('<hr />'); continue;
    }

    if (/^>\s?/.test(line)) {
      flushParagraph(); flushList();
      const quoteLines = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^>\s?/, '')); index += 1;
      }
      index -= 1;
      output.push(`<blockquote><p>${inlineMarkdown(quoteLines.join(' '))}</p></blockquote>`);
      continue;
    }

    if (/^\s*\|?.+\|.+\|?\s*$/.test(line) && index + 1 < lines.length && /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?\s*$/.test(lines[index + 1])) {
      flushParagraph(); flushList();
      const headers = splitTableRow(line);
      index += 2;
      const rows = [];
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
        rows.push(splitTableRow(lines[index])); index += 1;
      }
      index -= 1;
      output.push('<div class="table-wrap"><table><thead><tr>');
      headers.forEach(cell => output.push(`<th>${inlineMarkdown(cell)}</th>`));
      output.push('</tr></thead><tbody>');
      rows.forEach(row => {
        output.push('<tr>'); row.forEach(cell => output.push(`<td>${inlineMarkdown(cell)}</td>`)); output.push('</tr>');
      });
      output.push('</tbody></table></div>');
      continue;
    }

    const unordered = line.match(/^(\s*)[-*+]\s+(.+)$/);
    const ordered = line.match(/^(\s*)\d+[.)]\s+(.+)$/);
    if (unordered || ordered) {
      flushParagraph();
      const match = unordered || ordered;
      const type = ordered ? 'ol' : 'ul';
      if (list && list.type !== type) flushList();
      if (!list) list = { type, items: [] };
      list.items.push({ depth: Math.floor(match[1].length / 2), text: match[2] });
      continue;
    }

    if (!line.trim()) {
      flushParagraph(); flushList(); continue;
    }

    paragraph.push(line.trim());
  }

  flushParagraph(); flushList();
  return { html: output.join('\n'), headings };
}

function estimateMinutes(markdown) {
  const prose = markdown.replace(/```[\s\S]*?```/g, '').length;
  const code = (markdown.match(/```[\s\S]*?```/g) || []).join('').split('\n').length;
  return Math.max(4, Math.ceil(prose / 650 + code / 35));
}

function articleTemplate(post, markdown) {
  const rendered = renderMarkdown(markdown);
  const minutes = estimateMinutes(markdown);
  const toc = rendered.headings
    .filter(item => item.level <= 3)
    .map(item => `<a class="toc-level-${item.level}" href="#${item.id}">${escapeHtml(item.text)}</a>`)
    .join('\n          ');

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="description" content="${escapeHtml(post.summary)}" />
    <meta name="theme-color" content="#f4f1e8" />
    <title>${escapeHtml(post.title)} | Yalex 的技术笔记</title>
    <link rel="stylesheet" href="/assets/css/main.css?v=${assetVersion}" />
    <script src="/assets/js/main.js?v=${assetVersion}" defer></script>
  </head>
  <body>
    <a class="skip-link" href="#article">跳到正文</a>
    <header class="site-header">
      <div class="shell nav-wrap">
        <a class="brand" href="/">
          <span class="brand-mark" aria-hidden="true">Y</span>
          <span><strong>Yalex</strong><small>技术笔记</small></span>
        </a>
        <nav class="site-nav" aria-label="主导航">
          <a href="/#articles">文章</a><a href="/#topics">专题</a><a href="/#about">关于</a>
          <a href="https://github.com/Taier05" target="_blank" rel="noreferrer">GitHub</a>
        </nav>
        <button class="theme-toggle" type="button" aria-label="切换深浅色主题" title="切换主题"><span class="theme-icon" aria-hidden="true">◐</span></button>
      </div>
    </header>

    <main id="article">
      <header class="article-header">
        <a class="breadcrumb" href="/"><span aria-hidden="true">←</span> 返回文章列表</a>
        <p class="article-category">${escapeHtml(post.category)}</p>
        <h1>${escapeHtml(post.title)}</h1>
        <p class="article-lead">${escapeHtml(post.summary)}</p>
        <div class="article-info"><span>技术手册</span><span>约 ${minutes} 分钟阅读</span><span>持续更新</span></div>
      </header>

      <div class="article-cover cover-${post.category === 'MySQL' ? 'mysql' : post.category === 'Linux' ? 'linux' : post.category === 'Kubernetes' ? 'kubernetes' : 'platform'}" aria-hidden="true">
        <div class="article-cover-inner"><span>${escapeHtml(post.category.toUpperCase())}</span><strong>${escapeHtml(post.symbol)}</strong><p>Yalex / Technical Notes</p></div>
      </div>

      <div class="article-layout">
        <aside class="article-toc" aria-label="文章目录"><strong>本文目录</strong>${toc ? `\n          ${toc}` : ''}</aside>
        <article class="article-body">
          <div class="callout article-safety"><strong>安全说明</strong><p>文中的地址、域名、账户和凭证均为示例或已脱敏，请按实际环境替换后再执行。</p></div>
${rendered.html}
          <div class="article-end">本文由 Yalex 的工作笔记整理而成。如用于生产环境，请先在测试环境验证并准备回滚方案。</div>
        </article>
      </div>
    </main>

    <footer class="site-footer"><div class="shell footer-inner"><p>© <span id="current-year">2026</span> Yalex.</p><a href="#article">回到顶部 ↑</a></div></footer>
  </body>
</html>
`;
}

function homeCards() {
  return posts.map((post, index) => {
    const minutes = estimateMinutes(fs.readFileSync(path.join(contentDir, `${post.slug}.md`), 'utf8'));
    const tags = post.tags.map(tag => escapeHtml(tag)).join(' · ');
    const searchText = [post.title, post.summary, post.category, ...post.tags].join(' ').toLowerCase();
    const number = String(index + 1).padStart(2, '0');
    return `          <article class="note-row" data-category="${escapeHtml(post.category)}" data-search="${escapeHtml(searchText)}">
            <a class="note-row-link" href="/posts/${post.slug}.html">
              <span class="note-index" aria-hidden="true">${number}</span>
              <div class="note-main">
                <div class="note-eyebrow"><strong>${escapeHtml(post.category)}</strong><span>${tags}</span></div>
                <h3 class="note-title">${escapeHtml(post.title)}</h3>
                <p class="note-summary">${escapeHtml(post.summary)}</p>
              </div>
              <span class="note-time">${minutes} 分钟阅读</span>
              <span class="note-arrow" aria-hidden="true">→</span>
            </a>
          </article>`;
  }).join('\n\n');
}

function homeFilters() {
  const preferredOrder = ['Kubernetes', 'MySQL', 'Linux', 'Redis', '可观测性', '平台运维', '工具方法'];
  const counts = posts.reduce((result, post) => {
    result.set(post.category, (result.get(post.category) || 0) + 1);
    return result;
  }, new Map());
  const categories = preferredOrder.filter(category => counts.has(category));
  for (const category of counts.keys()) if (!categories.includes(category)) categories.push(category);

  const buttons = [
    `<button class="filter-button active" type="button" data-filter="all" aria-pressed="true">全部 <span>${posts.length}</span></button>`,
    ...categories.map(category => `<button class="filter-button" type="button" data-filter="${escapeHtml(category)}" aria-pressed="false">${escapeHtml(category)} <span>${counts.get(category)}</span></button>`)
  ];
  return buttons.map(button => `            ${button}`).join('\n');
}

function build() {
  fs.mkdirSync(postsDir, { recursive: true });
  for (const post of posts) {
    const sourceFile = path.join(contentDir, `${post.slug}.md`);
    if (!fs.existsSync(sourceFile)) throw new Error(`缺少博客源文件：${sourceFile}`);
    const markdown = fs.readFileSync(sourceFile, 'utf8');
    fs.writeFileSync(path.join(postsDir, `${post.slug}.html`), articleTemplate(post, markdown), 'utf8');
  }

  const indexFile = path.join(root, 'index.html');
  const indexHtml = fs.readFileSync(indexFile, 'utf8');
  const start = '<!-- POSTS_START -->';
  const end = '<!-- POSTS_END -->';
  if (!indexHtml.includes(start) || !indexHtml.includes(end)) throw new Error('首页缺少文章生成标记');
  const filterStart = '<!-- FILTERS_START -->';
  const filterEnd = '<!-- FILTERS_END -->';
  if (!indexHtml.includes(filterStart) || !indexHtml.includes(filterEnd)) throw new Error('首页缺少分类生成标记');
  let nextIndex = indexHtml.replace(new RegExp(`${start}[\\s\\S]*?${end}`), `${start}\n${homeCards()}\n          ${end}`);
  nextIndex = nextIndex.replace(new RegExp(`${filterStart}[\\s\\S]*?${filterEnd}`), `${filterStart}\n${homeFilters()}\n            ${filterEnd}`);
  nextIndex = nextIndex.replace(/(<strong id="notes-result-count">)\d+/, `$1${posts.length}`);
  nextIndex = nextIndex.replace(/(<span class="page-range" id="notes-page-range">)[^<]+/, `$1${`1–${Math.min(20, posts.length)} / ${posts.length}`}`);
  fs.writeFileSync(indexFile, nextIndex, 'utf8');
  fs.writeFileSync(path.join(root, 'posts.json'), JSON.stringify(posts.map(({ sourceTitle, symbol, ...post }) => post), null, 2) + '\n', 'utf8');
}

build();
console.log(`已生成 ${posts.length} 篇文章。`);
