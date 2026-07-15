#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const contentDir = path.join(root, 'content');
const postsDir = path.join(root, 'posts');
const assetVersion = '20260715-list';

const posts = [
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
    sourceTitle: 'Kubernetes Ingress-Nginx 部署与日志配置手册',
    title: 'Ingress-Nginx 部署与访问日志配置手册',
    slug: 'ingress-nginx-deployment-logging', category: 'Kubernetes', symbol: 'ING',
    summary: '对比两种部署方式，并说明 NodePort 暴露、日志格式调整与变更验证方法。',
    tags: ['Ingress', '日志']
  },
  {
    sourceTitle: 'Kubernetes 环境 Harbor 私有镜像仓库部署与访问说明',
    title: '在 Kubernetes 中部署 Harbor 私有镜像仓库',
    slug: 'harbor-on-kubernetes', category: 'Kubernetes', symbol: 'HBR',
    summary: '使用 Helm 部署 Harbor，配置 TLS、Ingress 与 NodePort，并完成镜像推送验证。',
    tags: ['Harbor', '镜像仓库']
  },
  {
    sourceTitle: 'Headlamp 多集群只读接入与发布手册',
    title: 'Headlamp 多集群只读接入与发布手册',
    slug: 'headlamp-multi-cluster-readonly', category: 'Kubernetes', symbol: 'HLM',
    summary: '通过最小权限 RBAC 和多集群 kubeconfig，为 Headlamp 建立安全的只读管理入口。',
    tags: ['Headlamp', 'RBAC']
  },
  {
    sourceTitle: 'MySQL GTID主从复制部署与故障处理手册',
    title: 'MySQL GTID 主从复制部署与故障处理手册',
    slug: 'mysql-gtid-replication', category: 'MySQL', symbol: 'SQL',
    summary: '覆盖 GTID 复制配置、初始同步、状态验证，以及常见复制中断的处理思路。',
    tags: ['GTID', '主从复制']
  },
  {
    sourceTitle: 'MySQL备份与恢复操作手册',
    title: 'MySQL 备份与恢复操作手册',
    slug: 'mysql-backup-restore', category: 'MySQL', symbol: 'BAK',
    summary: '对比 mysqldump 与 XtraBackup 的适用场景，整理备份、恢复和完整性验证步骤。',
    tags: ['备份', '恢复']
  },
  {
    sourceTitle: 'MySQL 8.0 RPM 安装与数据目录迁移操作手册',
    title: 'MySQL 8.0 RPM 安装与数据目录迁移手册',
    slug: 'mysql-8-rpm-data-migration', category: 'MySQL', symbol: '8.0',
    summary: '记录 RPM 安装、初始化、安全配置，以及数据目录迁移与回滚检查方法。',
    tags: ['安装', '数据迁移']
  },
  {
    sourceTitle: 'Linux网卡Bond绑定配置与维护手册',
    title: 'Linux 网卡 Bond 配置与维护手册',
    slug: 'linux-bond', category: 'Linux', symbol: 'BND',
    summary: '说明常用 Bond 模式、NetworkManager 配置流程，以及切换和故障验证方法。',
    tags: ['网络', 'Bond']
  },
  {
    sourceTitle: 'Linux服务器病毒扫描与KVRT使用说明',
    title: 'Linux 服务器病毒扫描与 KVRT 使用说明',
    slug: 'linux-kvrt-virus-scan', category: 'Linux', symbol: 'SEC',
    summary: '整理 KVRT 下载、执行、扫描结果解读与生产环境使用时的安全注意事项。',
    tags: ['安全', 'KVRT']
  },
  {
    sourceTitle: 'vCenter 创建虚拟机报 PBM / Profile-Driven Storage Service 错误处理记录',
    title: 'vCenter PBM / SPS 服务异常排查记录',
    slug: 'vcenter-pbm-sps-troubleshooting', category: '平台运维', symbol: 'VC',
    summary: '从 SPS 服务、核心依赖和磁盘空间入手，复盘虚拟机创建失败的定位与恢复过程。',
    tags: ['vCenter', '故障复盘']
  },
  {
    sourceTitle: 'RedisInsight 内网部署与访问控制配置手册',
    title: 'RedisInsight 内网部署与访问控制手册',
    slug: 'redisinsight-intranet', category: '平台运维', symbol: 'RDS',
    summary: '通过 Docker Compose 部署 RedisInsight，并使用 Nginx 基础认证收紧访问边界。',
    tags: ['Redis', '访问控制']
  },
  {
    sourceTitle: 'v2rayA容器部署与局域网代理使用手册',
    title: 'v2rayA 容器部署与局域网代理使用手册',
    slug: 'v2raya-lan-proxy', category: '平台运维', symbol: 'NET',
    summary: '记录容器化部署、局域网代理参数，以及终端、Docker 与 systemd 服务的代理配置。',
    tags: ['代理', 'Docker']
  },
  {
    sourceTitle: '阿里云 OSS 文件传输与备份操作手册',
    title: '阿里云 OSS 文件传输与备份操作手册',
    slug: 'aliyun-oss-backup', category: '平台运维', symbol: 'OSS',
    summary: '使用 ossutil 完成大文件上传、下载、校验和定期备份，并说明内外网 Endpoint 选择。',
    tags: ['阿里云', '备份']
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
  const nextIndex = indexHtml.replace(new RegExp(`${start}[\\s\\S]*?${end}`), `${start}\n${homeCards()}\n          ${end}`);
  fs.writeFileSync(indexFile, nextIndex, 'utf8');
  fs.writeFileSync(path.join(root, 'posts.json'), JSON.stringify(posts.map(({ sourceTitle, symbol, ...post }) => post), null, 2) + '\n', 'utf8');
}

build();
console.log(`已生成 ${posts.length} 篇文章。`);
