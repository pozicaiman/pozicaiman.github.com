#!/usr/bin/env node
/**
 * imgbed 上传脚本 —— 把本地图片放进 blog 图床双目录，并打印可直接粘贴的引用片段。
 *
 * 用法：
 *   npm run imgbed -- public  ./tmp/shot.png 架构图
 *   npm run imgbed -- private ./tmp/draft.png 内部截图
 *   node tools/imgbed.js public ./tmp/shot.png
 *
 * 行为：
 *   1) 对图片字节算 sha1，取前 12 位 + 原扩展名做文件名（内容寻址，天然去重、免缓存陈旧）
 *   2) 复制到 source/images/<type>/<hash>.<ext>（已存在则跳过，不重复写）
 *   3) 打印 {% imgbed %} 标签写法与等价 Markdown，供直接粘进文档
 *
 * public  -> 引用绝对公网 URL <site.url>/images/public/<hash>.<ext>
 * private -> 引用站内路径      /images/private/<hash>.<ext>
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const IMG_ROOT = path.join(ROOT, 'source', 'images');
const CONFIG = path.join(ROOT, '_config.yml');

function readSiteUrl() {
  try {
    const m = fs.readFileSync(CONFIG, 'utf8').match(/^url:\s*(\S+)\s*$/m);
    return m ? m[1].replace(/\/+$/, '') : 'https://pozicaiman.github.io';
  } catch (e) {
    return 'https://pozicaiman.github.io';
  }
}

function hashName(buf, ext) {
  return crypto.createHash('sha1').update(buf).digest('hex').slice(0, 12) + ext;
}

function usage() {
  console.log('用法: npm run imgbed -- <public|private> <本地图片路径> [图片描述]');
  console.log('示例: npm run imgbed -- public ./tmp/shot.png "服务拓扑图"');
}

function main() {
  const [type, src, ...altParts] = process.argv.slice(2);
  const alt = altParts.join(' ');

  if (!type) { usage(); return; }
  if (!['public', 'private'].includes(type)) {
    console.error(`✘ 类型必须是 public 或 private，收到: ${type}`);
    usage();
    process.exit(1);
  }
  if (!src) {
    console.error('✘ 缺少本地图片路径');
    usage();
    process.exit(1);
  }

  const abs = path.resolve(process.cwd(), src);
  if (!fs.existsSync(abs)) {
    console.error(`✘ 找不到文件: ${abs}`);
    process.exit(1);
  }

  const buf = fs.readFileSync(abs);
  const ext = (path.extname(abs) || '.png').toLowerCase();
  const name = hashName(buf, ext);

  const dir = path.join(IMG_ROOT, type);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, name);

  const isNew = !fs.existsSync(dest);
  if (isNew) fs.writeFileSync(dest, buf);

  const base = readSiteUrl();
  const ref = type === 'public' ? `${base}/images/public/${name}` : `/images/private/${name}`;

  console.log(isNew
    ? `✔ 已存入  source/images/${type}/${name}  (${(buf.length / 1024).toFixed(1)} KB)`
    : `• 内容已存在(哈希去重)，未重复写入  source/images/${type}/${name}`);
  console.log('');
  console.log('粘贴到 blog 文档 —— 标签写法:');
  console.log(`  {% imgbed ${type} ${name}${alt ? ' ' + alt : ''} %}`);
  console.log('等价 Markdown:');
  console.log(`  ![${alt}](${ref})`);
}

main();
