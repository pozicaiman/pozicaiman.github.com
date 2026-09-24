# CaiJianfeng 的技术博客

![Hexo](https://img.shields.io/badge/Hexo-8.1.2-blue)
![Theme](https://img.shields.io/badge/theme-indigo-7b68ee)
![Language](https://img.shields.io/badge/lang-zh--CN-red)
![Deploy](https://img.shields.io/badge/deploy-Gitee_Pages-orange)

站点地址：https://pozicaiman.gitee.io

## 快速开始

前置要求：Node.js ≥ 18、Git。

```bash
# 克隆仓库
git clone https://gitee.com/pozicaiman/pozicaiman.git
cd pozicaiman

# 安装依赖
npm install

# 本地预览（默认 http://localhost:4000）
npm run server
```

> **Windows 提示**：PowerShell 5 执行 `npx` 第一次可能触发脚本执行策略提示，允许即可。若端口 4000 被占用，先 `netstat -ano | findstr :4000` 查 PID 再 `taskkill /PID <id> /F`。

## 生成与部署

```bash
# 全量重建（清缓存 + 生成）
npm run clean
npm run build     # 等价于 hexo generate

# 部署到 Gitee Pages
npm run deploy    # 等价于 hexo deploy
```

部署流程由 `_config.yml` 的 `deploy` 段控制，当前配置：

```yaml
deploy:
  type: git
  repo: https://gitee.com/pozicaiman/pozicaiman.git
  branch: master
```

推送后 Gitee Pages 自动构建，约 1 分钟生效。

## 新增文档

新建 `source/_posts/<文章标题>.md`，front-matter 模板：

```yaml
---
title: 文章标题
date: 2026-09-24 15:00:00
categories: [分类A, 分类B]
tags: [标签1, 标签2]
---

正文……
```

Hexo 每次 generate 会自动重新计算所有分类和标签索引页，**不需要手动维护**：

- `/categories/<分类名>/index.html` — 自动生成
- `/tags/<标签名>/index.html` — 自动生成
- `/categories/`、`/tags/` — 聚合索引，来自 `source/categories/index.md` 和 `source/tags/index.md` 的 layout 路由（见"定制与踩坑"章节）

删除一个文档，它的分类/标签条目自动消失；改 front-matter，下次 generate 自动同步。

## 目录结构速查

```
.
├── _config.yml                      # Hexo 站点级配置（URL、theme、deploy 等）
├── package.json                     # Hexo 8.1.2 + 生成器依赖
├── scripts/
│   └── protect-math.js              # 自定义 filter：LaTeX 公式保护
├── source/
│   ├── _posts/                      # 所有文章（md）
│   ├── categories/index.md          # 分类聚合索引页（layout: categories）
│   └── tags/index.md                # 标签聚合索引页（layout: tags）
└── themes/
    └── indigo/
        └── source/js/main.js        # 已定制 TOC 中文 slug 兼容
```

## 定制与踩坑

> [!WARNING]
> 以下 4 项是本项目**独有的定制**，不是 Hexo/indigo 开箱即用的行为。clone 下来的新环境如果跑不起来，**先看这里**。

### 1. LaTeX 公式保护

| | |
|---|---|
| **位置** | `scripts/protect-math.js` |
| **做了什么** | `before_post_render` 把 `$...$` / `$$...$$` 整段替换成 `@@MJX:<hex>:@@` 无状态占位符，`after_post_render` 再解回 |
| **为什么** | Hexo 的 `hexo-renderer-marked` 遵循 CommonMark，会吞掉公式里的 `\{` `\}` `\;` `\_` 等反斜杠（如 `$\{x\}$` → `${x}$`），MathJax 收到的是残缺 LaTeX |
| **调试** | generate 时控制台会打印 `[protect] _posts/DL.md tokens=20`，如果有残留 token 会打印 `[restore] ... left_tokens=N` |

### 2. TOC 中文 slug 兼容

| | |
|---|---|
| **位置** | `themes/indigo/source/js/main.js` + 压缩后的 `main.min.js` |
| **做了什么** | 新增 `tocAnchorById(id)` 辅助函数，把标题 id 做 `encodeURIComponent` 编码后再去匹配 TOC href；三处 anchor 查找加 null-safety 跳过 |
| **为什么** | Hexo 渲染 TOC 时把中文 slug URL encode（如 `#1-%E5%BC%95%E8%A8%80...`），main.js 用未编码的原始中文 ID 去拼 `querySelector('a[href="#..."]')` → 匹配不上返回 `null` → `.parentNode` 崩溃 → 后续 `load` / `DOMContentLoaded` 监听器都没注册 → `#loading` 遮罩永远不消失 |

### 3. categories / tags 索引页 layout 路由

| | |
|---|---|
| **位置** | `source/categories/index.md`、`source/tags/index.md` 的 front-matter |
| **做了什么** | 写 `layout: categories` / `layout: tags`（不是 `type:` 字段） |
| **为什么** | `type: "categories"` 只是自定义元数据，Hexo **不会**用它选 layout；没设 layout 就走 `default_layout: page`，渲染成空壳 `page-article`，整个分类列表不出现 |

### 4. db.json stale 缓存

| | |
|---|---|
| **位置** | 全局 |
| **做了什么** | 遇到 front-matter 改了但页面没更新的情况，先 `hexo clean` 再 generate |
| **为什么** | `hexo server` 模式会写 `db.json` 持久化缓存，改完 front-matter 后可能仍返回旧 HTML。本项目首次迁移到 indigo 主题时 DL 页公式被修复后 server 仍返回旧破损版本，就是 stale cache 在作怪 |

## License

MIT
