/**
 * imgbed 标签插件 —— 博客配图双目录引用
 *
 * 用法（可在 Markdown 正文里直接写，Hexo 会渲染 {% %} 标签）：
 *   {% imgbed public  a1b2c3d4e5f6.png 架构图 %}
 *   {% imgbed private c3d4e5f6a7b8.png 内部截图 %}
 *
 * 展开规则：
 *   public  -> 绝对公网 URL： <site.url>/images/public/<文件>   （可被外部直接外链分享）
 *   private -> 站内根相对路径： /images/private/<文件>            （随博客一起发布）
 *
 * 图片实体位于 source/images/<type>/，hexo generate 时原样静态拷贝进 docs/images/<type>/。
 * 上传与哈希命名请用 tools/imgbed.js（npm run imgbed）。
 */
'use strict';

const VALID = new Set(['public', 'private']);

function siteBase() {
  return String(hexo.config.url || '').replace(/\/+$/, '');
}

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function imgbedTag(args) {
  const type = String(args[0] || '').toLowerCase();
  const file = args[1] || '';
  const alt = args.slice(2).join(' ');

  if (!VALID.has(type)) {
    return `<em class="imgbed-err">[imgbed] 类型必须是 public 或 private，收到：${escapeAttr(type)}</em>`;
  }
  if (!file) {
    return '<em class="imgbed-err">[imgbed] 缺少文件名</em>';
  }

  const src = type === 'public'
    ? `${siteBase()}/images/public/${file}`   // 专有的公网绝对路径
    : `/images/private/${file}`;              // 站内根相对路径

  return `<img src="${src}" alt="${escapeAttr(alt)}" loading="lazy">`;
}

hexo.extend.tag.register('imgbed', imgbedTag, { escape: false });
