'use strict';
// 可选浏览器集成检查：需安装 playwright 和 Edge（或设置 PLAYWRIGHT_CHANNEL）。
// 拦截全部网络请求，绝不会连接真实 AutoDL 账户或创建付费实例。
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const script = fs.readFileSync(path.join(__dirname, '../autodl-helper.user.js'), 'utf8');
const { fresh } = require('../autodl-helper.user.js');

(async () => {
  const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge' });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
    const errors = [], calls = [], notifications = [];
    let rows = [{ uuid: 'existing-1', name: '我的无卡实例', snapshot_gpu_alias_name: 'RTX 4090D', machine_id: 'original', region_sign: 'west1', expand_data_disk_size: 0, status: 'running', start_mode: 'non_gpu', req_gpu_amount: 1 },
      { uuid: 'shutdown-2', name: '已关机实例', snapshot_gpu_alias_name: 'A100-SXM4-80GB', status: 'shutdown', start_mode: 'gpu', req_gpu_amount: 2 }];
    let createCount = 0, cloneCount = 0, originalIdle = 0;
    await context.exposeFunction('recordNotification', data => notifications.push(data));
    await context.addInitScript(() => {
      localStorage.setItem('token', 'mock-token');
      localStorage.setItem('user', JSON.stringify({ id: 1 }));
      window.GM_getValue = (key, fallback) => JSON.parse(localStorage.getItem(`mock-gm-${key}`) || 'null') || fallback;
      window.GM_setValue = (key, value) => localStorage.setItem(`mock-gm-${key}`, JSON.stringify(value));
      window.GM_addValueChangeListener = (key, listener) => window.addEventListener('storage', event => {
        if (event.key === `mock-gm-${key}`) listener();
      });
      window.GM_notification = data => window.recordNotification(data);
      window.GM_xmlhttpRequest = () => { throw Error('此测试未启用 Server酱'); };
    });
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url()), body = request.postDataJSON();
      if (!url.pathname.startsWith('/api/')) {
        await route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<html><head><meta charset="utf-8"><title>模拟 AutoDL</title></head><body><h1>模拟 AutoDL 控制台</h1></body></html>' }); return;
      }
      calls.push([url.pathname, body]);
      let data;
      switch (url.pathname) {
        case '/api/v1/instance': data = { list: rows, result_total: rows.length, page_size: 90 }; break;
        case '/api/v1/instance/power_off': rows.find(r => r.uuid === body.instance_uuid).status = 'shutdown'; data = null; break;
        case '/api/v1/instance/power_on': Object.assign(rows.find(r => r.uuid === body.instance_uuid), { status: 'running', start_mode: 'gpu' }); data = null; break;
        case '/api/v1/machine/detail': assert.equal(body.machine_id, 'original'); data = { gpu_idle_num: originalIdle, on_line: 1 }; break;
        case '/api/v1/instance/snapshot': data = { expand_data_disk_size: 0,
          machine_info_snapshot: { gpu_name: 'RTX 4090D', max_instance_disk_size: 100 * 1024 ** 3 },
          image: { image_type: 'public', image_name: 'base-1', chip_corp: 'nvidia', cpu_arch: 'x86', cuda_version: '12.4' } }; break;
        case '/api/v1/machine/gpu_type': data = [
          { gpu_name: 'RTX 4090D', chip_corp: 'nvidia', cpu_arch: 'x86' },
          { gpu_name: 'RTX 4090', chip_corp: 'nvidia', cpu_arch: 'x86' },
          { gpu_name: 'RTX 5090', chip_corp: 'nvidia', cpu_arch: 'x86' }]; break;
        case '/api/v1/machine/region/gpu_type': data = [{ 'RTX 4090': { idle: 0 } }];
          if (body.region_sign_list.includes('west1')) data.push({ 'RTX 4090D': { idle: 4 } }); break;
        case '/api/v1/region/list': data = [
          { data_center: 'bj', region_name: '北京', region_sign: 'bj1', visible: 'all', used_for: 'all' },
          { data_center: 'west', region_name: '西北', region_sign: 'west1', visible: 'all', used_for: 'all' }]; break;
        case '/api/v1/image/all': data = [{ label_name: 'PyTorch', children: [{ label_name: '2.5', children: [
          { label_name: '3.12', children: [{ label_name: { uuid: 'base-1', v: '12.4', chip_corp: 'nvidia', cpu_arch: 'x86' } }] }] }] }]; break;
        case '/api/v1/image/private/get': data = [{ image_uuid: 'private-1', name: '我的训练环境', cuda_v: '12.4', chip_corp: 'nvidia', cpu_arch: 'x86' }]; break;
        case '/api/v1/user/machine/list': data = { list: [{ machine_id: 'machine1', gpu_name: body.gpu_type_name?.[0] || 'RTX 4090D', gpu_idle_num: 4,
          region_sign: 'west1', region_name: '西北', on_line: 1, driver_version: '570.10', max_data_disk_expand_size: 1024 ** 4,
          chip_corp: 'nvidia', cpu_arch: 'x86', highest_cuda_version: '12.8', mem_per_gpu: 64 * 1024 ** 3, max_instance_disk_size: 100 * 1024 ** 3 }], result_total: 1, page_size: 90 };
          if (body.gpu_idle_num === 0) { data.list.push({ ...data.list[0], machine_id: 'busy', gpu_idle_num: 0, driver_version: '550.54.15' }); data.result_total = 2; } break;
        case '/api/v1/order/instance/create/payg':
          data = `created-${++createCount}`;
          rows.push({ uuid: data, name: body.instance_info.instance_name, status: 'running', start_mode: 'gpu', req_gpu_amount: body.instance_info.req_gpu_amount }); break;
        case '/api/v1/order/instance/clone/payg':
          assert.equal(body.instance_uuid, 'existing-1'); assert.equal(body.instance_info.copy_data_disk_after_clone, true);
          assert.equal(body.instance_info.req_gpu_amount, 3); assert.equal(body.instance_info.expand_data_disk, 100 * 1024 ** 3);
          data = `cloned-${++cloneCount}`;
          rows.push({ uuid: data, name: body.instance_info.instance_name, status: 'running', start_mode: 'gpu',
            additional_info: { copy_data_disk_after_clone_status: 'Running' } }); break;
        default: throw Error(`未预期请求：${url.pathname}`);
      }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ code: 'Success', data }) });
    });
    const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
    await page.clock.install();
    await page.goto('https://www.autodl.com/console/instance/list');
    const state = fresh(); state.settings.sound = false;
    await page.evaluate(s => localStorage.setItem('mock-gm-autodl-helper-v1', JSON.stringify(s)), state);
    await page.addScriptTag({ content: script });
    const host = page.locator('#autodl-helper-host');
    await host.locator('button.launcher').click();
    await host.getByRole('button', { name: '抢开机', exact: true }).click();
    await page.clock.runFor(300);
    await host.getByLabel(/我的无卡实例/).waitFor();
    assert.match(await host.getByLabel(/我的无卡实例/).locator('..').innerText(), /RTX 4090D/);
    assert.equal(await host.locator('.state-running').count(), 1);
    assert.equal(await host.locator('.state-shutdown').count(), 1);
    fs.mkdirSync(path.join(__dirname, '../.research'), { recursive: true });
    await page.screenshot({ path: path.join(__dirname, '../.research/ui-instances.png') });
    await host.getByLabel(/我的无卡实例/).check();
    await host.getByRole('button', { name: '启动所选实例抢卡' }).click();
    const advance = async n => { await page.clock.fastForward(n); await page.waitForTimeout(100); };
    await advance(11000);
    assert.equal(calls.filter(c => c[0].endsWith('power_off')).length, 0);
    assert.equal(rows[0].status, 'running'); assert.equal(rows[0].start_mode, 'non_gpu');
    originalIdle = 1;
    await advance(11000);
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('mock-gm-autodl-helper-v1')).tasks[0]?.lastAction?.type === 'off');
    await advance(11000);
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('mock-gm-autodl-helper-v1')).tasks[0]?.lastAction?.type === 'on');
    await advance(11000);
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('mock-gm-autodl-helper-v1')).tasks[0]?.status === 'success');
    assert.equal(calls.filter(c => c[0].endsWith('power_off')).length, 1);
    assert.equal(calls.filter(c => c[0].endsWith('power_on')).length, 1);

    await host.getByRole('button', { name: '抢新实例', exact: true }).click();
    assert.equal(await host.getByRole('button', { name: /读取/ }).count(), 0);
    assert.equal(await host.getByLabel('每个实例 GPU 数量').isDisabled(), true);
    await page.clock.runFor(300);
    await host.getByRole('button', { name: '北京', exact: true }).click();
    await page.clock.runFor(300);
    await host.getByRole('button', { name: 'RTX 4090', exact: true }).click();
    assert.equal(await host.getByRole('button', { name: 'RTX 4090D', exact: true }).count(), 0);
    await host.getByRole('button', { name: '西北', exact: true }).click();
    assert.equal(await host.getByRole('button', { name: 'RTX 4090', exact: true }).count(), 0);
    assert.equal(await host.getByLabel('使用的镜像', { exact: true }).isDisabled(), true);
    await page.clock.runFor(300);
    await host.getByRole('button', { name: 'RTX 4090D', exact: true }).click();
    await host.getByRole('button', { name: 'RTX 4090', exact: true }).click();
    assert.equal(await host.getByRole('button', { name: 'RTX 5090', exact: true }).count(), 0);
    assert.deepEqual(calls.filter(c => c[0].endsWith('region/gpu_type')).map(c => c[1].region_sign_list), [['bj1'], ['bj1', 'west1']]);
    await page.clock.runFor(300);
    await host.getByLabel('显卡驱动筛选', { exact: true }).selectOption('minimum');
    await host.getByLabel('最低驱动版本', { exact: true }).selectOption('550.54.15');
    assert.equal(await host.getByLabel('最低驱动版本', { exact: true }).evaluate(n => n.tagName), 'SELECT');
    assert.equal(calls.filter(c => c[0].endsWith('user/machine/list')).at(-1)[1].gpu_idle_num, 0);
    await host.getByLabel('显卡驱动筛选', { exact: true }).selectOption('exact');
    await host.getByLabel('570.10', { exact: true }).check();
    await host.getByLabel('550.54.15', { exact: true }).check();
    await host.getByLabel('显卡驱动筛选', { exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(__dirname, '../.research/ui-drivers.png') });
    await host.getByLabel('任务名称', { exact: true }).fill('训练任务 A');
    await host.getByLabel('每个实例 GPU 数量').fill('2');
    await host.getByLabel('实例最低内存（GB，0 不限制）', { exact: true }).fill('128');
    await host.getByLabel('主机可扩容容量至少（GB）', { exact: true }).fill('500');
    await page.clock.runFor(300);
    await host.getByLabel('使用的镜像', { exact: true }).selectOption('base-1');
    // 已选镜像也必须在更改地区后失效，不能误用旧配置。
    await host.getByRole('button', { name: '北京', exact: true }).click();
    assert.equal(await host.getByLabel('使用的镜像', { exact: true }).inputValue(), '');
    assert.equal(await host.getByLabel('570.10', { exact: true }).count(), 0);
    assert.equal(await host.getByRole('button', { name: '添加并启动新实例任务', exact: true }).isDisabled(), true);
    await host.getByRole('button', { name: '北京', exact: true }).click();
    await page.clock.runFor(300);
    await host.getByRole('button', { name: 'RTX 4090D', exact: true }).click();
    await host.getByRole('button', { name: 'RTX 4090', exact: true }).click();
    await page.clock.runFor(300);
    await host.getByLabel('570.10', { exact: true }).check();
    await host.getByLabel('550.54.15', { exact: true }).check();
    await page.clock.runFor(300);
    await host.getByLabel('使用的镜像', { exact: true }).selectOption('base-1');
    fs.mkdirSync(path.join(__dirname, '../.research'), { recursive: true });
    await host.locator('.section:visible').first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(__dirname, '../.research/ui-regions.png') });
    await host.getByLabel('使用的镜像', { exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(__dirname, '../.research/ui-new.png') });
    await host.getByRole('button', { name: '添加并启动新实例任务', exact: true }).click();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('mock-gm-autodl-helper-v1')).tasks.some(t => t.kind === 'new'));
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('mock-gm-autodl-helper-v1')).tasks.find(t => t.kind === 'new'));
    assert.equal(saved.config.driver.mode, 'exact');
    assert.equal(saved.config.minMemoryGb, 128);
    assert.deepEqual(saved.config.driver.value.split(','), ['570.10', '550.54.15']);

    // 第二个任务使用私有镜像，两个任务都应各创建一个。
    await host.getByRole('button', { name: '抢新实例', exact: true }).click();
    await host.getByLabel('任务名称', { exact: true }).fill('训练任务 B');
    await host.getByLabel('镜像来源', { exact: true }).selectOption('private');
    await page.clock.runFor(300);
    await host.getByLabel('使用的镜像', { exact: true }).selectOption('private-1');
    await host.getByRole('button', { name: '添加并启动新实例任务', exact: true }).click();
    await advance(11000);
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('mock-gm-autodl-helper-v1')).tasks.filter(t => t.kind === 'new' && t.instanceUuid).length === 2);
    assert.equal(createCount, 2);

    // 新标签页和原页面同时恢复，不应为已经创建的任务重复下单。
    const second = await context.newPage(); second.on('pageerror', e => errors.push(e.message));
    await second.goto('https://www.autodl.com/console/instance/list'); await second.addScriptTag({ content: script });
    await page.reload(); await page.addScriptTag({ content: script });
    await advance(11000);
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('mock-gm-autodl-helper-v1')).tasks.every(t => t.status === 'success'));
    assert.equal(createCount, 2);
    await page.locator('#autodl-helper-host button.launcher').click();
    await page.screenshot({ path: path.join(__dirname, '../.research/ui-tasks.png') });
    await page.locator('#autodl-helper-host').getByRole('button', { name: '设置', exact: true }).click();
    await page.screenshot({ path: path.join(__dirname, '../.research/ui-settings.png') });
    assert.equal(notifications.length, 3);
    // 从抢开机页面选择克隆，源实例先关机，新实例必须等数据盘完成。
    Object.assign(rows[0], { status: 'running', start_mode: 'non_gpu' }); originalIdle = 0;
    await page.locator('#autodl-helper-host').getByRole('button', { name: '抢开机', exact: true }).click();
    await page.clock.runFor(300);
    await page.locator('#autodl-helper-host').getByLabel(/我的无卡实例/).check();
    await page.locator('#autodl-helper-host').getByLabel('开机方式', { exact: true }).selectOption('clone');
    await page.clock.runFor(300);
    const cloneEditor = page.locator('#autodl-helper-host .clone-filter-editor');
    await cloneEditor.getByRole('button', { name: 'RTX 4090', exact: true }).click();
    await page.clock.runFor(300);
    await cloneEditor.getByLabel('克隆 GPU 数量', { exact: true }).fill('3');
    await cloneEditor.getByLabel('克隆实例最低内存（GB，0 不限制）', { exact: true }).fill('128');
    await cloneEditor.getByLabel('克隆主机可扩容容量至少（GB）', { exact: true }).fill('500');
    await cloneEditor.getByLabel('克隆实际额外扩容（GB）', { exact: true }).fill('100');
    await cloneEditor.getByLabel('克隆显卡驱动筛选', { exact: true }).selectOption('exact');
    await cloneEditor.getByLabel('570.10', { exact: true }).check();
    assert.equal(await cloneEditor.getByRole('button', { name: '北京', exact: true }).count(), 0);
    assert.equal(await cloneEditor.getByLabel('镜像来源', { exact: true }).count(), 0);
    await page.screenshot({ path: path.join(__dirname, '../.research/ui-clone.png') });
    await page.locator('#autodl-helper-host').getByRole('button', { name: '启动所选实例抢卡' }).click();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('mock-gm-autodl-helper-v1')).tasks.some(t => t.kind === 'clone'));
    const cloneSaved = await page.evaluate(() => JSON.parse(localStorage.getItem('mock-gm-autodl-helper-v1')).tasks.find(t => t.kind === 'clone'));
    assert.deepEqual(cloneSaved.targetFilters.gpus, ['RTX 4090']); assert.equal(cloneSaved.targetFilters.gpuCount, 3);
    assert.equal(cloneSaved.targetFilters.minMemoryGb, 128);
    await advance(11000);
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('mock-gm-autodl-helper-v1')).tasks.find(t => t.kind === 'clone')?.lastAction?.type === 'off');
    await advance(11000);
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('mock-gm-autodl-helper-v1')).tasks.find(t => t.kind === 'clone')?.instanceUuid);
    await advance(11000);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('mock-gm-autodl-helper-v1')).tasks.find(t => t.kind === 'clone').status), 'active');
    assert.equal(notifications.length, 3);
    rows.find(r => r.uuid === 'cloned-1').additional_info.copy_data_disk_after_clone_status = 'Succeed';
    await advance(11000);
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('mock-gm-autodl-helper-v1')).tasks.find(t => t.kind === 'clone')?.status === 'success');
    assert.equal(cloneCount, 1); assert.equal(notifications.length, 4);
    // 再建一个同源复合任务：原机有卡时直接原地开机，不能再创建克隆。
    Object.assign(rows[0], { status: 'running', start_mode: 'non_gpu' }); originalIdle = 1;
    await page.locator('#autodl-helper-host').getByRole('button', { name: '抢开机', exact: true }).click();
    await page.clock.runFor(300);
    await page.locator('#autodl-helper-host').getByRole('button', { name: '启动所选实例抢卡' }).click();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('mock-gm-autodl-helper-v1')).tasks.filter(t => t.kind === 'clone').length === 2);
    await advance(11000);
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('mock-gm-autodl-helper-v1')).tasks.filter(t => t.kind === 'clone').at(-1)?.lastAction?.type === 'off');
    await advance(11000);
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('mock-gm-autodl-helper-v1')).tasks.filter(t => t.kind === 'clone').at(-1)?.sourceStartIntent);
    await advance(11000);
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('mock-gm-autodl-helper-v1')).tasks.filter(t => t.kind === 'clone').at(-1)?.completedVia === 'original');
    assert.equal(cloneCount, 1); assert.equal(notifications.length, 5);
    // 两个页面同时接管一个尚未创建的任务，也只提交一次创建请求。
    await page.evaluate(() => {
      const key = 'mock-gm-autodl-helper-v1', s = JSON.parse(localStorage.getItem(key));
      const t = JSON.parse(JSON.stringify(s.tasks.find(t => t.kind === 'new')));
      Object.assign(t, { id: 'concurrent', marker: 'ADLH-concurrent', name: '并发恢复任务', status: 'active', instanceUuid: null, intent: null, nextAt: 0 });
      s.tasks.push(t); s.nextCycleAt = 0; localStorage.setItem(key, JSON.stringify(s));
    });
    await Promise.all([page.reload(), second.reload()]);
    await Promise.all([page.addScriptTag({ content: script }), second.addScriptTag({ content: script })]);
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('mock-gm-autodl-helper-v1')).tasks.find(t => t.id === 'concurrent')?.instanceUuid);
    assert.equal(createCount, 3);
    assert.deepEqual(errors, []);
    console.log('PASS: 地区优先流程、关联 GPU 筛选和重置、油猴面板、无卡转 GPU、双任务、刷新恢复、多标签页共享及通知');
    await context.close();
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
