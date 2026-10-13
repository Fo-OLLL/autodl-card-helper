'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Api, ApiError, Engine, fresh, compareVersion, sortMachines, createPayload, groupRegions,
  flattenImages, regionalGpuOptions, availableDrivers, instanceDisplay, isGpuRunning, serverChanUrl, validateNew } = require('../autodl-helper.user.js');
const copy = x => JSON.parse(JSON.stringify(x));
const GB = 1024 ** 3;
const config = () => ({ gpus: ['RTX 4090D', 'RTX 4090'], regions: [{ name: '北京', signs: ['bj'] }, { name: '西北', signs: ['west'] }],
  gpuCount: 2, minExpandGb: 500, expandGb: 100, driver: { mode: 'minimum', value: '550' },
  image: { type: 'base', uuid: 'base-1', chip_corp: 'nvidia', cpu_arch: 'x86', cuda: '12.1' } });
const machine = (overrides = {}) => ({ machine_id: 'm1', gpu_name: 'RTX 4090D', gpu_idle_num: 2,
  region_sign: 'west', driver_version: '550.54.15', max_data_disk_expand_size: 500 * GB,
  max_instance_num: 10, binding_instance_num: 2, on_line: 1, chip_corp: 'nvidia', cpu_arch: 'x86', highest_cuda_version: '12.4', ...overrides });
const existing = (id, uuid = id) => ({ id, name: id, kind: 'existing', instanceUuid: uuid, account: 'account', status: 'active' });
const newTask = id => ({ id, name: id, marker: `ADLH-${id}`, kind: 'new', config: config(), account: 'account', status: 'active' });
function fixture(tasks, api = {}) {
  let state = { ...fresh(), tasks: copy(tasks) }, time = 100000;
  const calls = [], defaults = {
    instances: async () => [], machines: async () => [machine()],
    create: async () => 'created', powerOn: async () => {}, powerOff: async () => {}, init: async () => {}
  };
  const wrapped = Object.fromEntries(Object.entries({ ...defaults, ...api }).map(([name, fn]) => [name, async (...args) => {
    calls.push([name, ...copy(args)]); return fn(...args);
  }]));
  const read = () => copy(state), update = async fn => { const s = copy(state), value = fn(s); state = s; return value; };
  return { engine: new Engine({ api: wrapped, read, update, now: () => time }), read, update, calls,
    advance(n) { time += n; }, restart() { return new Engine({ api: wrapped, read, update, now: () => time }); } };
}

test('驱动版本按数字比较，未知版本不能通过受限筛选', () => {
  assert.equal(compareVersion('550.9', '550.10'), -1);
  assert.equal(compareVersion('550', '550.0'), 0);
  assert.equal(compareVersion('', '550'), null);
  assert.equal(sortMachines([machine({ driver_version: 'unknown' })], config()).length, 0);
});
test('GPU 优先于地区，多卡数量和 GB/字节转换参与筛选', () => {
  const c = config();
  const rows = [machine({ machine_id: 'lowerGpu', gpu_name: 'RTX 4090', region_sign: 'bj' }),
    machine({ machine_id: 'preferred' }), machine({ machine_id: 'best', region_sign: 'bj' }),
    machine({ machine_id: 'noCards', gpu_idle_num: 1 }), machine({ machine_id: 'diskSmall', max_data_disk_expand_size: 499 * GB })];
  assert.deepEqual(sortMachines(rows, c).map(m => m.machine_id), ['best', 'preferred', 'lowerGpu']);
});
test('指定驱动可多选，实际扩容也必须满足容量限制', () => {
  const c = config(); c.driver = { mode: 'exact', value: '550.54.15, 570.10' };
  assert.equal(sortMachines([machine()], c).length, 1);
  assert.equal(sortMachines([machine({ driver_version: '550.54.16' })], c).length, 0);
  c.expandGb = 501;
  assert.equal(sortMachines([machine()], c).length, 0);
});
test('维护、实例槽位耗尽、镜像架构或驱动不兼容的主机不会创建', () => {
  const rows = [machine({ on_line: 3 }), machine({ binding_instance_num: 10 }), machine({ cpu_arch: 'arm64' }),
    machine({ highest_cuda_version: '11.8' })];
  assert.equal(sortMachines(rows, config()).length, 0);
});
test('创建请求使用当前网页 base_image_uuid、按量计费、扩容字节和唯一名称', () => {
  const t = newTask('one'), p = createPayload(t, machine());
  assert.equal(p.instance_info.base_image_uuid, 'base-1');
  assert.equal(p.instance_info.instance_name, 'ADLH-one');
  assert.equal(p.instance_info.req_gpu_amount, 2);
  assert.equal(p.price_info.expand_data_disk, 100 * GB);
  assert.equal(p.instance_info.charge_type, 'payg');
  t.config.image = { type: 'private', uuid: 'mine' };
  assert.equal(createPayload(t, machine()).instance_info.private_image_uuid, 'mine');
  assert.equal(createPayload(t, machine()).instance_info.base_image_uuid, '');
});
test('实时地区分组和基础镜像树展开', () => {
  assert.deepEqual(groupRegions([{ region_sign: 'w1', data_center: 'west', region_name: '西北', visible: 'all', used_for: 'all' },
    { region_sign: 'w2', data_center: 'west', region_name: '西北', visible: 'all', used_for: 'all' },
    { region_sign: 'vip', data_center: 'private', visible: 'enterprise', used_for: 'all' }])[0].signs, ['w1', 'w2']);
  assert.equal(flattenImages([{ label_name: 'PyTorch', children: [{ label_name: '2.5', children: [
    { label_name: { uuid: 'image', v: '12.4', cpu_arch: 'x86', chip_corp: 'nvidia' } } ] }] }])[0].name, 'PyTorch / 2.5 / 12.4');
});
test('地区 GPU 仅展示当地型号，保留零空闲型号并合并架构信息', () => {
  const catalog = ['RTX 4090', 'RTX 4090D', 'RTX 5090', 'CPU'].map(gpu_name => ({
    gpu_name, chip_corp: gpu_name === 'CPU' ? 'cpu' : 'nvidia', cpu_arch: 'x86'
  }));
  const result = regionalGpuOptions([{ 'RTX 4090': { idle: 0 } }, { 'RTX 4090D': { idle: 2 } },
    { 'RTX 4090': { idle: 1 }, CPU: {} }], catalog);
  assert.deepEqual(result.map(g => g.id), ['RTX 4090', 'RTX 4090D']);
  assert.equal(result[0].cpu_arch, 'x86');
  assert.equal(result[0].chip_corp, 'nvidia');
  assert.deepEqual(regionalGpuOptions([], catalog), []);
  assert.throws(() => regionalGpuOptions({}, catalog));
});
test('驱动选项去重、忽略无效字段，按数值而非字符串排序', () => {
  assert.deepEqual(availableDrivers(['550.9', '550.10', '570.10', '550.9', '', 'unknown'].map(driver_version => ({ driver_version }))), ['570.10', '550.10', '550.9']);
});
test('实例展示显卡快照型号，运行/关机颜色区分，无卡模式保留型号', () => {
  const d = instanceDisplay({ snapshot_gpu_alias_name: 'RTX 4090D', start_mode: 'non_gpu', status: 'running', req_gpu_amount: 2 });
  assert.equal(d.gpu, 'RTX 4090D'); assert.equal(d.tone, 'running'); assert.equal(d.mode, '无卡模式');
  assert.equal(instanceDisplay({ status: 'shutdown' }).tone, 'shutdown');
  assert.equal(instanceDisplay({ status: 'shutdown_by_starting_error' }).tone, 'shutdown');
  assert.equal(instanceDisplay({ status: 'starting' }).tone, 'pending');
});
test('已选择多个实例全部完成，单个成功不终止其他任务', async () => {
  const f = fixture([existing('a'), existing('b')], { instances: async () => [
    { uuid: 'a', status: 'running', start_mode: 'gpu' }, { uuid: 'b', status: 'shutdown', start_mode: 'gpu' }] });
  await f.engine.tick();
  assert.equal(f.read().tasks[0].status, 'success');
  assert.equal(f.read().tasks[1].status, 'active');
  assert.equal(f.read().events.length, 1);
  assert.equal(f.calls.filter(c => c[0] === 'powerOn').length, 1);
  await f.engine.tick(); assert.equal(f.read().events.length, 1);
});
test('无卡模式先关机，等待关机完成才 GPU 开机，最终才算成功', async () => {
  let row = { uuid: 'a', status: 'running', start_mode: 'non_gpu' };
  const f = fixture([existing('a')], { instances: async () => [row] });
  await f.engine.tick(); assert.equal(f.calls.filter(c => c[0] === 'powerOff').length, 1);
  await f.engine.tick(); assert.equal(f.calls.filter(c => c[0] === 'powerOff').length, 1);
  assert.equal(f.calls.filter(c => c[0] === 'powerOn').length, 0);
  row.status = 'shutting_down'; await f.engine.tick();
  row.status = 'shutdown'; await f.engine.tick();
  assert.equal(f.calls.filter(c => c[0] === 'powerOn').length, 1);
  assert.equal(f.read().tasks[0].status, 'active');
  row = { ...row, status: 'running', start_mode: 'gpu' }; await f.engine.tick();
  assert.equal(f.read().tasks[0].status, 'success');
});
test('未知开机模式和 starting 状态都不能冒报成功', () => {
  assert.equal(isGpuRunning({ status: 'running' }), false);
  assert.equal(isGpuRunning({ status: 'starting', start_mode: 'gpu' }), false);
  assert.equal(isGpuRunning({ status: 'running', start_mode: 'non_gpu' }), false);
});
test('两个新实例任务各创建一个，与已有实例任务独立', async () => {
  const f = fixture([existing('a'), newTask('b'), newTask('c')], {
    instances: async () => [{ uuid: 'a', status: 'running', start_mode: 'gpu' }], create: async t => `result-${t.id}` });
  await f.engine.tick();
  assert.equal(f.read().tasks[0].status, 'success');
  assert.equal(f.calls.filter(c => c[0] === 'create').length, 2);
  await f.engine.tick(); assert.equal(f.calls.filter(c => c[0] === 'create').length, 2);
});
test('创建超时保留 intent，刷新后通过唯一名称找到原实例，不重复创建', async () => {
  let rows = [];
  const f = fixture([newTask('b')], { instances: async () => rows, create: async () => { throw new ApiError('超时', 'NetworkError', true); } });
  await f.engine.tick(); assert.ok(f.read().tasks[0].intent);
  f.advance(300000); const restarted = f.restart();
  await restarted.tick(); assert.equal(f.calls.filter(c => c[0] === 'create').length, 1);
  rows = [{ uuid: 'new-id', name: 'ADLH-b', status: 'running', start_mode: 'gpu' }];
  await restarted.tick();
  assert.equal(f.read().tasks[0].status, 'success');
  assert.equal(f.read().tasks[0].instanceUuid, 'new-id');
});
test('明确库存不足时继续重试，不终止任务', async () => {
  const f = fixture([newTask('b')], { create: async () => { throw new ApiError('库存不足', 'MachineGpuNumUpdateFailed'); } });
  await f.engine.tick(); assert.equal(f.read().tasks[0].intent, null);
  assert.equal(f.read().tasks[0].status, 'active');
  f.advance(10000); await f.engine.tick(); assert.equal(f.calls.filter(c => c[0] === 'create').length, 2);
});
test('服务器已接受但返回未知结构，保留创建意图而非重复下单', async () => {
  const f = fixture([newTask('b')], { create: async () => ({ unknown: true }) });
  await f.engine.tick(); await f.restart().tick();
  assert.ok(f.read().tasks[0].intent);
  assert.equal(f.calls.filter(c => c[0] === 'create').length, 1);
});
test('读取库存期间取消任务，禁止发出创建请求', async () => {
  const f = fixture([newTask('b')], { machines: async () => {
    await f.update(s => { s.tasks[0].status = 'cancelled'; }); return [machine()];
  } });
  await f.engine.tick(); assert.equal(f.calls.filter(c => c[0] === 'create').length, 0);
});
test('已发出创建请求后取消，仍保存返回 UUID，取消不隐瞒已创建结果', async () => {
  const f = fixture([newTask('b')], { create: async () => {
    await f.update(s => { s.tasks[0].status = 'cancelled'; }); return 'already-created';
  } });
  await f.engine.tick();
  assert.equal(f.read().tasks[0].instanceUuid, 'already-created');
  assert.equal(f.read().tasks[0].status, 'cancelled');
});
test('登录失效不终止任务，退避后自动恢复', async () => {
  let loggedIn = false;
  const f = fixture([existing('a')], { instances: async () => {
    if (!loggedIn) throw new ApiError('请登录', 'AuthorizeFailed');
    return [{ uuid: 'a', status: 'running', start_mode: 'gpu' }];
  } });
  await f.engine.tick(); assert.equal(f.read().tasks[0].status, 'active');
  loggedIn = true; f.advance(10000); await f.restart().tick();
  assert.equal(f.read().tasks[0].status, 'success');
});
test('已创建但初始化失败，仅重试原实例，不再创建第二个', async () => {
  const t = newTask('b'); t.instanceUuid = 'created';
  const f = fixture([t], { instances: async () => [{ uuid: 'created', status: 'create_failed' }] });
  await f.engine.tick();
  assert.equal(f.calls.filter(c => c[0] === 'init').length, 1);
  assert.equal(f.calls.filter(c => c[0] === 'create').length, 0);
});
test('接口每次读取最新会话，不发送其他账号的任务，不持久化 token', async () => {
  let calls = 0;
  const api = new Api(() => ({ token: 'secret', account: 'other', appVersion: '1' }), async () => { calls++; });
  await assert.rejects(api.powerOn('a', 'account'), { code: 'AccountChanged' });
  assert.equal(calls, 0);
  assert.equal(JSON.stringify(fresh()).includes('token'), false);
});
test('实例列表和库存列表按返回分页大小完整翻页', async () => {
  const bodies = [];
  const api = new Api(() => ({ token: 'secret', account: 'account', appVersion: '1' }), async (path, req) => {
    const body = JSON.parse(req.body); bodies.push(body);
    return { ok: true, json: async () => ({ code: 'Success', data: { list: [{ uuid: `p${body.page_index}` }], page_size: 1, result_total: 2 } }) };
  });
  assert.deepEqual((await api.instances('account')).map(r => r.uuid), ['p1', 'p2']);
  assert.deepEqual(bodies.map(b => b.page_index), [1, 2]);
});
test('HTTP 500、解析失败和网络失败标记结果不确定', async () => {
  for (const fetcher of [async () => ({ ok: false, status: 500 }), async () => ({ ok: true, json: async () => { throw Error(); } }),
    async () => { throw Error('network'); }]) {
    const api = new Api(() => ({ token: 'secret', account: 'account', appVersion: '1' }), fetcher);
    await assert.rejects(api.powerOn('a', 'account'), error => error.uncertain === true);
  }
});
test('Server酱兼容 Turbo 和 SC3，拒绝任意 URL 或注入内容', () => {
  assert.equal(serverChanUrl('SCT123abc'), 'https://sctapi.ftqq.com/SCT123abc.send');
  assert.equal(serverChanUrl('sctp123tabc'), 'https://123.push.ft07.com/send/sctp123tabc.send');
  assert.throws(() => serverChanUrl('SCTabc/../../bad'));
});
test('任务配置拒绝空镜像、非法数量和驱动版本', () => {
  assert.doesNotThrow(() => validateNew(config()));
  for (const change of [{ gpuCount: 0 }, { expandGb: -1 }, { image: null }, { driver: { mode: 'minimum', value: 'oops' } }]) {
    assert.throws(() => validateNew({ ...config(), ...change }));
  }
});
