'use strict';

// node --test 用例: HTTP 层 (server.js, 仅内置模块)
// 服务监听 127.0.0.1 临时端口, 不读取环境 PORT, 避免与本地演示实例冲突

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server');

let server, baseUrl;

before(async () => {
  server = createApp();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function post(path, body) {
  const res = await fetch(baseUrl + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  return { status: res.status, json };
}

describe('页面与路由', () => {
  test('GET / 返回含 data-evidence-result 的本地网页', async () => {
    const res = await fetch(baseUrl + '/');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    const html = await res.text();
    assert.ok(html.includes('data-evidence-result'));
    assert.ok(html.includes('接收离线称重单'));
    assert.ok(html.includes('模拟掉线补交'));
    assert.ok(html.includes('查看称重回执'));
  });

  test('未知路径返回 404, GET 调 API 返回 405', async () => {
    const r1 = await post('/no-such-path');
    assert.equal(r1.status, 404);
    const res = await fetch(baseUrl + '/api/demo/receive');
    assert.equal(res.status, 405);
  });
});

describe('演示三步: 顺序约束与业务结果', () => {
  test('未执行步骤 1 时, 步骤 2/3 被拒绝 (409)', async () => {
    const r2 = await post('/api/demo/reconnect');
    assert.equal(r2.status, 409);
    assert.match(r2.json.error, /步骤 1/);
    const r3 = await post('/api/demo/receipts');
    assert.equal(r3.status, 409);
  });

  test('步骤 1: 接收离线称重单, 待确认 1, 净重 46.0', async () => {
    const r = await post('/api/demo/receive');
    assert.equal(r.status, 200);
    assert.equal(r.json.after.canonicalCount, 3);
    assert.equal(r.json.after.pendingConfirmationCount, 1);
    assert.equal(r.json.after.netWeightTotal, 46.0);
    assert.equal(r.json.delta.canonicalCount, 3);
  });

  test('重复执行步骤 1 被拒绝 (409)', async () => {
    const r = await post('/api/demo/receive');
    assert.equal(r.status, 409);
  });

  test('步骤 2: 掉线补交后待确认清零, 净重 97.1, 重复执行被拒', async () => {
    const r = await post('/api/demo/reconnect');
    assert.equal(r.status, 200);
    const m = r.json.after;
    assert.equal(m.canonicalCount, 5);
    assert.equal(m.pendingConfirmationCount, 0);
    assert.equal(m.netWeightTotal, 97.1);
    assert.equal(m.duplicateCount, 1);
    assert.equal(m.conflictCount, 1);
    assert.equal(m.rejectedCount, 1);
    const again = await post('/api/demo/reconnect');
    assert.equal(again.status, 409);
  });

  test('步骤 3: 查看回执只读, before/after 完全一致', async () => {
    const r = await post('/api/demo/receipts');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.before, r.json.after);
    assert.equal(r.json.snapshot.receipts.length, 5);
    const keys = r.json.snapshot.receipts.map((x) => x.key).sort();
    assert.deepEqual(keys, [
      'SCALE-A-01#1', 'SCALE-A-01#2', 'SCALE-A-01#3',
      'SCALE-A-01#4', 'SCALE-B-07#1',
    ]);
  });

  test('重置后状态回到空仓, 可重新演示', async () => {
    const r = await post('/api/demo/reset');
    assert.equal(r.status, 200);
    assert.equal(r.json.state.metrics.canonicalCount, 0);
    const again = await post('/api/demo/receive');
    assert.equal(again.status, 200);
    assert.equal(again.json.after.canonicalCount, 3);
    await post('/api/demo/reset');
  });
});

describe('通用投递入口的异常路径', () => {
  test('非法 JSON 返回 400', async () => {
    const res = await fetch(baseUrl + '/api/slip/receive', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{bad-json',
    });
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.match(json.error, /JSON/);
  });

  test('字段非法单据返回 422 且不入库', async () => {
    const r = await post('/api/slip/receive', { deviceId: 'X', seq: -1, netWeight: 0, shift: '' });
    assert.equal(r.status, 422);
    assert.equal(r.json.result.status, 'rejected');
    assert.equal(r.json.metrics.canonicalCount, 0);
    assert.equal(r.json.metrics.rejectedCount, 1);
  });

  test('正常单据 200 入库, 同内容补发仍只占一个回执槽位', async () => {
    const payload = {
      deviceId: 'SCALE-C-02', seq: 1, shift: '晚班', dish: '测试藕片',
      grossWeight: 9, tareWeight: 1, netWeight: 8, weighedAt: '2026-11-21T10:00:00',
    };
    const r1 = await post('/api/slip/receive', payload);
    assert.equal(r1.status, 200);
    assert.equal(r1.json.result.status, 'accepted');
    const r2 = await post('/api/slip/receive', payload);
    assert.equal(r2.json.result.status, 'duplicate');
    assert.equal(r2.json.metrics.receiptCount, 1);
    assert.equal(r2.json.metrics.canonicalCount, 1);
  });
});
