'use strict';
/* 免安装打包：把 electron 运行时 + 应用源码合成绿色目录（无需 electron-builder）
 * 用法：node scripts/rebuild-unpacked.js [运行时目录] [输出目录]
 * 运行时目录：缺省用 node_modules/electron/dist
 * 打包完成会自动自检：main.js/ui 运行时引用的文件必须全部进入 resources/app，缺失即报错退出，
 * 把「静默产出坏包」变成「构建期报错」（该自检的由来：曾漏拷 lib/notify.js 致打包版启动崩溃，
 * 自检纯函数见同目录 runtime-files-check.js）。
 * 输出目录：缺省 dist/win-unpacked */
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
// 版本号单一来源：从 package.json 读，打包产物/使用说明不再硬编码
const pkg = require(path.join(root, 'package.json'));
const VERSION = (pkg && pkg.version) || '0.0.0';
const { collectMainRefs, collectHtmlLocalRefs, collectExecPathRefs } = require('./runtime-files-check');
function findRuntime() {
  const arg = process.argv[2];
  // 注意：不能写成 existsSync(path.join(arg,'electron.exe') || path.join(arg,'XHHelper.exe'))——
  // || 短路发生在 path.join 之前，永远只会测 electron.exe，XHHelper.exe 兜底形同虚设（原代码正是如此）
  if (arg && (fs.existsSync(path.join(arg, 'electron.exe')) || fs.existsSync(path.join(arg, 'XHHelper.exe')))) return arg;
  const p1 = path.join(root, 'node_modules', 'electron', 'dist');
  if (fs.existsSync(path.join(p1, 'electron.exe'))) return p1;
  throw new Error('未找到 electron 运行时。已尝试: 参数, node_modules/electron/dist');
}
/* 打包自检：main.js/ui 运行时相对引用的每个文件必须真实存在——
 *   A 类（DIR，即 resources/app 内）：main.js + ui/index.html 的引用；
 *   B 类（process.execPath，即打包根目录内）：如启动续火花助手.bat。
 * 目录整体拷贝（inject/ui/lib）+ 顶层文件白名单的机制下，新增的顶层文件/新目录一旦忘了进清单，
 * 或某个被引用文件被删，都会在这里直接抛错，杜绝再次出现「打包版启动即崩」的漏拷问题。
 * dev 专用路径（data/、DIR 下的启动续火花助手.bat）由 runtime-files-check.js 按 IS_PACKAGED 分支排除。 */
function verifyRuntimeFiles(out) {
  const appOut = path.join(out, 'resources', 'app');
  const missing = []; // 统一收集，报错时标注所在目录
  function check(base, rel) {
    const abs = path.join(base, rel.split('/').join(path.sep));
    if (!fs.existsSync(abs)) missing.push((base === appOut ? 'resources/app/' : '') + rel);
  }
  const mainFile = path.join(appOut, 'main.js');
  const mainText = fs.existsSync(mainFile) ? fs.readFileSync(mainFile, 'utf8') : '';
  collectMainRefs(mainText).forEach(function (r) { check(appOut, r); });
  collectExecPathRefs(mainText).forEach(function (r) { check(out, r); });
  const htmlFile = path.join(appOut, 'ui', 'index.html');
  if (fs.existsSync(htmlFile)) {
    collectHtmlLocalRefs(fs.readFileSync(htmlFile, 'utf8')).forEach(function (r) { check(appOut, 'ui/' + r); });
  }
  // 入口文件本身不靠任何自引用，固定核对
  ['main.js', 'package.json', 'preload-ui.js', 'preload-douyin.js'].forEach(function (r) { check(appOut, r); });
  if (missing.length) {
    console.error('✗ 打包自检失败，缺少运行所需文件：');
    missing.forEach(function (f) { console.error('    - ' + f); });
    throw new Error('打包自检失败：main.js/ui 引用但 resources/app 或打包根目录缺少 ' + missing.length + ' 个文件。\n' +
      '  处理：新增的顶层运行时文件请加入上方 copyFileSync 白名单，新增目录请加入上方 cpSync 清单；\n' +
      '  若刚删除了源码文件，请同步删除 main.js/ui 里对它的引用（dev 专用路径排除规则见 runtime-files-check.js 顶部）。');
  }
  console.log('4/5 打包自检通过：main.js 运行时引用（app 内 ' + collectMainRefs(mainText).length + ' 处 + 根目录 ' + collectExecPathRefs(mainText).length + ' 处）+ ui 本地资源全部就位');
}

function main() {
  const src = findRuntime();
  const out = process.argv[3] || path.join(root, 'dist', 'win-unpacked');
  const appOut = path.join(out, 'resources', 'app');
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(appOut, { recursive: true });
  console.log('1/5 复制运行时 from ' + src + ' ...');
  fs.cpSync(src, out, { recursive: true });
  const exe = path.join(out, 'electron.exe');
  if (fs.existsSync(exe)) fs.renameSync(exe, path.join(out, 'XHHelper.exe'));
  ['main.js','package.json','preload-ui.js','preload-douyin.js'].forEach(function (f) {
    fs.copyFileSync(path.join(root, f), path.join(appOut, f));
  });
  ['inject','ui','lib'].forEach(function (d) { fs.cpSync(path.join(root, d), path.join(appOut, d), { recursive: true }); });
  // 清理运行时无用文件：default_app.asar（未使用的默认壳，在 resources/）、LICENSES.chromium.html（Chromium 许可证原文 19MB，在顶层，个人使用可省）
  [
    path.join(out, 'resources', 'default_app.asar'),
    path.join(out, 'LICENSES.chromium.html')
  ].forEach(function (fp) {
    if (fs.existsSync(fp)) { fs.rmSync(fp, { force: true }); console.log('已清理运行时无用文件: ' + path.basename(fp)); }
  });
  // 内嵌火焰图标到 XHHelper.exe（P/Invoke 改 PE 图标资源，需 Windows PowerShell；重建每次都会重拷运行时，故必须重建后重新内嵌）
  try {
    const ico = path.join(root, 'ui', 'app.ico');
    const iconScript = path.join(root, 'scripts', 'set-exe-icon.ps1');
    if (fs.existsSync(ico) && fs.existsSync(iconScript)) {
      const r = require('child_process').spawnSync('powershell',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', iconScript, path.join(out, 'XHHelper.exe'), ico],
        { stdio: 'inherit' });
      console.log('已内嵌火焰图标: XHHelper.exe' + (r.status === 0 ? '' : '（警告: 图标写入未成功，不影响运行）'));
    }
  } catch (e) { console.log('内嵌图标跳过: ' + e.message); }
  fs.writeFileSync(path.join(out, '启动续火花助手.bat'), '@echo off\r\nchcp 65001 >nul\r\ncd /d %~dp0\r\nstart "" "%~dp0XHHelper.exe" %*\r\n', 'utf8');
  const usage = [
    '抖音续火花助手（免安装版）使用说明',
    '版本 v' + VERSION,
    '',
    '【这是什么】',
    '一个自动续抖音「火花」的小工具：扫码登录抖音网页版 → 自动读取好友列表 → 勾选好友 → 手动或定时自动发一条私信，保持火花不断。',
    '',
    '【怎么用】',
    '1) 先完整解压到任意目录（不要直接双击 zip 里的文件）。',
    '2) 双击「启动续火花助手.bat」启动（或直接双击 XHHelper.exe）。',
    '3) 点「打开抖音页/刷新二维码」→ 手机抖音扫码登录（登录一次后本机记住，下次免登录）。',
    '4) 登录后自动读取好友列表（首次需滚动抓取约 1~2 分钟），也可随时点「读取好友列表」手动获取。',
    '5) 勾选要续火花的好友 → 填发送内容 → 点「立即续火花」立即发，或开启「每日自动续火花」定时发。',
    '',
    '【登录提示「系统繁忙 / 操作频繁」怎么办】',
    '- 这是抖音侧的频次限制，不是软件故障：请关掉登录窗口等几分钟再扫码。',
    '- 期间不要连点「刷新二维码」，也不要反复「退出账号 → 重新登录」——退出会同时清掉本机该账号的登录痕迹，短时间内多次登录会被当成「新设备反复登录」而加重限制。',
    '- 扫码后若弹出滑块/短信等安全验证，请点「显示抖音页」进页面手动完成（新版已不再自动点击登录页，登录全程请手动完成）。',
    '',
    '【多账号】',
    '- 顶部账号栏点「＋添加」可加多个抖音账号，各自独立登录、独立定时、互不串号。',
    '- 每个账号有自己的一套发送内容/时间/好友列表/勾选；点账号 Tab 切换，切到谁就操作谁。',
    '- 好友列表按账号自动缓存：来回切换、重启软件都不会丢；已登录但还没缓存列表的账号会自动后台补读一次。',
    '- 好友列表抓取中不要关程序（首次会滚动 1~2 分钟）。',
    '- 「重命名」给账号起备注名；「删除」会清除该账号登录态、好友缓存和发送记录，不可恢复，谨慎操作。',
    '',
    '【好友列表怎么看】',
    '- 火花列：🔥=有火花；—=无火花。',
    '- 今日列：✅=今天已续过；—=今天还没续。',
    '- 「只看已选」「只看今天未续」筛选；「全选有火花」一键勾选。',
    '- 每行「独立时间」可单独设发送时间（留空=用左侧全局时间）。',
    '- 好友重名：列表里有多个同名好友会跳过并提醒，防止发错人（先在手机里改备注区分）。「同一个好友被重复抓到」不会再被误当成重名；但同名好友里有人用的是抖音默认头像（没设过头像）时，程序认不出是不是同一个人，仍会跳过——给对方设个头像即可正常续。',
    '',
    '【定时与发送】',
    '- 每日自动续火花：程序需常驻（窗口或托盘开着）才到点执行；程序关了可用「生成计划任务」兜底（生成 install-task.bat，双击安装后每天到点自动跑一次）。',
    '- 双时段兜底（可选开关）：早时段没发成功的，第二时段自动补发一次。',
    '- 拟人化（可选，默认关）：随机文案（从快捷文案池抽一条）、随机发送间隔，更像真人。',
    '- 跳过今天已发过：只跳过本工具今天已发送成功的好友。',
    '',
    '【联网模式】',
    '- 一直联网（默认）：随时可手动续火花。',
    '- 续完火花自动断网：发完约 1 分钟后断开抖音页网络（好友看不到你在线，防打扰），到定时发送前 5 分钟自动恢复；断网只针对抖音页，邮箱通知不受影响；断网期间手动操作会自动先联网。',
    '',
    '【邮箱通知】（可选）',
    '- 勾选「邮箱通知」，填 SMTP 配置（服务器/发件账号/授权码/收件邮箱），发送失败或登录失效时收邮件提醒。',
    '',
    '【关闭行为】',
    '- 关窗口时可选「最小化到托盘」（默认，托盘图标右键可退出/唤回）或「直接退出」。',
    '',
    '【开机自启动】（可选，默认关）',
    '- 勾选「开机自启动（进托盘）」即自动保存并写入系统登录启动项：开机自动启动、静默进托盘不弹主界面，已登录账号到点继续自动续火花（定时仍需程序常驻，只是开机帮你启动了）。',
    '- 勾选后下方会显示「系统启动项：已写入 → …XHHelper.exe」表示已生效；若提示未生效，多半是安全软件拦截了注册表写入，请看运行日志。',
    '- 取消勾选即从系统登录启动项移除；升级后第一次手动打开一次新版即可自动把启动项更新到新目录。',
    '',
    '【数据与隐私】',
    '- 个人数据（登录态/配置/好友缓存/发送记录）全部只存在本机 %APPDATA%\\douyin-xuhuohua-helper 下，每台电脑独立，不上传任何服务器。',
    '',
    '【打不开/出问题】',
    '- 先彻底退出（托盘图标右键 → 退出，不是关窗口）再重新打开。',
    '- 若无法启动，把 %APPDATA%\\douyin-xuhuohua-helper\\data\\logs\\app.log 和 crash.log 发给开发者排查。',
    '- 注意：先完整解压再运行，不要直接双击 zip。',
    '',
    '【界面与主题】',
    '- 新版为浅色「天蓝薄荷」二次元主题：奶白底、天蓝→薄荷渐变顶栏、圆角卡片，界面自带柔和动效。',
    '- 想更活泼：设置里勾选「二次元背景粒子」（默认关），背景会飘爱心/星星小粒子，纯 CSS 动画不费资源；系统开了「减少动态效果」会自动停用。',
    '- 屏幕白屏/花屏/闪退（常见于远程桌面或老显卡驱动异常）：设置里勾选「禁用GPU加速」并重启软件。',
    '- 界面崩溃（白屏）会自动重载恢复；窗口大小/位置会自动记住，下次打开还原。',
    '',
    ''
  ].join('\r\n');
  fs.writeFileSync(path.join(out, '使用说明.txt'), usage, 'utf8');
  verifyRuntimeFiles(out);
  console.log('5/5 完成 -> ' + out);
}
main();