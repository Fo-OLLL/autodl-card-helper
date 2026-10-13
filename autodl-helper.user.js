// ==UserScript==
// @name         AutoDL 抢卡助手
// @namespace    autodl-card-helper
// @version      0.2.0
// @description  多实例抢开机、多任务抢新实例、刷新恢复和可选 Server酱通知
// @match        https://www.autodl.com/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        GM_xmlhttpRequest
// @grant        GM_notification
// @connect      sctapi.ftqq.com
// @connect      *.push.ft07.com
// ==/UserScript==

/* 网页接口核对日期：2026-10-13。此文件可直接安装，无打包步骤。 */
(function () {
  'use strict';
  const KEY = 'autodl-helper-v1';
  const GiB = 1024 ** 3;
  const active = t => t?.status === 'active';
  const uid = () => globalThis.crypto.randomUUID();
  const fresh = () => ({ version: 1, nextCycleAt: 0, settings: { intervalSeconds: 10, sound: true, desktop: true,
    serverChan: false, sendKey: '' }, tasks: [], events: [], logs: [] });
  const clone = x => JSON.parse(JSON.stringify(x));
  function compareVersion(a, b) {
    const parts = v => /^\d+(?:\.\d+)*$/.test(String(v).trim()) ? String(v).trim().split('.').map(Number) : null;
    const x = parts(a), y = parts(b);
    if (!x || !y) return null;
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      const d = (x[i] || 0) - (y[i] || 0);
      if (d) return Math.sign(d);
    }
    return 0;
  }
  function groupRegions(rows) {
    const groups = new Map();
    for (const r of rows) {
      if (r.visible !== 'all' || r.used_for !== 'all') continue;
      const key = r.data_center || r.region_name;
      if (!groups.has(key)) groups.set(key, { id: key, name: r.region_name, signs: [] });
      groups.get(key).signs.push(r.region_sign);
    }
    return [...groups.values()];
  }
  function flattenImages(nodes, path = [], out = []) {
    for (const node of nodes) {
      const label = node.label_name;
      if (node.children) flattenImages(node.children, [...path, String(label)], out);
      else if (label && typeof label === 'object' && label.uuid) out.push({
        type: 'base', uuid: label.uuid, name: [...path, label.v].join(' / '),
        chip_corp: label.chip_corp, cpu_arch: label.cpu_arch, cuda: label.v
      });
    }
    return out;
  }
  function regionalGpuOptions(rows, catalog) {
    if (!Array.isArray(rows) || !Array.isArray(catalog)) throw new Error('地区 GPU 列表结构发生变化');
    // 保留暂时没有空闲卡的型号，仍可用它建立持续监控任务。
    const names = new Set(rows.flatMap(row => Object.keys(row)));
    return catalog.filter(g => names.has(g.gpu_name) && g.chip_corp !== 'cpu')
      .map(g => ({ ...g, id: g.gpu_name, name: g.gpu_name }));
  }
  function matchesMachine(m, c) {
    if (!c.gpus.includes(m.gpu_name) || Number(m.gpu_idle_num) < c.gpuCount) return false;
    if ([3, 4, 5, 6].includes(Number(m.on_line))) return false;
    if (m.max_instance_num != null && Number(m.max_instance_num) <= Number(m.binding_instance_num)) return false;
    if (!c.regions.some(r => r.signs.includes(m.region_sign))) return false;
    const capacity = Number(m.max_data_disk_expand_size);
    if ((c.minExpandGb > 0 || c.expandGb > 0) && (!Number.isFinite(capacity) || capacity / GiB < Math.max(c.minExpandGb, c.expandGb))) return false;
    if (c.driver.mode === 'minimum') {
      const d = compareVersion(m.driver_version, c.driver.value);
      if (d === null || d < 0) return false;
    }
    if (c.driver.mode === 'exact' && !c.driver.value.split(/[,，\s]+/).some(v => compareVersion(m.driver_version, v) === 0)) return false;
    if (c.image.chip_corp && c.image.chip_corp !== m.chip_corp) return false;
    if (c.image.cpu_arch && c.image.cpu_arch !== m.cpu_arch) return false;
    // 没有 CUDA 筛选项；只排除网站明确不兼容的镜像/主机组合。
    if (m.chip_corp === 'nvidia' && c.image.cuda && m.highest_cuda_version) {
      const d = compareVersion(m.highest_cuda_version, c.image.cuda);
      if (d !== null && d < 0) return false;
    }
    return true;
  }
  function sortMachines(rows, c) {
    const rank = m => [c.gpus.indexOf(m.gpu_name), c.regions.findIndex(r => r.signs.includes(m.region_sign))];
    return rows.filter(m => matchesMachine(m, c)).sort((a, b) => {
      const x = rank(a), y = rank(b);
      return x[0] - y[0] || x[1] - y[1] || String(a.machine_id).localeCompare(String(b.machine_id));
    });
  }
  function createPayload(task, machine) {
    const c = task.config, disk = c.expandGb * GiB;
    return { instance_info: { machine_id: machine.machine_id, charge_type: 'payg', req_gpu_amount: c.gpuCount,
      base_image_uuid: c.image.type === 'base' ? c.image.uuid : '',
      private_image_uuid: c.image.type === 'private' ? c.image.uuid : '',
      reproduction_uuid: '', reproduction_id: 0, cg_application_uuid: '',
      cg_application_info: { image_name: '', current_version_id: 0, current_version: '', image_id: 0 },
      instance_name: task.marker, expand_data_disk: disk },
    price_info: { coupon_id_list: [], machine_id: machine.machine_id, charge_type: 'payg',
      duration: 1, num: c.gpuCount, expand_data_disk: disk } };
  }
  function isGpuRunning(row) { return row.status === 'running' && row.start_mode === 'gpu'; }
  const shutdownStates = new Set(['shutdown', 'shutdown_by_starting_error', 'shutdown_by_running_error']);
  class ApiError extends Error {
    constructor(message, code = 'NetworkError', uncertain = false) {
      super(message); this.code = code; this.uncertain = uncertain;
    }
  }
  class Api {
    constructor(session, fetcher = (...args) => globalThis.fetch(...args)) { this.session = session; this.fetcher = fetcher; }
    async call(path, body, account) {
      const session = this.session();
      if (!session.token || !session.account) throw new ApiError('请登录 AutoDL，任务会在登录后继续', 'AuthorizeFailed');
      if (account && account !== session.account) throw new ApiError('当前账号与任务所属账号不同，等待切回原账号', 'AccountChanged');
      if (session.subUser) path = path.replace('/api/v1/', '/api/v1/sub_user/');
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
      try {
        const res = await this.fetcher(path, { method: body === undefined ? 'GET' : 'POST', credentials: 'include',
          headers: { Authorization: session.token, AppVersion: session.appVersion, 'Content-Type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: controller.signal });
        if (!res.ok) throw new ApiError(`接口 HTTP ${res.status}`, `HTTP${res.status}`, res.status >= 500);
        let json;
        try { json = await res.json(); } catch { throw new ApiError('接口返回了无法解析的内容', 'InvalidResponse', true); }
        if (json.code !== 'Success') throw new ApiError(String(json.msg || json.code || '接口返回异常').slice(0, 240), json.code || 'InvalidResponse', !json.code);
        return json.data;
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError('网络中断或请求超时，等待下一轮核对', 'NetworkError', true);
      } finally { clearTimeout(timer); }
    }
    async pages(path, body, account) {
      let page = 1, result = [];
      while (true) {
        const data = await this.call(path, { ...body, page_index: page, page_size: 90 }, account);
        if (!data || !Array.isArray(data.list)) throw new ApiError('列表接口结构发生变化，等待适配', 'SchemaChanged');
        result.push(...data.list);
        const size = Number(data.page_size) || 90;
        if (data.list.length === 0 || (data.result_total != null ? result.length >= Number(data.result_total) : data.list.length < size)) return result;
        page++;
        if (page > 1000) throw new ApiError('列表分页异常，任务保留', 'SchemaChanged');
      }
    }
    instances(account) { return this.pages('/api/v1/instance', { status: [], charge_type: [], name: '', sub_name: '' }, account); }
    machines(c, account) { return this.pages('/api/v1/user/machine/list', {
      charge_type: 'payg', gpu_type_name: c.gpus, gpu_idle_num: c.gpuCount,
      region_sign_list: c.regions.flatMap(r => r.signs), default_order: true,
      machine_tag_name: [], mount_net_disk: false, cpu_arch: [], chip_corp: [],
      instance_disk_size_order: '', date_range: '', date_from: '', date_to: '', pay_price_order: '', gpu_idle_type: ''
    }, account); }
    powerOn(uuid, account) { return this.call('/api/v1/instance/power_on', { instance_uuid: uuid }, account); }
    powerOff(uuid, account) { return this.call('/api/v1/instance/power_off', { instance_uuid: uuid }, account); }
    create(task, m) { return this.call('/api/v1/order/instance/create/payg', createPayload(task, m), task.account); }
    init(uuid, account) { return this.call('/api/v1/instance/init', { instance_uuid: uuid }, account); }
  }
  class Engine {
    constructor({ api, read, update, now = Date.now }) { Object.assign(this, { api, read, update, now }); }
    async patch(id, fn) {
      return this.update(s => { const task = s.tasks.find(t => t.id === id); if (task && active(task)) return fn(task, s); });
    }
    async message(id, text) { await this.patch(id, t => { t.message = text; }); }
    async success(id, instance) {
      await this.patch(id, (t, s) => {
        t.status = 'success'; t.instanceUuid = instance.uuid; t.message = 'GPU 开机成功'; t.completedAt = this.now();
        s.events.push({ id: t.id, taskName: t.name, instanceUuid: instance.uuid, createdAt: this.now(),
          desktop: false, sound: false, server: false, serverAttempts: 0, nextAt: 0 });
        s.logs.unshift({ at: this.now(), text: `${t.name}：GPU 开机成功 (${instance.uuid})` });
        s.logs = s.logs.slice(0, 100);
      });
    }
    async step(id) {
      let t = this.read().tasks.find(t => t.id === id);
      if (!t || !active(t) || (t.nextAt || 0) > this.now()) return;
      try {
        const rows = await this.api.instances(t.account);
        t = this.read().tasks.find(t => t.id === id);
        if (!t || !active(t)) return;
        if (t.kind === 'new' && !t.instanceUuid) {
          const found = rows.filter(r => r.name === t.marker);
          if (found.length > 1) { await this.message(id, '发现多个同名创建结果，请在控制台核对；任务保留'); return; }
          if (found.length === 1) {
            await this.patch(id, t => { t.instanceUuid = found[0].uuid; t.intent = null; });
            t = this.read().tasks.find(t => t.id === id);
            if (!active(t)) return;
          } else if (t.intent) {
            await this.message(id, `创建结果待核对，持续查找实例 ${t.marker}，不会重复下单`); return;
          } else {
            const machines = sortMachines(await this.api.machines(t.config, t.account), t.config);
            if (!machines.length) { await this.message(id, '等待符合条件的空闲 GPU'); return; }
            const machine = machines[0];
            const prepared = await this.patch(id, t => {
              t.intent = { at: this.now(), machineId: machine.machine_id };
              t.message = `正在创建：${machine.gpu_name} / ${machine.region_name || machine.region_sign}`;
              return clone(t);
            });
            if (!prepared || !active(this.read().tasks.find(t => t.id === id))) return;
            try {
              const result = await this.api.create(prepared, machine);
              const uuid = typeof result === 'string' ? result : result?.instance_uuid || result?.uuid;
              // 取消后的已发送请求仍需保存返回值，以便显示其实际结果。
              await this.update(s => { const task = s.tasks.find(t => t.id === id); if (!task) return;
                if (uuid) { task.instanceUuid = uuid; task.intent = null; }
                task.message = active(task) ? (uuid ? '创建已受理，等待 GPU 运行' : '创建已受理，正在核对实例列表') : '已取消；创建请求已发送，请核对控制台';
              });
            } catch (error) {
              if (!error.uncertain) await this.patch(id, t => { t.intent = null; });
              throw error;
            }
            return;
          }
        }
        const row = rows.find(r => r.uuid === t.instanceUuid);
        if (!row) { await this.message(id, '等待实例出现在列表中；请确认实例未被释放'); return; }
        if (isGpuRunning(row)) { await this.success(id, row); return; }
        if (row.status === 'running' && row.start_mode === 'non_gpu') {
          if (t.lastAction?.type === 'off' && this.now() - t.lastAction.at < 60000) {
            await this.message(id, '等待无卡实例关机完成'); return;
          }
          if (!await this.patch(id, t => { t.lastAction = { type: 'off', at: this.now() }; return true; })) return;
          await this.api.powerOff(row.uuid, t.account);
          await this.message(id, '已请求关闭无卡实例，等待关机完成');
        } else if (shutdownStates.has(row.status)) {
          if (t.lastAction?.type === 'on' && this.now() - t.lastAction.at < 30000) {
            await this.message(id, '等待开机结果'); return;
          }
          if (!await this.patch(id, t => { t.lastAction = { type: 'on', at: this.now() }; return true; })) return;
          await this.api.powerOn(row.uuid, t.account);
          await this.message(id, '开机已受理，等待 GPU 运行');
        } else if (t.kind === 'new' && ['create_failed', 're_init_failed'].includes(row.status)) {
          if (t.lastAction?.type === 'init' && this.now() - t.lastAction.at < 60000) return;
          if (!await this.patch(id, t => { t.lastAction = { type: 'init', at: this.now() }; return true; })) return;
          await this.api.init(row.uuid, t.account);
          await this.message(id, '请求重试创建原实例');
        } else await this.message(id, `等待实例状态变化：${row.status} / ${row.start_mode || '模式未知'}`);
        await this.patch(id, t => { t.errors = 0; });
      } catch (error) {
        await this.patch(id, (t, s) => {
          t.errors = (t.errors || 0) + 1;
          const base = s.settings.intervalSeconds * 1000;
          t.nextAt = this.now() + Math.min(300000, base * 2 ** Math.min(t.errors - 1, 5));
          const text = error.message || '发生异常，稍后重试';
          if (t.message !== text) { s.logs.unshift({ at: this.now(), text: `${t.name}：${text}` }); s.logs = s.logs.slice(0, 100); }
          t.message = text;
        });
      }
    }
    async tick() {
      // 每个目标一轮最多一个写请求，独立完成；顺序提交避免库存和创建请求互相竞争。
      for (const t of this.read().tasks.filter(active)) await this.step(t.id);
    }
  }
  function serverChanUrl(key) {
    if (/^SCT[A-Za-z0-9]+$/.test(key)) return `https://sctapi.ftqq.com/${key}.send`;
    const match = key.match(/^sctp(\d+)t[A-Za-z0-9]+$/);
    if (match) return `https://${match[1]}.push.ft07.com/send/${key}.send`;
    throw new Error('SendKey 格式不正确，需要 SCT… 或 sctp…');
  }
  function validateNew(c) {
    if (!c.gpus?.length || !c.regions?.length || !c.image?.uuid) throw new Error('请选择 GPU、地区和镜像');
    if (!Number.isInteger(c.gpuCount) || c.gpuCount < 1) throw new Error('GPU 数量必须为正整数');
    if (![c.minExpandGb, c.expandGb].every(x => Number.isInteger(x) && x >= 0)) throw new Error('磁盘容量必须为非负整数');
    if (c.driver.mode === 'minimum' && compareVersion(c.driver.value, '0') === null) throw new Error('请输入有效的最低驱动版本');
    if (c.driver.mode === 'exact' && !c.driver.value.split(/[,，\s]+/).filter(Boolean).length) throw new Error('请输入指定驱动版本');
    if (c.driver.mode === 'exact' && c.driver.value.split(/[,，\s]+/).filter(Boolean).some(v => compareVersion(v, '0') === null)) throw new Error('驱动版本请用数字和点，多版本用逗号分隔');
  }
  // 无需构建即可在 Node 中测试业务逻辑；浏览器执行从此处开始。
  if (typeof module === 'object' && module.exports) {
    module.exports = { Api, ApiError, Engine, fresh, compareVersion, matchesMachine, sortMachines, createPayload,
      groupRegions, regionalGpuOptions, flattenImages, isGpuRunning, serverChanUrl, validateNew }; return;
  }
  if (window.top !== window.self || document.getElementById('autodl-helper-host')) return;
  function session() {
    try {
      const user = JSON.parse(localStorage.getItem('user') || '{}');
      const identity = user.uuid || user.id;
      return { token: localStorage.getItem('token'), account: identity ? `${identity}:${user.sub_name || ''}` : '',
        subUser: !!user.sub_name, appVersion: JSON.parse(localStorage.getItem('app_version') || '{}').version || '0.0.0' };
    } catch { return { token: null, account: '' }; }
  }
  const read = () => GM_getValue(KEY, fresh());
  let onState = () => {};
  async function update(fn) {
    if (!navigator.locks) throw new Error('此浏览器缺少 Web Locks，请使用新版 Chrome 或 Edge');
    return navigator.locks.request(`${KEY}-state`, async () => {
      const s = read(), result = fn(s); GM_setValue(KEY, s); onState(); return result;
    });
  }
  const api = new Api(session), engine = new Engine({ api, read, update });
  let audio;
  async function enableSound() {
    audio ||= new (window.AudioContext || window.webkitAudioContext)();
    await audio.resume();
  }
  async function beep() {
    await enableSound();
    if (audio.state !== 'running') throw new Error('请点击“测试提醒”解锁提示音');
    for (const offset of [0, 0.25, 0.5]) {
      const o = audio.createOscillator(), gain = audio.createGain();
      o.type = 'sine'; o.frequency.value = 880; gain.gain.value = 0.08;
      o.connect(gain); gain.connect(audio.destination); o.start(audio.currentTime + offset); o.stop(audio.currentTime + offset + 0.15);
    }
  }
  function sendServer(key, title, desp) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({ method: 'POST', url: serverChanUrl(key), timeout: 15000, anonymous: true,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        data: new URLSearchParams({ title, desp }).toString(),
        onload: res => { try { const data = JSON.parse(res.responseText);
          if (res.status >= 200 && res.status < 300 && (data.code === 0 || data.errno === 0)) resolve();
          else reject(new Error('Server酱未接受通知，请检查 SendKey 和额度'));
        } catch { reject(new Error('Server酱返回内容异常')); } },
        onerror: () => reject(new Error('Server酱网络异常')), ontimeout: () => reject(new Error('Server酱通知超时')) });
    });
  }
  async function dispatchEvents() {
    for (const event of read().events) {
      const settings = read().settings;
      const title = `AutoDL 抢卡成功：${event.taskName}`;
      const text = `实例 ${event.instanceUuid} 已进入 GPU 运行状态`;
      if (!event.desktop && settings.desktop) {
        try {
          GM_notification({ title, text, timeout: 10000 });
          await update(s => { const e = s.events.find(e => e.id === event.id); if (e) e.desktop = true; });
        } catch { /* 通知权限异常不影响声音、微信通知和其他任务。 */ }
      }
      if (!event.sound && settings.sound) {
        try { await beep(); await update(s => { const e = s.events.find(e => e.id === event.id); if (e) e.sound = true; }); }
        catch { /* 浏览器的自动播放限制不会影响抢卡；面板提醒用户解锁声音。 */ }
      }
      if (!event.server && settings.serverChan && settings.sendKey && event.nextAt <= Date.now()) {
        try {
          await sendServer(settings.sendKey, title, `${text}\n\n任务：${event.taskName}\n\n[查看实例](https://www.autodl.com/console/instance/list)`);
          await update(s => { const e = s.events.find(e => e.id === event.id); if (e) { e.server = true; e.error = ''; } });
        } catch (error) {
          await update(s => { const e = s.events.find(e => e.id === event.id); if (e) {
            e.serverAttempts++; e.nextAt = Date.now() + Math.min(3600000, 60000 * 2 ** Math.min(e.serverAttempts, 6)); e.error = error.message;
          } });
        }
      }
    }
  }
  let runner = false, busy = false, loopTimer;
  async function loop() {
    if (busy) return;
    clearTimeout(loopTimer);
    busy = true;
    try {
      if (!navigator.locks) { notice('当前浏览器不支持任务互斥，请使用新版 Chrome 或 Edge'); return; }
      await navigator.locks.request(`${KEY}-runner`, { ifAvailable: true }, async lock => {
        runner = !!lock; renderTasks(); if (!lock) return;
        if ((read().nextCycleAt || 0) > Date.now()) return;
        await update(s => { s.nextCycleAt = Date.now() + s.settings.intervalSeconds * 1000; });
        await engine.tick(); await dispatchEvents();
        await update(s => { s.nextCycleAt = Date.now() + s.settings.intervalSeconds * 1000; });
      });
    } catch (error) { notice(error.message); }
    finally { busy = false; loopTimer = setTimeout(loop, Math.max(5, Number(read().settings.intervalSeconds) || 10) * 1000); }
  }

  const host = document.createElement('div'); host.id = 'autodl-helper-host';
  document.documentElement.appendChild(host);
  const root = host.attachShadow({ mode: 'open' });
  const el = (tag, attrs = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
      else if (key === 'class') node.className = value;
      else if (key in node) node[key] = value;
      else node.setAttribute(key, value);
    }
    node.append(...children.filter(x => x != null)); return node;
  };
  const button = (text, fn, cls = '') => el('button', { type: 'button', onclick: fn, class: cls }, text);
  const input = (type, value, attrs = {}) => el('input', { type, value, ...attrs });
  const label = (text, field) => {
    field.setAttribute('aria-label', text);
    return el('label', {}, el('span', {}, text), field);
  };
  const section = (step, title, description, ...children) => el('section', { class: 'section' },
    el('h3', { class: 'section-title' }, ...(step ? [el('span', { class: 'step' }, String(step))] : []), title),
    description ? el('p', { class: 'muted' }, description) : null, ...children);
  const safeAction = fn => async () => { try { await fn(); } catch (error) { notice(error.message); } };
  const style = el('style', {}, `
    :host{all:initial;font:14px/1.6 system-ui,"Microsoft YaHei",sans-serif;color:#24334a}
    *{box-sizing:border-box}button,input,select{font:inherit}button{cursor:pointer;border:1px solid #d5dfeb;border-radius:7px;padding:5px 10px;background:#fff;color:#24334a}
    button:hover{background:#edf3fa}button:disabled{opacity:.5;cursor:wait}.primary{background:#225bd6;color:white;border-color:#225bd6}.primary:hover{background:#1949b4}.danger{color:#ba2c36}
    .launcher{position:fixed;right:22px;bottom:24px;z-index:2147483646;box-shadow:0 4px 20px #1233;padding:12px 18px}
    .panel{position:fixed;right:22px;bottom:80px;width:min(600px,calc(100vw - 24px));max-height:80vh;overflow:auto;background:#fff;border:1px solid #d5dfeb;border-radius:14px;box-shadow:0 14px 60px #10203940;z-index:2147483646;padding:18px}
    .head,.bar{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}.head strong{font-size:19px}.tabs{display:flex;gap:7px;flex-wrap:wrap;margin:14px 0}.selected{background:#e8efff;color:#225bd6}
    .muted{color:#61728c;font-size:12px;white-space:pre-line}.notice{background:#fff3d9;border-radius:7px;padding:8px;margin:10px 0;white-space:pre-wrap}
    .card{border:1px solid #e0e7f0;border-radius:10px;padding:12px;margin:10px 0;overflow-wrap:anywhere}.success{border-color:#8cca9f;background:#f2fcf5}
    label{display:flex;flex-direction:column;gap:4px;margin:10px 0}input,select{width:100%;border:1px solid #cdd8e6;border-radius:7px;padding:7px;background:white;color:#24334a}input[type=checkbox]{width:auto;margin:0 6px 0 0}
    .check{display:flex;flex-direction:row;align-items:center;margin:8px 0}.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.picks{display:flex;gap:6px;flex-wrap:wrap;max-height:155px;overflow:auto}.ordered{margin:6px 0;display:flex;gap:6px;align-items:center}.ordered span{flex:1}.row{display:flex;align-items:center;gap:7px}.row input{flex:1}
    .status{font-size:12px;color:#225bd6}.log{font:12px/1.7 ui-monospace,monospace;white-space:pre-wrap;overflow-wrap:anywhere}hr{border:0;border-top:1px solid #e2e9f2;margin:16px 0}[hidden]{display:none!important}
    .top{position:sticky;top:-18px;z-index:2;background:#fff;margin:-18px -18px 10px;padding:18px 18px 0;border-bottom:1px solid #e2e9f2}
    .section{background:#f5f8fc;border:1px solid #e1e8f2;border-radius:12px;padding:14px;margin:12px 0;min-width:0}
    .section-title{display:flex;align-items:center;gap:8px;font-size:14px;font-weight:650;margin:0 0 7px}.step{display:inline-flex;align-items:center;justify-content:center;width:23px;height:23px;flex:none;border-radius:7px;background:#e4edff;color:#225bd6;font-size:12px}
    .section .picks{margin:10px 0}.section label:last-child{margin-bottom:0}.section .grid label{margin:6px 0}.section fieldset{border:0;padding:0;margin:0;min-width:0}.section fieldset:disabled{opacity:.6}.section .ordered{background:#fff;border-radius:7px;padding:4px 7px}.section .ordered button{padding:2px 8px}
    .section-title + .muted{margin:0 0 10px}.section-footer{border-top:1px solid #e1e8f2;padding-top:12px;margin-top:12px}.section-footer button{width:100%;padding:9px}.picker-title{color:#4d5f7a;font-size:12px}
    @media(max-width:520px){.grid{grid-template-columns:1fr;gap:0}.panel{right:12px;padding:14px}.top{top:-14px;margin:-14px -14px 10px;padding:14px 14px 0}}
  `);
  const panel = el('section', { class: 'panel', hidden: true });
  const launcher = button('AutoDL 抢卡', () => { panel.hidden = !panel.hidden; renderTasks(); }, 'launcher primary');
  const noticeBox = el('div', { class: 'notice', hidden: true });
  function notice(text) { noticeBox.textContent = text; noticeBox.hidden = !text; }
  const statusLine = el('div', { class: 'muted' });
  const views = {}, tabs = el('nav', { class: 'tabs' });
  function show(name) {
    for (const [key, view] of Object.entries(views)) view.hidden = key !== name;
    for (const b of tabs.children) b.classList.toggle('selected', b.dataset.name === name);
    renderTasks();
  }
  for (const [name, title] of [['tasks', '任务'], ['existing', '抢开机'], ['new', '抢新实例'], ['settings', '设置'], ['logs', '日志']]) {
    const b = button(title, () => show(name)); b.dataset.name = name; tabs.append(b);
    views[name] = el('div', { hidden: name !== 'tasks' });
  }
  panel.append(el('div', { class: 'top' },
    el('header', { class: 'head' }, el('strong', {}, 'AutoDL 抢卡助手'), button('收起', () => { panel.hidden = true; })),
    el('div', { class: 'muted' }, '普通容器实例 · 按量计费 · 保持本页面打开'), statusLine, noticeBox, tabs), ...Object.values(views));
  root.append(style, panel, launcher);
  function renderTasks() {
    const s = read(), account = session().account;
    const current = s.tasks.filter(t => t.account === account);
    const count = current.filter(active).length;
    launcher.textContent = `AutoDL 抢卡 · ${count} 待完成`;
    statusLine.textContent = !session().token ? '等待登录；已保存的任务继续保留' :
      `${count} 个任务待完成 · ${runner ? '此页面执行监控' : '等待执行轮次 / 其他页面监控'} · ${s.settings.intervalSeconds} 秒间隔`;
    views.tasks.replaceChildren(el('p', { class: 'muted' }, '两种模式独立完成。创建请求发出后，取消任务不会撤回请求或关闭实例。'));
    if (!current.length) views.tasks.append(el('p', {}, '还没有任务。选择“抢开机”或“抢新实例”开始。'));
    for (const t of current) {
      const card = el('article', { class: `card ${t.status === 'success' ? 'success' : ''}` });
      const actions = el('div', { class: 'bar' }, el('strong', {}, t.name));
      if (active(t)) actions.append(button('取消任务', safeAction(async () => {
        await update(s => { const task = s.tasks.find(x => x.id === t.id); if (active(task)) {
          task.status = 'cancelled'; task.message = task.intent ? '已取消，已发送创建请求请核对控制台' : '已由你取消';
        } });
      }), 'danger'));
      else actions.append(button('移除记录', safeAction(async () => {
        await update(s => { s.tasks = s.tasks.filter(x => x.id !== t.id); s.events = s.events.filter(x => x.id !== t.id); });
      })));
      card.append(actions, el('div', { class: 'status' }, { active: '监控中', success: '已成功', cancelled: '已取消' }[t.status]),
        el('div', {}, t.message || '等待首次检查'));
      if (t.kind === 'new') card.append(el('div', { class: 'muted' },
        `${t.config.gpus.join(' → ')} · ${t.config.gpuCount} 卡 · ${t.config.regions.map(r => r.name).join(' → ')}\n镜像：${t.config.image.name}`));
      if (t.instanceUuid) card.append(el('div', { class: 'muted' }, `实例：${t.instanceUuid}`));
      if (active(t) && t.intent && Date.now() - t.intent.at > 120000) card.append(button('已核对未创建，重新尝试', safeAction(async () => {
        if (!window.confirm(`请先到控制台核对不存在名称为 ${t.marker} 的实例和正在创建的实例。确认后重新发送创建请求？`)) return;
        await update(s => { const task = s.tasks.find(x => x.id === t.id); if (active(task)) {
          task.intent = null; task.nextAt = 0; task.message = '你已核对未创建，继续抢卡';
        } });
      })));
      const event = s.events.find(e => e.id === t.id);
      if (event?.error) card.append(el('div', { class: 'muted' }, `${event.error}；通知稍后重试`));
      views.tasks.append(card);
    }
    const foreign = s.tasks.filter(t => t.account !== account && active(t)).length;
    if (foreign) views.tasks.append(el('p', { class: 'muted' }, `其他账号有 ${foreign} 个待完成任务；切回对应账号后自动继续。`));
    views.logs.replaceChildren(...s.logs.map(l => el('div', { class: 'log' }, `${new Date(l.at).toLocaleString()} ${l.text}`)));
  }
  onState = renderTasks;
  GM_addValueChangeListener(KEY, () => renderTasks());

  const instanceList = el('div'), selectedInstances = new Map();
  async function loadInstances() {
    const rows = await api.instances(session().account); instanceList.replaceChildren(); selectedInstances.clear();
    for (const r of rows) {
      const cb = input('checkbox', '', { onchange: () => cb.checked ? selectedInstances.set(r.uuid, r) : selectedInstances.delete(r.uuid) });
      instanceList.append(el('label', { class: 'check' }, cb, el('span', {}, `${r.name || r.uuid} · ${r.status} / ${r.start_mode || '-'} · ${r.req_gpu_amount || '?'} 卡`)));
    }
    if (!rows.length) instanceList.append(el('p', {}, '当前账号没有普通容器实例'));
  }
  views.existing.append(section(null, '选择已有实例', '可多选目标，每个实例都需要成功。',
    button('读取我的实例', safeAction(loadInstances)), instanceList),
    section(null, '开始抢开机', '无卡运行中的实例会自动关机，再尝试 GPU 开机。',
    button('启动所选实例抢卡', safeAction(async () => {
      if (!selectedInstances.size) throw new Error('请先选择实例');
      const account = session().account;
      if (!account) throw new Error('请先登录 AutoDL');
      const rows = [...selectedInstances.values()];
      await update(s => { for (const r of rows) {
        if (s.tasks.some(t => t.account === account && active(t) && t.instanceUuid === r.uuid)) continue;
        s.tasks.push({ id: uid(), kind: 'existing', name: r.name || r.uuid, account, instanceUuid: r.uuid,
          status: 'active', createdAt: Date.now(), message: '等待抢开机', nextAt: 0 });
      } });
      enableSound().catch(() => {}); show('tasks'); loop();
    }), 'primary')));

  function orderedPicker(title, onChange = () => {}) {
    const selected = [], available = el('div', { class: 'picks' }), ordered = el('div'); let options = [];
    function render() {
      available.replaceChildren(...options.map(o => button(o.name, () => {
        const i = selected.findIndex(x => x.id === o.id);
        if (i >= 0) selected.splice(i, 1); else selected.push(o);
        render(); onChange();
      }, selected.some(x => x.id === o.id) ? 'selected' : '')));
      ordered.replaceChildren(...selected.map((o, i) => el('div', { class: 'ordered' }, el('span', {}, `${i + 1}. ${o.name}`),
        button('↑', () => { if (i > 0) { [selected[i - 1], selected[i]] = [selected[i], selected[i - 1]]; render(); } }),
        button('↓', () => { if (i < selected.length - 1) { [selected[i + 1], selected[i]] = [selected[i], selected[i + 1]]; render(); } }))));
    }
    return { node: el('div', {}, el('div', { class: 'picker-title' }, title), available, ordered), get: () => clone(selected),
      setOptions(list) {
        options = list;
        const refreshed = selected.map(s => list.find(o => o.id === s.id)).filter(Boolean);
        selected.splice(0, selected.length, ...refreshed); render(); onChange();
      } };
  }
  const gpuPicker = orderedPicker('可选 GPU 型号 · 多选，↑↓调整优先级', () => {
    resetImages('GPU 已更改，请重新读取镜像'); refreshNewForm();
  });
  const regionPicker = orderedPicker('可选地区 · 多选，↑↓调整地区优先级', () => {
    gpuQueryGeneration++; gpuPicker.setOptions([]);
    gpuHint.textContent = regionPicker.get().length ? '已选择地区，点击下方按钮读取 GPU。' : '请先选择地区。';
    refreshNewForm();
  });
  const taskName = input('text', '', { placeholder: '例如：训练任务 A' });
  const gpuCount = input('number', 1, { min: 1, step: 1 });
  const minExpand = input('number', 0, { min: 0, step: 1 });
  const expand = input('number', 0, { min: 0, step: 1 });
  const driverMode = el('select', {}, el('option', { value: 'any' }, '不限制'), el('option', { value: 'minimum' }, '最低版本'), el('option', { value: 'exact' }, '指定版本'));
  const driverValue = input('text', '', { placeholder: '550.54.15；多版本用逗号分隔' });
  const imageType = el('select', {}, el('option', { value: 'base' }, '官方基础镜像'), el('option', { value: 'private' }, '我的私有镜像'));
  const imageSelect = el('select', {}, el('option', { value: '' }, '先选 GPU，再读取镜像'));
  let images = [], imageQueryGeneration = 0, gpuQueryGeneration = 0;
  const gpuHint = el('p', { class: 'muted' }, '请先选择地区。');
  function resetImages(text) {
    imageQueryGeneration++; images = [];
    imageSelect.replaceChildren(el('option', { value: '' }, text));
  }
  imageType.addEventListener('change', () => { resetImages('请重新读取此类型的镜像'); refreshNewForm(); });
  imageSelect.addEventListener('change', () => refreshNewForm());
  async function loadRegions() {
    const account = session().account;
    const data = await api.call('/api/v1/region/list', undefined, account);
    if (account !== session().account) return;
    if (!Array.isArray(data)) throw new Error('地区列表结构发生变化');
    regionPicker.setOptions(groupRegions(data));
  }
  async function loadRegionGpus() {
    const regions = regionPicker.get(); if (!regions.length) throw new Error('请先选择地区');
    const generation = ++gpuQueryGeneration, account = session().account;
    readGpusButton.disabled = true; gpuHint.textContent = '正在读取所选地区的 GPU 型号…';
    try {
      const [regional, catalog] = await Promise.all([
        api.call('/api/v1/machine/region/gpu_type', { region_sign_list: [...new Set(regions.flatMap(r => r.signs))] }, account),
        api.call('/api/v1/machine/gpu_type', undefined, account)
      ]);
      if (generation !== gpuQueryGeneration || account !== session().account) return;
      const options = regionalGpuOptions(regional, catalog);
      gpuPicker.setOptions(options);
      gpuHint.textContent = options.length ? `所选地区共有 ${options.length} 种 GPU 可选，暂时无空闲卡的型号也可以监控。` : '这些地区没有可选 GPU，请更换地区。';
    } catch (error) {
      if (generation !== gpuQueryGeneration || account !== session().account) return;
      gpuHint.textContent = 'GPU 读取失败，请重试。'; throw error;
    } finally { if (generation === gpuQueryGeneration) refreshNewForm(); }
  }
  async function loadImages() {
    const gpus = gpuPicker.get(); if (!gpus.length) throw new Error('先选择 GPU 型号');
    const architectures = new Set(gpus.map(g => `${g.chip_corp}/${g.cpu_arch}`));
    if (architectures.size !== 1) throw new Error('同一任务的 GPU 需使用相同芯片厂商和 CPU 架构，以匹配镜像');
    const generation = ++imageQueryGeneration, type = imageType.value;
    const body = { chip_corp: [gpus[0].chip_corp], cpu_arch: [gpus[0].cpu_arch] };
    const data = await api.call(type === 'base' ? '/api/v1/image/all' : '/api/v1/image/private/get', body, session().account);
    if (generation !== imageQueryGeneration || type !== imageType.value) return;
    if (!Array.isArray(data)) throw new Error('镜像列表结构发生变化');
    images = type === 'base' ? flattenImages(data) : data.map(i => ({ type: 'private', uuid: i.image_uuid,
      name: i.name || i.image_uuid, chip_corp: i.chip_corp, cpu_arch: i.cpu_arch, cuda: i.cuda_v }));
    images = images.map(i => ({ ...i, chip_corp: i.chip_corp || gpus[0].chip_corp, cpu_arch: i.cpu_arch || gpus[0].cpu_arch }));
    imageSelect.replaceChildren(el('option', { value: '' }, images.length ? '请选择镜像' : '没有可用镜像'),
      ...images.map(i => el('option', { value: i.uuid }, i.name)));
    refreshNewForm();
  }
  const filtersFields = el('fieldset', {}, label('每个实例 GPU 数量', gpuCount),
    el('div', { class: 'grid' }, label('显卡驱动筛选', driverMode), label('驱动版本', driverValue)),
    el('div', { class: 'grid' }, label('主机可扩容容量至少（GB）', minExpand), label('实际额外扩容（GB，0 使用基础盘）', expand)));
  const readGpusButton = button('读取所选地区的 GPU', safeAction(loadRegionGpus));
  const readImagesButton = button('读取可用镜像', safeAction(loadImages));
  const imageFields = el('fieldset', {}, label('镜像来源', imageType), readImagesButton, label('使用的镜像', imageSelect));
  const startNewButton = button('添加并启动新实例任务', safeAction(async () => {
      const image = images.find(i => i.uuid === imageSelect.value && i.type === imageType.value);
      const selectedGpus = gpuPicker.get();
      if (image && selectedGpus.some(g => g.chip_corp !== image.chip_corp || g.cpu_arch !== image.cpu_arch)) throw new Error('GPU 架构已更改，请重新读取镜像');
      const c = { gpus: selectedGpus.map(g => g.name), regions: regionPicker.get(), gpuCount: Number(gpuCount.value),
        driver: { mode: driverMode.value, value: driverValue.value.trim() }, minExpandGb: Number(minExpand.value), expandGb: Number(expand.value), image };
      validateNew(c);
      const account = session().account; if (!account) throw new Error('请先登录 AutoDL');
      const id = uid();
      await update(s => { s.tasks.push({ id, marker: `ADLH-${id}`, kind: 'new', name: taskName.value.trim() || `新实例任务 ${s.tasks.length + 1}`,
        account, config: c, status: 'active', createdAt: Date.now(), nextAt: 0, message: '等待空闲 GPU' }); });
      enableSound().catch(() => {}); show('tasks'); loop();
    }), 'primary');
  function refreshNewForm() {
    const hasGpu = gpuPicker.get().length > 0;
    readGpusButton.disabled = !regionPicker.get().length;
    filtersFields.disabled = !hasGpu; imageFields.disabled = !hasGpu;
    driverValue.disabled = driverMode.value === 'any';
    startNewButton.disabled = !hasGpu || !imageSelect.value;
  }
  driverMode.addEventListener('change', refreshNewForm);
  views.new.append(el('p', { class: 'muted' }, '每个任务创建一个实例，可添加多个独立任务。按步骤配置；抢卡时仍优先 GPU 型号，再按地区排序。'),
    section(1, '选择地区', '先读取地区，再选择需要监控的机房。', button('读取地区', safeAction(loadRegions)), regionPicker.node),
    section(2, '选择 GPU', '只展示所选地区中存在的型号。', gpuHint, readGpusButton, gpuPicker.node),
    section(3, '设置筛选条件', '选择 GPU 后，可设置卡数、显卡驱动和磁盘容量。', filtersFields),
    section(4, '选择镜像', '支持官方基础镜像和自己的私有镜像。', imageFields),
    section(5, '创建监控任务', '配置完成后自动监控，抢到一个实例即完成此任务。', label('任务名称', taskName),
      el('div', { class: 'section-footer' }, startNewButton)));
  refreshNewForm();

  const settings = read().settings;
  const interval = input('number', settings.intervalSeconds, { min: 5, step: 1 });
  const sound = input('checkbox', '', { checked: settings.sound });
  const desktop = input('checkbox', '', { checked: settings.desktop });
  const server = input('checkbox', '', { checked: settings.serverChan });
  const sendKey = input('password', settings.sendKey, { placeholder: '可选，填写 Server酱 SendKey', autocomplete: 'off' });
  views.settings.append(section(null, '监控频率', '所有任务共用一个检查间隔。', label('全局检查间隔（秒，最小 5，默认 10）', interval)),
    section(null, '本地提醒', '首次点击“测试提醒”解锁声音；浏览器可能限制后台定时器和声音。',
      el('label', { class: 'check' }, sound, '提示音'), el('label', { class: 'check' }, desktop, '浏览器桌面通知')),
    section(null, '微信通知 · 可选', 'SendKey 只保存在本机油猴存储中。请到 Server酱后台绑定微信推送渠道。',
      el('label', { class: 'check' }, server, '启用 Server酱微信通知（可选）'), label('Server酱 SendKey', sendKey)),
    el('div', { class: 'bar' },
    button('保存设置', safeAction(async () => {
      const n = Number(interval.value); if (!Number.isInteger(n) || n < 5) throw new Error('检查间隔应为至少 5 秒的整数');
      if (server.checked) serverChanUrl(sendKey.value.trim());
      await update(s => { s.settings = { intervalSeconds: n, sound: sound.checked, desktop: desktop.checked,
        serverChan: server.checked, sendKey: sendKey.value.trim() }; }); notice('设置已保存');
    }), 'primary'), button('测试提醒', safeAction(async () => {
      if (sound.checked) await beep();
      if (desktop.checked) GM_notification({ title: 'AutoDL 抢卡助手', text: '测试提醒：通知已启用', timeout: 8000 });
      if (server.checked) await sendServer(sendKey.value.trim(), 'AutoDL 抢卡助手测试', 'Server酱可选通知已连接');
      notice('测试提醒已发送');
    }))));
  show('tasks'); loop();
})();
