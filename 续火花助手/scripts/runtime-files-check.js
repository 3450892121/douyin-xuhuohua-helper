'use strict';
/* rebuild 打包自检的纯函数集合（被 scripts/rebuild-unpacked.js 与测试共用）。
 *
 * 背景：曾发生「rebuild 把整目录删除重建时漏拷 lib/notify.js → 打包版启动即崩」的线上问题
 * （main.js 顶层 require 了新文件，但 rebuild 的拷贝清单没跟上）。此后拷贝改为目录整体拷贝
 * （inject/ui/lib）+ 顶层文件白名单，并在打包完成后扫描 main.js 里所有「相对加载的运行时文件」，
 * 逐个核对是否就位，把「静默产出坏包」变成「构建期直接报错」。
 *
 * 核对分两类：
 *   A. DIR 相对引用（= __dirname，即 resources/app 内）：collectMainRefs()
 *   B. process.execPath 相对引用（打包根目录内，如启动续火花助手.bat）：collectExecPathRefs()
 *
 * 排除（dev 专用分支，打包版不走，见 main.js 对应 IS_PACKAGED 三元）：
 *   - data 与 data/*   —— 开发模式数据目录；打包版数据走 %APPDATA%（main.js DATA_DIR）
 *   - 启动续火花助手.bat —— 仅 dev 模式 relaunch 用；打包版走 process.execPath 旁的 bat（归 B 类核对）
 * 除以上两条外，若新增其它「仅开发用」路径引用，自检会报缺失——这是有意的：
 * 提醒要么改成与打包版一致的生产路径，要么在本文件注明排除原因。
 */

/** 提取 main.js 里相对 DIR 加载的运行时文件路径（含 require('./x')）。 */
function collectMainRefs(mainText) {
  return scanJoins(mainText, /path\.join\(\s*DIR\s*,\s*([^)]*)\)/g, true, isDevOnly);
}

/** 提取 main.js 里相对 process.execPath（打包根目录）加载的文件路径。 */
function collectExecPathRefs(mainText) {
  return scanJoins(mainText, /path\.join\(\s*path\.dirname\(\s*process\.execPath\s*\)\s*,\s*([^)]*)\)/g, false, noExclude);
}

function isDevOnly(norm) {
  return norm === 'data' || norm.indexOf('data/') === 0 || norm === '启动续火花助手.bat';
}
function noExclude() { return false; }

function scanJoins(mainText, joinRe, alsoRelativeRequire, isExcluded) {
  const refs = [];
  const seen = new Set();
  const add = function (rel) {
    const norm = rel.replace(/\\/g, '/').replace(/^\.\//, '').split('/').filter(Boolean).join('/');
    if (norm && !isExcluded(norm) && !seen.has(norm)) { seen.add(norm); refs.push(norm); }
  };
  let m;
  // 形如 path.join(锚点, 'a', 'b.js')：只收锚点之后全部为字符串字面量的情形，有变量参与则整条跳过避免拼假路径
  while ((m = joinRe.exec(mainText))) {
    const rest = m[1];
    const parts = [];
    const litRe = /['"]([^'"]+)['"]/g;
    let lm;
    while ((lm = litRe.exec(rest))) parts.push(lm[1]);
    if (rest.replace(/['"][^'"]*['"]/g, '').replace(/[\s,'"]/g, '')) continue; // 存在非字面量参数 → 跳过
    if (parts.length) add(parts.join('/'));
  }
  // 相对 require：require('./package.json')
  if (alsoRelativeRequire) {
    const reqRe = /require\(\s*(['"])(\.\/[^'"]+)\1\s*\)/g;
    while ((m = reqRe.exec(mainText))) add(m[2]);
  }
  return refs;
}

/** 提取 HTML 里引用的本地资源（相对路径的 src/href；外部 URL/锚点/模板占位不算）。 */
function collectHtmlLocalRefs(htmlText) {
  const refs = [];
  const seen = new Set();
  const attrRe = /\b(?:src|href)\s*=\s*(['"])([^'"]+)\1/g;
  let m;
  while ((m = attrRe.exec(htmlText))) {
    const v = m[2];
    if (/^(?:https?:|data:|blob:|javascript:|#|\/|\.\.)/i.test(v) || /\{\{/.test(v)) continue;
    if (!seen.has(v)) { seen.add(v); refs.push(v); }
  }
  return refs;
}

module.exports = {
  collectMainRefs: collectMainRefs,
  collectExecPathRefs: collectExecPathRefs,
  collectHtmlLocalRefs: collectHtmlLocalRefs,
};
