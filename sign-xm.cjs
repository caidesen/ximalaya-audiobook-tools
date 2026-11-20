// 使用独立 Chrome 运行本机客户端的签名 SDK，不启动喜马拉雅或读取账号资料。
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');

function readSdk(asar) {
  const fd = fs.openSync(asar, 'r');
  try {
    const header = Buffer.alloc(16);
    if (fs.readSync(fd, header, 0, 16, 0) !== 16) throw Error('ASAR 头部不完整');
    const headerSize = header.readUInt32LE(4), jsonSize = header.readUInt32LE(12);
    const fileSize = fs.fstatSync(fd).size;
    if (headerSize < 8 || jsonSize < 2 || jsonSize > 16 * 1024 * 1024 || jsonSize > headerSize - 8 || 8 + headerSize > fileSize) throw Error('ASAR 索引大小无效');
    const index = Buffer.alloc(jsonSize);
    if (fs.readSync(fd, index, 0, jsonSize, 16) !== jsonSize) throw Error('ASAR 索引不完整');
    const entry = JSON.parse(index).files?.app?.files?.dist?.files?.['1.6.9.js'];
    if (!entry || entry.unpacked || entry.link) throw Error('未找到内置签名 SDK 1.6.9');
    const offset = Number(entry.offset), size = entry.size;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(size) || size < 1 || size > 2 * 1024 * 1024 || 8 + headerSize + offset + size > fileSize) throw Error('SDK 文件范围无效');
    const source = Buffer.alloc(size);
    if (fs.readSync(fd, source, 0, size, 8 + headerSize + offset) !== size) throw Error('SDK 文件不完整');
    return source;
  } finally { fs.closeSync(fd); }
}

function frames(onMessage) {
  let pending = Buffer.alloc(0);
  return chunk => {
    pending = Buffer.concat([pending, chunk]);
    let end;
    while ((end = pending.indexOf(0)) !== -1) {
      const message = pending.subarray(0, end);
      pending = pending.subarray(end + 1);
      if (message.length) onMessage(JSON.parse(message.toString()));
    }
  };
}

function signature(browserId, sessionId) {
  if (typeof browserId !== 'string' || !browserId || typeof sessionId !== 'string' || !sessionId) throw Error('SDK 未取得完整签名，检查网络或 SDK 兼容性');
  return { 'xm-sign': `${browserId}&&${sessionId}` };
}

async function getSign(sdkPath) {
  const sdk = Buffer.isBuffer(sdkPath) ? sdkPath : sdkPath ? fs.readFileSync(sdkPath) : readSdk('/Applications/喜马拉雅.app/Contents/Resources/app-arm64.asar');
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  fs.accessSync(chrome, fs.constants.X_OK);
  const server = http.createServer((request, response) => {
    if (!['/', '/sdk.js'].includes(request.url)) { response.writeHead(404); response.end(); return; }
    response.setHeader('Content-Type', request.url === '/sdk.js' ? 'text/javascript' : 'text/html; charset=utf-8');
    response.end(request.url === '/sdk.js' ? sdk : '<!doctype html><meta charset="utf-8"><script src="/sdk.js"></script>');
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  let profile, child, closed, exited = false, sequence = 0;
  const calls = new Map();
  function rejectCalls(error) {
    for (const call of calls.values()) { clearTimeout(call.timer); call.reject(error); }
    calls.clear();
  }
  function command(method, params = {}, sessionId, timeout = 25000) {
    return new Promise((resolve, reject) => {
      if (exited) return reject(Error('独立 Chrome 已退出'));
      const id = ++sequence;
      const timer = setTimeout(() => { calls.delete(id); reject(Error(`${method} 超时`)); }, timeout);
      calls.set(id, { resolve, reject, timer });
      child.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + '\0');
    });
  }
  const onInterrupt = () => { rejectCalls(Error('签名测试已中断')); if (child) child.kill(); };
  try {
    profile = fs.mkdtempSync(path.join(os.tmpdir(), 'xm-sign-chrome-'));
    // shortcut: 本机系统代理导致 SDK TLS 连接关闭，当前固定直连；需代理的环境再增加代理配置。
    child = spawn(chrome, ['--headless=new', '--no-proxy-server', '--remote-debugging-pipe', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
    closed = new Promise(resolve => child.once('close', resolve));
    child.on('error', error => { exited = true; rejectCalls(error); });
    child.on('exit', () => { exited = true; rejectCalls(Error('独立 Chrome 已退出')); });
    child.stdio[3].on('error', rejectCalls);
    child.stdio[4].on('error', rejectCalls);
    child.stdio[4].on('data', frames(message => {
      const call = calls.get(message.id);
      if (!call) return;
      calls.delete(message.id); clearTimeout(call.timer);
      if (message.error) call.reject(Error(message.error.message));
      else call.resolve(message.result);
    }));
    process.once('SIGINT', onInterrupt);
    process.once('SIGTERM', onInterrupt);
    const { targetId } = await command('Target.createTarget', { url: `http://127.0.0.1:${server.address().port}/` });
    const { sessionId } = await command('Target.attachToTarget', { targetId, flatten: true });
    const result = await command('Runtime.evaluate', {
      awaitPromise: true, returnByValue: true,
      expression: `(async () => {
        const deadline = Date.now() + 5000;
        while (!window.du_web_sdk && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
        const sdk = window.du_web_sdk;
        if (!sdk) throw Error('SDK 未加载');
        sdk.setConfig({deb: 'true'});
        const invoke = name => new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(Error(name + ' 回调超时')), 18000);
          sdk[name]('t6pfoml9679z52kqw93uqu75eflqdg1bykhl', 'h5_goyxvzyohd', '', value => { clearTimeout(timer); resolve(value); });
        });
        return Promise.all([invoke('getBrowserID'), invoke('getSessionID')]);
      })()`
    }, sessionId);
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return signature(...result.result.value);
  } finally {
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onInterrupt);
    if (child) {
      if (!exited) await command('Browser.close', {}, undefined, 5000).catch(() => {});
      if (!exited) child.kill();
      const timer = setTimeout(() => { if (!exited) child.kill('SIGKILL'); }, 5000);
      try { await closed; } finally { clearTimeout(timer); }
    }
    rejectCalls(Error('签名运行结束'));
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    if (profile) fs.rmSync(profile, { recursive: true, force: true });
  }
}

function selfTest() {
  assert.deepEqual(signature('browser', 'session'), { 'xm-sign': 'browser&&session' });
  for (const value of [null, undefined, '', 123]) {
    assert.throws(() => signature('browser', value), /完整签名/);
    assert.throws(() => signature(value, 'session'), /完整签名/);
  }
  const received = [], parse = frames(message => received.push(message));
  for (const byte of Buffer.from('{"id":1,"value":"中文"}\0{"id":2}\0')) parse(Buffer.from([byte]));
  assert.deepEqual(received, [{ id: 1, value: '中文' }, { id: 2 }]);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xm-sdk-test-'));
  try {
    const source = Buffer.from('test SDK');
    const index = Buffer.from(JSON.stringify({ files: { app: { files: { dist: { files: { '1.6.9.js': { offset: '0', size: source.length } } } } } } }));
    const header = Buffer.alloc(16);
    header.writeUInt32LE(8 + index.length, 4); header.writeUInt32LE(index.length, 12);
    const file = path.join(root, 'test.asar');
    fs.writeFileSync(file, Buffer.concat([header, index, source]));
    assert.deepEqual(readSdk(file), source);
    fs.truncateSync(file, fs.statSync(file).size - 1);
    assert.throws(() => readSdk(file), /范围无效/);
    fs.writeFileSync(file, Buffer.alloc(4));
    assert.throws(() => readSdk(file), /头部不完整/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  console.log('签名完整性、管道分帧、SDK 提取及截断保护自检通过');
}

module.exports = { getSign };
if (require.main === module) {
  if (process.argv[2] === '--self-test') selfTest();
  else getSign(process.argv[2]).then(result => console.log(JSON.stringify(result)), error => { console.error(error.message); process.exitCode = 1; });
}
