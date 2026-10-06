'use strict';
/**
 * 通知模块：仅邮箱（SMTP）
 * SMTP 使用 Node 内置 net/tls 实现（零第三方依赖，兼容零依赖原则）。
 */

/** 构造 SMTP 邮件文本（UTF-8 base64 编码正文/主题，避免中文头部乱码）。
 *  正文按 RFC 2045 每 76 字符折行：SMTP 传输单行上限 998 字符（RFC 5321），
 *  长内容（如续火花失败明细）单行 base64 会被严格服务器以「line too long」拒收。 */
function buildSmtpMessage(user, to, title, content) {
  const hdr = (s) => String(s || '').replace(/[\r\n]+/g, ''); // 头部防拆分：From/To 值不得含 CR/LF
  const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');
  const bodyB64 = b64(content || '').replace(/(.{76})/g, '$1\r\n');
  return [
    'From: <' + hdr(user) + '>',
    'To: <' + hdr(to) + '>',
    'Subject: =?UTF-8?B?' + b64(title || '通知') + '?=',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    bodyB64,
  ].join('\r\n');
}

/**
 * SMTP 发送（Node 内置 net/tls，零依赖）。
 * 465 = 隐式 TLS；587/其它 = 明文握手后按 EHLO 能力做 STARTTLS；无 STARTTLS 的明文通道一律拒绝认证（保护授权码）。
 * @returns {Promise<{status:number,detail:string}>} 成功返回 {status:250}
 */
function smtpSend(cfg, title, content) {
  return new Promise((resolve, reject) => {
    const host = String(cfg.smtpHost || '').trim();
    const portP = String(cfg.smtpPort || '').trim();
    const port = /^\d+$/.test(portP) ? parseInt(portP, 10) : 587;
    // 头部注入防护：user/to 会拼进 From/To 头与 MAIL FROM/RCPT TO，过滤 CR/LF 防头部拆分
    const user = String(cfg.user || '').trim().replace(/[\r\n]+/g, '');
    const pass = String(cfg.pass || '');
    const to = String(cfg.to || '').trim().split(/[;,，]/)[0].trim().replace(/[\r\n]+/g, '');
    // 按字节计数（含 CRLF）；期限覆盖连接、TLS 握手及整个事务，不能被滴流或升级重置。
    const MAX_LINE_BYTES = 8 * 1024;
    const MAX_REPLY_BYTES = 64 * 1024;
    const MAX_TOTAL_BYTES = 256 * 1024;
    const deadlineAt = Date.now() + 60000;
    const passB64 = Buffer.from(pass, 'utf8').toString('base64');
    const sockets = new Map();
    let deadlineTimer;
    let sock;
    let message;
    let buf = Buffer.alloc(0);
    let advertise = '';
    let replyBytes = 0;
    let replyCode = null;
    let totalBytes = 0;
    let seq = [];
    let settled = false;

    // 只接收本地原因和数字状态码：不转述服务器行/e.message，以免跨行、控制符拆分
    // 防凭据回显以及 AUTH 命令/正文进入日志。统一清理控制符、掩码后再限长。
    const safeError = (reason) => {
      const clean = (s) => String(s).replace(/[\p{Cc}\p{Cf}]/gu, '');
      let text = clean(reason);
      for (const secret of [clean(pass), clean(passB64)].filter(Boolean).sort((a, b) => b.length - a.length)) {
        text = text.split(secret).join('[已隐藏]');
      }
      return new Error(text.slice(0, 256));
    };
    function detachProtocol(s) {
      const handlers = sockets.get(s);
      if (!handlers) return;
      s.removeListener('data', handlers.data);
      s.removeListener('timeout', handlers.timeout);
      if (handlers.secureConnect) s.removeListener('secureConnect', handlers.secureConnect);
      try { s.setTimeout(0); } catch (e) {}
    }
    function cleanup() {
      clearTimeout(deadlineTimer);
      deadlineTimer = null;
      buf = Buffer.alloc(0);
      advertise = '';
      seq = [];
      for (const s of sockets.keys()) {
        detachProtocol(s);
        // 保留幂等的 error/close/end 保护，吞掉 destroy 后到达的迟发事件。
        try { s.destroy(); } catch (e) {}
      }
    }
    const fail = (reason) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(safeError(reason));
    };
    const active = () => {
      if (settled) return false;
      if (Date.now() >= deadlineAt) { fail('SMTP 总超时（60 秒）'); return false; }
      return true;
    };
    const done = () => {
      if (!active()) return;
      settled = true;
      cleanup();
      resolve({ status: 250, detail: 'SMTP 已发送' });
    };
    const say = (l) => {
      if (!active()) return;
      try { sock.write(l + '\r\n'); } catch (e) { fail('SMTP 写失败'); }
    };
    if (!host || !pass || !to) { fail('SMTP 需填写 smtpHost/pass/to'); return; }
    deadlineTimer = setTimeout(() => fail('SMTP 总超时（60 秒）'), 60000);

    const net = require('net');
    const tls = require('tls');

    /** 认证与发信子序列（在 EHLO 通过或 TLS 升级后追加） */
    function attachAuth() {
      seq.push({ expect: 334, cmd: 'AUTH LOGIN' });
      seq.push({ expect: 334, cmd: Buffer.from(user, 'utf8').toString('base64') });
      seq.push({ expect: 235, cmd: Buffer.from(pass, 'utf8').toString('base64') });
      seq.push({ expect: 250, cmd: 'MAIL FROM:<' + user + '>' });
      seq.push({ expect: 250, cmd: 'RCPT TO:<' + to + '>' });
      // DATA 的 onOk 用 unshift 把消息体（期待 250）插入队头——它必须排在 QUIT 之前
      seq.push({ expect: 354, cmd: 'DATA', onOk: () => { seq.unshift({ expect: 250, cmd: message + '\r\n.' }); } });
      seq.push({ expect: 221, cmd: 'QUIT' });
    }

    /** 给当前 socket 挂全套监听（初始连接与 STARTTLS 升级后各调一次）。
     *  close/end 必须监听：服务器在协议中途优雅关闭（FIN 且不带响应行，限流/IP 信誉拦截的常见做法）时
     *  既不会触发 error，socket 关闭还会连带清掉 20s 空闲超时 —— promise 永不 settle，
     *  测试邮件的 IPC 会永久挂住、告警邮件静默不发也不记失败。fail/done 均由 settled 幂等保护，
     *  正常 QUIT(221) 之后服务端关闭连接不会误报。 */
    function attachSock(s) {
      const handlers = {
        data: (data) => { if (s === sock) onData(data); },
        timeout: () => fail('SMTP 超时'),
      };
      sockets.set(s, handlers);
      s.on('data', handlers.data);
      s.on('error', () => fail('SMTP 连接错误'));
      s.on('close', () => fail('SMTP 连接被对端关闭（未完成发送）'));
      s.on('end', () => fail('SMTP 连接被对端关闭（未完成发送）'));
      // tls.connect 期间原 socket 也可能先失败；新 socket 不能因此逃过清理。
      if (settled) { detachProtocol(s); try { s.destroy(); } catch (e) {} return; }
      s.setTimeout(20000, handlers.timeout);
    }

    /** 升级到 TLS（587/其它端口 STARTTLS 成功后调用） */
    function upgradeTls() {
      if (!active()) return;
      const raw = sock;
      // 原 socket 不再解析协议/计空闲超时；保留其终止保护直到事务结束。
      // 只移除本模块监听，不能 removeAllListeners 破坏 TLS 自身监听。
      detachProtocol(raw);
      try {
        // 严格校验 TLS 证书；STARTTLS 显式提供主机名以校验目标域名并发送 SNI。
        sock = tls.connect({ socket: raw, servername: host, rejectUnauthorized: true });
        attachSock(sock);
        if (!active()) return;
        const secure = sock;
        const onSecure = () => {
          if (!active() || sock !== secure) return;
          seq.push({ expect: 250, cmd: 'EHLO localhost', onOk: () => { attachAuth(); } });
          say('EHLO localhost');
        };
        sockets.get(secure).secureConnect = onSecure;
        secure.once('secureConnect', onSecure);
      } catch (e) { fail('SMTP TLS 握手失败'); }
    }

    function onData(data) {
      if (!active()) return;
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data || '');
      totalBytes += chunk.length;
      if (totalBytes > MAX_TOTAL_BYTES) { fail('SMTP 累计响应超过 256 KiB'); return; }
      // 先核对累计预算再分配；以 Buffer 解析，避免跨 chunk 的 UTF-8 字符被破坏。
      buf = Buffer.concat([buf, chunk]);
      let nl;
      while (!settled && (nl = buf.indexOf('\r\n')) >= 0) {
        const bytes = nl + 2;
        if (bytes > MAX_LINE_BYTES) { fail('SMTP 单行响应超过 8 KiB'); return; }
        replyBytes += bytes;
        if (replyBytes > MAX_REPLY_BYTES) { fail('SMTP 多行响应超过 64 KiB'); return; }
        const line = buf.subarray(0, nl).toString('utf8');
        buf = buf.subarray(bytes);
        const match = /^([2-5]\d{2})([ -]|$)/.exec(line);
        if (!match) { fail('SMTP 响应格式错误'); return; }
        const code = Number(match[1]);
        const text = line.length > 4 ? line.slice(4) : '';
        const cur = seq[0];
        if (!cur) { fail('SMTP 意外响应（状态码 ' + code + '）'); return; }
        // 期望值均为 2xx/3xx 中间态，5xx 拒绝必在此命中（旧 code>=500 分支为死代码， 移除）
        if (code !== cur.expect) { fail('SMTP 期望 ' + cur.expect + ' 实得 ' + code); return; }
        if (replyCode !== null && replyCode !== code) { fail('SMTP 多行响应状态码不一致'); return; }
        if (match[2] === '-') {
          replyCode = code;
          advertise += line + '\n'; // 有界多行回复，兼容欢迎消息和 EHLO 能力
          continue;
        }
        seq.shift();
        const adv = advertise;
        advertise = '';
        replyBytes = 0;
        replyCode = null;
        if (cur.onOk) {
          const act = cur.onOk(code, text, adv);
          if (settled) return;
          if (act === 'upgrade') {
            // STARTTLS 220 后不得继续把同一明文 chunk 中的伪造响应当作 TLS 数据。
            if (buf.length) { fail('SMTP STARTTLS 响应后存在多余明文'); return; }
            upgradeTls();
            return;
          }
        }
        if (seq[0] && seq[0].cmd) say(seq[0].cmd);
        if (!seq.length) done();
      }
      if (settled) return;
      if (buf.length >= MAX_LINE_BYTES) { fail('SMTP 单行响应超过 8 KiB'); return; }
      if (replyBytes + buf.length > MAX_REPLY_BYTES) { fail('SMTP 多行响应超过 64 KiB'); }
    }

    const isImplicitTls = port === 465;
    seq.push({ expect: 220 });                                          // 服务器问候
    seq.push({ expect: 250, cmd: 'EHLO localhost', onOk: (code, text, adv) => {
      if (isImplicitTls) { attachAuth(); return; } // 465 连接本身就是加密的，直接认证
      if (/STARTTLS/i.test(adv + ' ' + text)) {
        seq.push({ expect: 220, cmd: 'STARTTLS', onOk: () => 'upgrade' });
      } else {
        // 明文通道且服务器不提供 STARTTLS：拒绝认证，防止授权码（base64 可逆）明文过网被截获
        fail('SMTP 服务器未提供 STARTTLS，为保护授权码不走明文已停止发送；请把 SMTP 端口改为 465（SSL）');
      }
    }});

    // 初始连接不主动发 EHLO——seq[0] 期待服务器 220 问候，收到后按队列自动发 EHLO
    try {
      message = buildSmtpMessage(user, to, title, content);
      if (!active()) return;
      if (isImplicitTls) {
        sock = tls.connect({ host, port, rejectUnauthorized: true });
      } else {
        sock = net.connect({ host, port });
      }
      attachSock(sock);
    } catch (e) { fail('SMTP 连接或邮件准备失败'); }
  });
}

/** 适配我们应用的扁平配置（smtpHost/smtpPort/smtpUser/smtpPass/smtpTo） */
function sendEmail(cfg, title, content) {
  return smtpSend({
    smtpHost: cfg.smtpHost, smtpPort: cfg.smtpPort,
    user: cfg.smtpUser, pass: cfg.smtpPass, to: cfg.smtpTo
  }, title, content);
}

module.exports = { smtpSend, sendEmail, buildSmtpMessage };
