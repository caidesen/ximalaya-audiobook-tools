// 启动时读取客户端会话，关闭客户端后由 Node 下载 M4A；登录态不落盘。
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const https = require('node:https');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { getSign } = require('./sign-xm.cjs');
const { withClient, runPool, selectQuality, encodeTrack, completedTrack, saveTrack, runWithRecovery } = require('./download-xm.cjs');
const PC = 'https://pc.ximalaya.com';
const MOBILE = 'https://mobile.ximalaya.com';

function parseArgs(args) {
  const [albumId, output = './xm-downloads', limit = '0', concurrency = '3'] = args;
  if (args.length > 4 || !/^\d+$/.test(albumId || '') || !/^\d+$/.test(limit) || !Number.isSafeInteger(Number(limit)) || !/^(?:[1-9]|10)$/.test(concurrency)) {
    throw Error('用法：node download-independent.cjs 专辑ID [输出目录] [最多新下载集数，0表示全部] [并发数1-10，默认3]');
  }
  return { albumId, root: path.resolve(output, albumId), limit: Number(limit), concurrency: Number(concurrency) };
}

async function bootstrap(state) {
  // shortcut: 依赖 macOS 商店版 4.0.13 的 preload 与模块编号，客户端升级后需重新验证。
  const session = await withClient(state, 'm4a', ({ evaluate, mainSession }) => evaluate(mainSession, `(async()=>{
    const remote=require('@electron/remote');
    const sdkPath=remote.getGlobal('duJsPath');
    const sdk=require('fs').readFileSync(sdkPath);
    if(!sdk.length||sdk.length>2*1024*1024)throw Error('当前SDK大小无效');
    const cookies=await Promise.all(['${PC}','${MOBILE}'].map(url=>remote.session.defaultSession.cookies.get({url})));
    return {sdk:sdk.toString('base64'),sdkName:require('path').basename(sdkPath),cookies:cookies.map(items=>items.map(c=>c.name+'='+c.value).join('; ')),ua:Buffer.from(navigator.userAgent,'utf8').toString('latin1')+' '+remote.app.getVersion()};
  })()`, '读取当前会话和SDK'));
  if (!session?.sdk || !Array.isArray(session.cookies) || session.cookies.length !== 2 || session.cookies.some(c => typeof c !== 'string' || !c) || typeof session.ua !== 'string') throw Error('未取得有效客户端会话，请先在客户端登录');
  session.sdk = Buffer.from(session.sdk, 'base64');
  console.log(`客户端已关闭；使用当前 SDK ${session.sdkName}，登录态仅保留在内存中`);
  return session;
}

function requestJson(url, session, sign, transport = https.get) {
  const origin = new URL(url).origin;
  if (![PC, MOBILE].includes(origin)) throw Error('拒绝向非预期域名发送登录态');
  const headers = { Origin: PC, Referer: PC, 'User-Agent': session.ua, Accept: 'application/json, text/plain, */*', ...sign, Cookie: session.cookies[origin === PC ? 0 : 1] };
  return new Promise((resolve, reject) => {
    const request = transport(url, { headers, signal: session.signal }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', part => {
        body += part;
        if (body.length > 2 * 1024 * 1024) request.destroy(Object.assign(Error('API响应超限'), { retryable: false }));
      });
      response.on('error', () => reject(Error('API响应读取失败')));
      response.on('end', () => {
        if (response.statusCode !== 200) return reject(Object.assign(Error(`API HTTP ${response.statusCode}`), { retryable: [429, 502, 503, 504].includes(response.statusCode) }));
        try { resolve(JSON.parse(body)); } catch { reject(Error('API响应不是有效JSON')); }
      });
    });
    const timer = setTimeout(() => request.destroy(Error('API超时')), 20000);
    request.once('close', () => clearTimeout(timer));
    // 不输出底层异常，避免错误信息包含签名、Cookie或临时地址。
    request.on('error', error => reject(Object.assign(Error(session.signal?.aborted ? '下载已中断' : error.retryable === false ? 'API响应超限' : 'API网络失败或超时'), { retryable: !session.signal?.aborted && error.retryable !== false })));
  });
}

function downloadUrl(value) {
  if (typeof value !== 'string' || !value) throw Error('下载接口未返回地址');
  let result = value;
  if (!/^https?:/.test(result)) {
    try {
      const decipher = crypto.createDecipheriv('aes-128-ecb', Buffer.from('aaad3e4fd540b0f79dca95606e72bf93', 'hex'), null);
      result = Buffer.concat([decipher.update(Buffer.from(result, 'base64url')), decipher.final()]).toString('utf8');
    } catch { throw Error('下载地址解码失败'); }
  }
  let url;
  try { url = new URL(result); } catch { throw Error('下载地址格式无效'); }
  if (url.protocol !== 'https:' || url.username || url.password) throw Error('下载地址必须为无内嵌凭据的HTTPS地址');
  return url.href;
}

async function download(options, session, state, deps = {}) {
  const signSdk = deps.getSign || getSign;
  const api = deps.requestJson || requestJson;
  const readAudio = deps.encodeTrack || encodeTrack;
  const seen = new Set();
  fs.mkdirSync(options.root, { recursive: true });
  console.log(`固定音质档位：2；并发下载数：${options.concurrency}`);
  for (let page = 1; ; page++) {
    if (options.limit && state.downloaded >= options.limit) return;
    // shortcut: 每页重新生成签名；尚未验证跨页长时间复用的有效期。
    session.signal?.throwIfAborted();
    const sign = await signSdk(session.sdk);
    session.signal?.throwIfAborted();
    const list = await api(`${PC}/simple-revision-for-pc/album/v1/getTracksList?albumId=${options.albumId}&pageNum=${page}&pageSize=30`, session, sign);
    if (list.ret !== 200 || !Array.isArray(list.data?.tracks) || !list.data.tracks.length || !Number.isSafeInteger(list.data.trackTotalCount) || list.data.trackTotalCount < 1 || !(Number(list.data.currentUid) > 0)) throw Error(`列表第 ${page} 页无有效内容或登录态失效，请检查客户端登录和验证提示`);
    const pending = [];
    for (const track of list.data.tracks) {
      if (!/^\d+$/.test(String(track.trackId))) throw Error('列表中的声音ID无效');
      if (seen.has(String(track.trackId))) throw Error('分页出现重复声音，未认定下载完整');
      seen.add(String(track.trackId));
      const target = path.join(options.root, `${track.trackId}.m4a`);
      if (completedTrack(target)) { console.log(`跳过已完成：${track.title}`); continue; }
      pending.push(track);
      if (options.limit && state.downloaded + pending.length >= options.limit) break;
    }
    await runPool(pending, options.concurrency, async track => {
      try {
        session.signal?.throwIfAborted();
        const quality = await api(`${MOBILE}/mobile-playpage/playpage/track/quality/${track.trackId}/${Date.now()}`, session, sign);
        if (quality.ret !== 0) throw Error(`音质查询失败（ret=${Number(quality.ret)}），请检查账号权限`);
        const levels = quality.data?.trackQualities?.map(item => item.qualityLevel);
        const qualityLevel = selectQuality(levels);
        const address = await api(`${MOBILE}/mobile/download/v2/track/${track.trackId}/ts-${Date.now()}?trackId=${track.trackId}&device=darwin&trackQualityLevel=${qualityLevel}`, session, sign);
        if (address.ret !== 0) throw Error(`下载地址失败（ret=${Number(address.ret)}），请检查账号权限或验证提示`);
        const url = downloadUrl(address.data?.downloadAacUrl);
        let audio;
        try { audio = await readAudio({ url, track, format: 'm4a', qualityLevel, availableQualityLevels: levels, signal: session.signal }); }
        catch (error) {
          if (session.signal?.aborted) throw Error('下载已中断');
          if (/^音频下载 HTTP \d+$|^音频超过 200 MB$|^音频大小异常$|^未识别的音频格式$|^档位 2 返回的不是 M4A/.test(error.message)) throw Object.assign(Error(error.message), { retryable: /^音频下载 HTTP (429|502|503|504)$/.test(error.message) });
          throw Object.assign(Error('音频网络读取失败或超时'), { retryable: true });
        }
        saveTrack(path.join(options.root, `${track.trackId}.m4a`), track, audio, 'm4a');
        state.downloaded++;
        console.log(`已保存（档位2）：${track.title}`);
      } catch (error) { error.message = `声音 ${track.trackId}：${error.message}`; throw error; }
    });
    if (options.limit && state.downloaded >= options.limit) return;
    if (page * 30 >= list.data.trackTotalCount) {
      if (seen.size !== list.data.trackTotalCount) throw Error('列表数量与总数不符，未认定下载完整');
      return;
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const state = { downloaded: 0, started: false };
  const controller = new AbortController();
  const interrupt = () => { process.exitCode = 130; controller.abort(Error('下载已中断')); };
  try {
    const session = await bootstrap(state);
    session.signal = controller.signal;
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', interrupt);
    const wait = ms => require('node:timers/promises').setTimeout(ms, undefined, { signal: controller.signal });
    await runWithRecovery(() => download(options, session, state), wait);
    console.log(`本次新下载 ${state.downloaded} 集`);
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    if (state.started) execFile('/usr/bin/open', ['-a', '/Applications/喜马拉雅.app'], () => {});
  }
}

async function selfTest() {
  const { EventEmitter } = require('node:events');
  for (const args of [[], ['../1'], ['1', '.', '-1'], ['1', '.', '9007199254740992'], ['1', '.', '1', '11']]) assert.throws(() => parseArgs(args), /用法/);
  const url = 'https://audio.example.invalid/test.m4a';
  const cipher = crypto.createCipheriv('aes-128-ecb', Buffer.from('aaad3e4fd540b0f79dca95606e72bf93', 'hex'), null);
  const encrypted = Buffer.concat([cipher.update(url), cipher.final()]).toString('base64url');
  assert.equal(downloadUrl(encrypted), url);
  for (const bad of ['http://audio.example.invalid/a', 'https://u:p@audio.example.invalid/a', 'not-an-address']) assert.throws(() => downloadUrl(bad));
  await assert.rejects(async () => requestJson('https://example.invalid', {}, {}), /非预期/);
  const session = { sdk: Buffer.from('SDK'), cookies: ['pc-cookie', 'mobile-cookie'], ua: 'test' };
  const fakeHttp = (statusCode, body) => (input, { headers }, callback) => {
    assert.equal(headers.Cookie, 'mobile-cookie');
    const req = new EventEmitter();
    process.nextTick(() => {
      const res = new EventEmitter();res.statusCode = statusCode;res.setEncoding = () => {};
      callback(res);res.emit('data', body);res.emit('end');req.emit('close');
    });
    return req;
  };
  assert.deepEqual(await requestJson(MOBILE + '/test', session, {}, fakeHttp(200, '{"ret":0}')), { ret: 0 });
  await assert.rejects(requestJson(MOBILE + '/test', session, {}, fakeHttp(403, '{}')), error => !error.retryable);
  await assert.rejects(requestJson(MOBILE + '/test', session, {}, fakeHttp(503, '{}')), error => error.retryable);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xm-independent-selftest-'));
  const audio = Buffer.alloc(1200);audio.write('ftypM4A ', 4);
  const hash = crypto.createHash('sha256').update(audio).digest('hex');
  const options = { albumId: '123', root, limit: 2, concurrency: 2 };
  const calls = [];
  const deps = {
    getSign: async sdk => { assert.deepEqual(sdk, session.sdk);return { 'xm-sign': 'test' }; },
    requestJson: async input => {
      calls.push(input);
      if (input.includes('getTracksList')) return { ret: 200, data: { currentUid: 1, trackTotalCount: 3, tracks: [1, 2, 3].map(trackId => ({ trackId, title: `第${trackId}集` })) } };
      if (input.includes('/quality/')) return { ret: 0, data: { trackQualities: [{ qualityLevel: 2 }, { qualityLevel: 1 }] } };
      return { ret: 0, data: { downloadAacUrl: encrypted } };
    },
    encodeTrack: async input => { assert.equal(input.url, url);return { base64: audio.toString('base64'), audioSha256: hash, qualityLevel: 2, availableQualityLevels: [2, 1] }; }
  };
  try {
    const controller = new AbortController();controller.abort(Error('下载已中断'));
    await assert.rejects(download(options, { ...session, signal: controller.signal }, { downloaded: 0 }, deps), /下载已中断/);
    const state = { downloaded: 0 };
    await download(options, session, state, deps);
    assert.equal(state.downloaded, 2);assert(!fs.existsSync(path.join(root, '3.m4a')));
    assert(completedTrack(path.join(root, '1.m4a')));
    const next = { downloaded: 0 };
    await download({ ...options, limit: 1 }, session, next, deps);
    assert.equal(next.downloaded, 1);assert(completedTrack(path.join(root, '3.m4a')));
    assert.equal(calls.filter(c => c.includes('/mobile/download/')).length, 3);
    let pages = 0;
    const paginated = { ...deps, requestJson: async input => {
      if (!input.includes('getTracksList')) return deps.requestJson(input);
      pages++;
      const first = new URL(input).searchParams.get('pageNum') === '1';
      return { ret: 200, data: { currentUid: 1, trackTotalCount: 31, tracks: Array.from({ length: first ? 30 : 1 }, (_, i) => ({ trackId: first ? i + 1 : 31, title: '分页样本' })) } };
    } };
    const pagedState = { downloaded: 0 };
    await download({ ...options, root: path.join(root, 'pages'), limit: 0 }, session, pagedState, paginated);
    assert.equal(pages, 2);assert.equal(pagedState.downloaded, 31);
    await assert.rejects(download({ ...options, root: path.join(root, 'pages'), limit: 0 }, session, { downloaded: 0 }, { ...paginated, requestJson: async input => input.includes('pageNum=2') ? { ret: 200, data: { tracks: [] } } : paginated.requestJson(input) }), /第 2 页/);
    fs.writeFileSync(path.join(root, '1.m4a'), 'damaged');
    assert.throws(() => completedTrack(path.join(root, '1.m4a')), /未覆盖/);
    const contents = fs.readFileSync(path.join(root, '2.m4a'));
    assert.throws(() => saveTrack(path.join(root, '2.m4a'), {}, {}, 'm4a'));
    assert.deepEqual(fs.readFileSync(path.join(root, '2.m4a')), contents);
    fs.writeFileSync(path.join(root, '4.m4a.json'), '{}');
    assert.throws(() => completedTrack(path.join(root, '4.m4a')), /未覆盖/);
    await assert.rejects(download(options, session, { downloaded: 0 }, { ...deps, requestJson: async () => ({ ret: 200, data: { tracks: [] } }) }), /登录态失效/);
    await assert.rejects(download({ ...options, root: path.join(root, 'denied') }, session, { downloaded: 0 }, { ...deps, requestJson: async input => input.includes('getTracksList') ? deps.requestJson(input) : ({ ret: 403 }) }), /音质查询失败/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  console.log('独立下载自检通过：地址解码、凭据域名边界、HTTP错误、集数上限、续跑及冲突保护');
}

module.exports = { download };
if (require.main === module) {
  (process.argv[2] === '--self-test' ? selfTest() : main()).catch(error => { console.error(error.message); process.exitCode ||= 1; });
}
