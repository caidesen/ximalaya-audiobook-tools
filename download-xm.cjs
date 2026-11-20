// 复用本机喜马拉雅 4.0.13 的登录态、签名和 XM 编码器。
const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

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

async function runPool(items, concurrency, worker) {
  let next = 0, failure;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (!failure && next < items.length) {
      const item = items[next++];
      try { await worker(item); } catch (error) { if (!failure || (failure.retryable && !error.retryable)) failure = error; }
    }
  }));
  if (failure) throw failure;
}

function selectQuality(levels) {
  if (!levels?.length || !levels.every(n => Number.isInteger(n) && n >= 0 && n <= 3)) throw Error('无法确认支持的音质');
  if (!levels.includes(2)) throw Error('该集不支持档位 2，未自动切换音质');
  return 2;
}

async function runWithRecovery(run, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), log = console.error) {
  for (let restart = 0; ; restart++) {
    try { return await run(); } catch (error) {
      if (!error.retryable || restart >= 3) throw error;
      const delay = 30000 * 2 ** restart;
      log(`${error.message}；等待 ${delay / 1000} 秒后续跑（${restart + 1}/3）`);
      await wait(delay);
    }
  }
}

async function selfTest() {
  let attempts = 0;
  const delays = [], progress = { downloaded: 0 };
  await runWithRecovery(async () => {
    attempts++;
    if (attempts === 1) { progress.downloaded++; throw Object.assign(Error('模拟超时'), { retryable: true }); }
    assert.equal(progress.downloaded, 1);
  }, async ms => delays.push(ms), () => {});
  assert.equal(attempts, 2);
  assert.deepEqual(delays, [30000]);
  attempts = 0; delays.length = 0;
  await assert.rejects(runWithRecovery(async () => {
    attempts++; throw Object.assign(Error('持续超时'), { retryable: true });
  }, async ms => delays.push(ms), () => {}), /持续超时/);
  assert.equal(attempts, 4);
  assert.deepEqual(delays, [30000, 60000, 120000]);
  for (const message of ['无权限', '验证码', '签名失败', '未识别的音频格式', '文件校验失败']) {
    attempts = 0;
    await assert.rejects(runWithRecovery(async () => { attempts++; throw Error(message); }, async () => assert.fail('不应重试'), () => {}));
    assert.equal(attempts, 1);
  }
  assert.equal(selectQuality([3, 2, 1, 0]), 2);
  assert.equal(selectQuality([2, 1, 0]), 2);
  assert.throws(() => selectQuality([1, 0]), /不支持档位 2/);
  assert.throws(() => selectQuality([4, 2]), /无法确认/);
  const messages = [], read = frames(m => messages.push(m));
  const input = Buffer.from('{"title":"中文"}\0{"id":2}\0');
  for (const byte of input) read(Buffer.from([byte]));
  assert.deepEqual(messages, [{ title: '中文' }, { id: 2 }]);
  const originalFetch = global.fetch;
  const audio = Buffer.alloc(1200);
  audio.write('ftypM4A ', 4);
  const task = { url: 'https://example.invalid/audio', track: {}, format: 'm4a', qualityLevel: 2, availableQualityLevels: [0, 1, 2] };
  global.fetch = async () => ({ ok: true, body: new ReadableStream({ start(c) { c.enqueue(audio); c.close(); } }) });
  try {
    const result = await encodeTrack(task);
    assert.deepEqual(Buffer.from(result.base64, 'base64'), audio);
    assert.equal(result.qualityLevel, 2);
    assert.equal(result.audioSha256, crypto.createHash('sha256').update(audio).digest('hex'));
    const inputs = [0, 1, 2].map(n => {
      const payload = Buffer.from(audio); payload[100] = n;
      return { ...task, url: `https://example.invalid/${n}`, payload };
    });
    global.fetch = async url => ({ ok: true, body: new ReadableStream({ async start(c) {
      const item = inputs.find(t => t.url === url);
      await new Promise(resolve => setTimeout(resolve, (3 - Number(url.slice(-1))) * 5));
      c.enqueue(item.payload); c.close();
    } }) });
    await runPool(inputs, 3, async input => {
      const result = await encodeTrack(input);
      assert.deepEqual(Buffer.from(result.base64, 'base64'), input.payload);
    });
    global.fetch = async () => ({ ok: true, body: new ReadableStream({ start(c) { c.enqueue(audio); c.close(); } }) });
    audio.fill(0); audio.write('ID3');
    await assert.rejects(encodeTrack(task), /档位 2 返回的不是 M4A/);
  } finally { global.fetch = originalFetch; }
  let active = 0, peak = 0;
  const completed = [];
  await runPool([0, 1, 2, 3, 4, 5, 6], 3, async item => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    completed.push(item); active--;
  });
  assert.equal(peak, 3);
  assert.deepEqual(completed.sort(), [0, 1, 2, 3, 4, 5, 6]);
  const started = [], finished = [];
  await assert.rejects(runPool([0, 1, 2, 3, 4], 3, async item => {
    started.push(item);
    if (item === 0) throw Error('模拟失败');
    await new Promise(resolve => setTimeout(resolve, 5));
    finished.push(item);
  }), /模拟失败/);
  assert.deepEqual(started, [0, 1, 2]);
  assert.deepEqual(finished.sort(), [1, 2]);
  await assert.rejects(runPool([0, 1], 2, async item => {
    if (item === 0) throw Object.assign(Error('模拟超时'), { retryable: true });
    await new Promise(resolve => setTimeout(resolve, 5));
    throw Error('无权限');
  }), /无权限/);
  console.log('管道、M4A、固定档位、并发、失败等待及有限重启退避自检通过');
}

if (require.main === module) {
  (process.argv[2] === '--self-test' ? selfTest() : main()).catch(error => { console.error(error.message); process.exitCode = 1; });
}

async function main() {
  const state = { downloaded: 0, started: false };
  try { await runWithRecovery(() => downloadAttempt(state)); }
  finally { if (state.started) execFile('/usr/bin/open', ['-a', '/Applications/喜马拉雅.app'], () => {}); }
}

async function downloadAttempt(state) {
  const [albumId, outputArg = './xm-downloads', limitArg = '0', format = 'xm', concurrencyArg = '3'] = process.argv.slice(2);
  if (!/^\d+$/.test(albumId || '') || !/^\d+$/.test(limitArg) || !['xm', 'm4a'].includes(format) || !/^(?:[1-9]|10)$/.test(concurrencyArg)) {
    throw Error('用法：node download-xm.cjs 专辑ID [输出目录] [最多下载集数，0表示全部] [xm或m4a，默认xm] [并发数1-10，默认3]');
  }
  const concurrency = Number(concurrencyArg);
  if (Number(limitArg) && state.downloaded >= Number(limitArg)) return;
  const root = path.resolve(outputArg, albumId);
  fs.mkdirSync(root, { recursive: true });
  return withClient(state, format, async ({ evaluate, mainSession, backgroundSession }) => {
    let count = state.downloaded;
    const seen = new Set();
    console.log(`固定音质档位：2；并发下载数：${concurrency}`);
    for (let page = 1; ; page++) {
      const list = await evaluate(mainSession, `(async()=>{const d=await __xmReq(7).a.get('/simple-revision-for-pc/album/v1/getTracksList',{params:{albumId:${albumId},pageNum:${page},pageSize:30}});if(d.ret!==200)throw Error('列表失败：'+d.ret+' '+d.msg);return d.data})()`, `读取专辑列表第 ${page} 页`);
      if (!list?.tracks?.length) {
        if (page === 1) throw Error('返回空列表，未确认专辑内容；请检查登录态或验证提示');
        break;
      }
      const pending = [];
      for (const track of list.tracks) {
        if (!/^\d+$/.test(String(track.trackId))) throw Error('列表中的声音 ID 无效');
        if (seen.has(String(track.trackId))) continue;
        seen.add(String(track.trackId));
        const target = path.join(root, `${track.trackId}.${format}`);
        if (completedTrack(target)) { console.log(`跳过已完成：${track.title}`); continue; }
        pending.push(track);
        if (Number(limitArg) && count + pending.length >= Number(limitArg)) break;
      }
      await runPool(pending, concurrency, async track => {
        const target = path.join(root, `${track.trackId}.${format}`);
        // shortcut: 依赖 4.0.13 的内部模块编号，客户端升级后需重新验证。
        const label = `${track.title}（声音 ID ${track.trackId}）`;
        const quality = await evaluate(mainSession, `(async()=>{const q=await __xmReq(11).o.getQualityByTrackId(${Number(track.trackId)});const levels=q.data?.trackQualities?.map(t=>t.qualityLevel);const qualityLevel=(${selectQuality.toString()})(levels);return {qualityLevel,availableQualityLevels:levels}})()`, `${label} 查询音质`);
        const sign = await evaluate(mainSession, `__xmReq(126).b()`, `${label} 获取签名`);
        const input = await evaluate(mainSession, `(async()=>{const d=await __xmReq(11).o.trackDownloadUrl(${Number(track.trackId)},${quality.qualityLevel},${JSON.stringify(sign['xm-sign'])});if(d.ret!==0||!d.data?.downloadAacUrl)throw Error('下载地址失败：'+d.ret+' '+d.msg);let url=d.data.downloadAacUrl;if(!/^https?:/.test(url)){const c=__xmReq(156);url=c.AES.decrypt({ciphertext:c.enc.Base64url.parse(url)},c.enc.Hex.parse('aaad3e4fd540b0f79dca95606e72bf93'),{mode:c.mode.ECB,padding:c.pad.Pkcs7}).toString(c.enc.Utf8)}if(!/^https:/.test(url))throw Error('下载地址必须使用 HTTPS');return {url,track:${JSON.stringify(track)},format:${JSON.stringify(format)},qualityLevel:${quality.qualityLevel},availableQualityLevels:${JSON.stringify(quality.availableQualityLevels)}}})()`, `${label} 获取下载地址`);
        const result = await evaluate(backgroundSession, `(${encodeTrack.toString()})(${JSON.stringify(input)})`, `${label} 下载和校验音频`);
        saveTrack(target, track, result, format);
        state.downloaded++;
        console.log(`已保存（指定音质档位 ${result.qualityLevel}）：${track.title} → ${target}`);
      });
      count += pending.length;
      if (Number(limitArg) && count >= Number(limitArg)) return;
      if (page * 30 >= list.trackTotalCount) break;
    }
  });
}

async function withClient(state, format, worker) {
  console.log('请先正常退出喜马拉雅。脚本将临时启动客户端，结束后恢复普通启动。');
  const app = '/Applications/喜马拉雅.app';
  state.started = true;
  const child = spawn(`${app}/Contents/MacOS/喜马拉雅`, ['--remote-debugging-pipe'], {
    stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
  });
  const closed = new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve); });
  let sequence = 0, exited = false, stopping = false;
  const calls = new Map();
  function rejectCalls(error) {
    for (const call of calls.values()) { clearTimeout(call.timer); call.reject(error); }
    calls.clear();
  }
  child.on('error', rejectCalls);
  child.on('exit', () => {
    exited = true;
    rejectCalls(Error('客户端已退出；请确认运行前已正常退出原有实例。'));
  });
  child.stdio[3].on('error', rejectCalls);
  child.stdio[4].on('data', frames(message => {
    const call = calls.get(message.id);
    if (!call) return;
    calls.delete(message.id);
    clearTimeout(call.timer);
    if (message.error) call.reject(Error(message.error.message));
    else call.resolve(message.result);
  }));
  function command(method, params = {}, sessionId, timeoutMs = 90000) {
    return new Promise((resolve, reject) => {
      if (exited) return reject(Error('客户端未运行'));
      const id = ++sequence;
      const timer = setTimeout(() => { calls.delete(id); reject(Object.assign(Error(`${method} 超时`), { retryable: method === 'Runtime.evaluate' })); }, timeoutMs);
      calls.set(id, { resolve, reject, timer });
      child.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + '\0');
    });
  }
  async function evaluate(session, expression, stage = '客户端初始化') {
    try {
      const r = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, session);
      if (r.exceptionDetails) {
        const message = r.exceptionDetails.exception?.description || r.exceptionDetails.text;
        throw Object.assign(Error(message), { retryable: /音频下载 HTTP (429|502|503|504)\b|TimeoutError:/.test(message) });
      }
      return r.result.value;
    } catch (error) { error.message = `${stage}：${error.message}`; throw error; }
  }
  async function stop() {
    if (stopping) return;
    stopping = true;
    if (!exited) await command('Browser.close', {}, undefined, 5000).catch(() => {});
    if (!exited) child.kill();
    const killTimer = setTimeout(() => { if (!exited) child.kill('SIGKILL'); }, 5000);
    try { await closed; } finally { clearTimeout(killTimer); }
    child.stdio[3].destroy();
    child.stdio[4].destroy();
    child.unref();
  }
  const onInterrupt = () => { stop().finally(() => {
    execFile('/usr/bin/open', ['-a', app], () => process.exit(130));
  }); };
  process.once('SIGINT', onInterrupt);
  try {
    let mainTarget, backgroundTarget;
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      const { targetInfos } = await command('Target.getTargets');
      mainTarget = targetInfos.find(t => t.url.includes('/app.html'));
      backgroundTarget = targetInfos.find(t => t.url.includes('/updater.html?download'));
      if (mainTarget && backgroundTarget) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (!mainTarget || !backgroundTarget) throw Error('未找到客户端主窗口和下载后台');
    const mainSession = (await command('Target.attachToTarget', { targetId: mainTarget.targetId, flatten: true })).sessionId;
    const backgroundSession = (await command('Target.attachToTarget', { targetId: backgroundTarget.targetId, flatten: true })).sessionId;
    let ready = format === 'm4a';
    while (!ready && Date.now() < deadline) {
      ready = await evaluate(backgroundSession, "typeof window.xmEncrypt==='function' && typeof window.xmDecrypt==='function'");
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (!ready) throw Error('客户端 XM 编码器尚未就绪');
    await evaluate(mainSession, `window.webpackJsonp.push([['xm_script'],{xm_script:(m,e,r)=>{window.__xmReq=r}},[['xm_script']]]);true`);
    return await worker({ evaluate, mainSession, backgroundSession });
  } finally { try { await stop(); } finally { process.removeListener('SIGINT', onInterrupt); } }
}

async function encodeTrack({ url, track, format, qualityLevel, availableQualityLevels, signal }) {
  const response = await fetch(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000) });
  if (!response.ok) throw Error('音频下载 HTTP ' + response.status);
  const reader = response.body.getReader(), chunks = [];
  let bytes = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > 200000000) { await reader.cancel(); throw Error('音频超过 200 MB'); }
    chunks.push(Buffer.from(value));
  }
  const data = Buffer.concat(chunks);
  // shortcut: 单集整体放入内存，超大文件需要改为流式处理。
  if (data.length < 1000 || data.length > 200000000) throw Error('音频大小异常');
  if (!(data.subarray(4, 8).toString() === 'ftyp' || data.subarray(0, 3).toString() === 'ID3' || data[0] === 255)) throw Error('未识别的音频格式');
  const crypto = require('crypto');
  if (format === 'm4a') {
    if (data.subarray(4, 8).toString() !== 'ftyp') throw Error('档位 2 返回的不是 M4A，未转码或降级保存');
    return { base64: data.toString('base64'), audioSha256: crypto.createHash('sha256').update(data).digest('hex'), qualityLevel, availableQualityLevels };
  }
  const id3 = require('node-id3');
  const first = data.subarray(0, 65536), prefix = first.subarray(0, 12).toString('base64');
  const encoded = window.xmEncrypt(first.subarray(12).toString('base64'), String(track.trackId));
  if (!encoded) throw Error('XM 编码失败');
  const iv = crypto.randomBytes(16), key = Buffer.from('ximalayaximalayaximalayaximalaya');
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const encrypted = Buffer.concat([cipher.update(encoded), cipher.final()]);
  const tags = { title: track.title, artist: track.anchorName, subtitle: String(track.albumId), length: track.duration, album: track.albumTitle, trackNumber: String(track.trackId), composer: 'v2', size: encrypted.length, encodingTechnology: prefix, publisher: window.deviceId || '' };
  if (track.isPaid) { tags.fileType = 'paid'; tags.encodedBy = iv.toString('hex'); }
  else tags.ISRC = iv.toString('hex');
  const header = id3.create(tags), xm = Buffer.concat([header, encrypted, data.subarray(first.length)]);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  const decoded = window.xmDecrypt(Buffer.concat([decipher.update(encrypted), decipher.final()]).toString(), String(track.trackId));
  const restored = Buffer.concat([Buffer.from(prefix + decoded, 'base64'), data.subarray(first.length)]);
  if (!restored.equals(data)) throw Error('XM 回读与原音频不一致');
  return { base64: xm.toString('base64'), audioSha256: crypto.createHash('sha256').update(restored).digest('hex'), qualityLevel, availableQualityLevels };
}

function completedTrack(target) {
  const recordPath = `${target}.json`;
  if (fs.existsSync(target) && fs.existsSync(recordPath)) {
    const record = JSON.parse(fs.readFileSync(recordPath));
    if (['fixed-2', 'highest'].includes(record.qualityPolicy) && record.qualityLevel === 2 && crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex') === record.sha256) return true;
  }
  if (fs.existsSync(target) || fs.existsSync(recordPath)) throw Error(`存在未经验证的文件或记录，未覆盖：${target}`);
  return false;
}

function saveTrack(target, track, result, format) {
  const data = Buffer.from(result.base64, 'base64');
  if (format === 'xm' && data.subarray(0, 3).toString() !== 'ID3') throw Error('XM 缺少 ID3 头');
  if (format === 'm4a' && data.subarray(4, 8).toString() !== 'ftyp') throw Error('M4A 缺少容器头');
  if (completedTrack(target)) throw Error('目标文件已完成，未重复保存');
  const temporary = `${target}.part`;
  let created = false;
  try {
    fs.writeFileSync(temporary, data, { flag: 'wx' });
    created = true;
    fs.linkSync(temporary, target);
  } finally { if (created) fs.rmSync(temporary, { force: true }); }
  fs.writeFileSync(`${target}.json`, JSON.stringify({ track, sha256: crypto.createHash('sha256').update(data).digest('hex'), audioSha256: result.audioSha256, qualityPolicy: 'fixed-2', qualityLevel: result.qualityLevel, availableQualityLevels: result.availableQualityLevels }, null, 2), { flag: 'wx' });
}

module.exports = { withClient, runPool, selectQuality, encodeTrack, completedTrack, saveTrack, runWithRecovery };
