'use strict';

// node --test 用例: 状态引擎的正常与异常结果
// 运行: node --test   (或 node --test test/store.test.js)

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { Store, businessKey, validateSlip } = require('../lib/store');
const {
  createStore, receiveOfflineBatch, simulateReconnect, viewReceipts,
} = require('../lib/scenario');

const slip = (over = {}) => ({
  deviceId: 'SCALE-A-01', seq: 1, shift: '早班', dish: '土豆丝',
  grossWeight: 12.5, tareWeight: 0.8, netWeight: 11.7,
  weighedAt: '2026-11-21T07:12:00', ...over,
});

describe('正常流程: 接收端落原单, 入库端按设备序号归单', () => {
  test('三张离线单各自入库并生成独立回执, 净重按班次累加', () => {
    const store = new Store();
    const r1 = store.receive(slip({ seq: 1, netWeight: 11.7 }));
    const r2 = store.receive(slip({ seq: 2, netWeight: 17.2 }));
    const r3 = store.receive(slip({ seq: 3, netWeight: 17.1, shift: '中班' }));

    assert.equal(r1.status, 'accepted');
    assert.equal(r2.status, 'accepted');
    assert.equal(r3.status, 'accepted');
    const m = store.metrics();
    assert.equal(m.rawCount, 3);
    assert.equal(m.canonicalCount, 3);
    assert.equal(m.receiptCount, 3);
    assert.equal(m.netWeightTotal, 46.0);
    assert.deepEqual(m.netWeightByShift, { 早班: 28.9, 中班: 17.1 });
    assert.equal(m.pendingConfirmationCount, 3);
  });

  test('接收端每次投递都落原单, 原单流水号与入库代理键各自独立', () => {
    const store = new Store();
    store.receive(slip({ seq: 1 }));
    store.receive(slip({ seq: 2 }));
    assert.equal(store.snapshot().rawInbox.length, 2);
    assert.match(store.snapshot().rawInbox[0].inboxId, /^IN-\d+$/);
  });
});

describe('回执槽位: 补发只占一个位置', () => {
  test('内容一致的重传为幂等 duplicate, 不新增正式单与回执', () => {
    const store = new Store();
    const first = store.receive(slip());
    const again = store.receive(slip());
    assert.equal(again.status, 'duplicate');
    assert.equal(again.canonicalId, first.canonicalId);
    assert.equal(again.receiptId, 'R-0001');
    const m = store.metrics();
    assert.equal(m.canonicalCount, 1);
    assert.equal(m.receiptCount, 1);
    assert.equal(m.duplicateCount, 1);
    assert.equal(m.rawCount, 2); // 两次投递都在接收端留痕
  });

  test('回执丢包后重投仍是同一槽位, 送达后待确认清零', () => {
    const store = new Store();
    const r = store.receive(slip());
    store.attemptDelivery(r.key, false); // 丢包
    assert.equal(store.metrics().receiptsPendingDelivery, 1);
    assert.deepEqual(store.confirmReceipt(r.key), { ok: false, reason: 'receipt-not-delivered' });

    store.attemptDelivery(r.key, true); // 补发后重投
    const confirm = store.confirmReceipt(r.key);
    assert.equal(confirm.ok, true);
    const receipt = store.receipts.get(r.key);
    assert.equal(receipt.deliveryAttempts, 2);
    assert.equal(receipt.status, 'delivered');
    assert.equal(store.metrics().pendingConfirmationCount, 0);
    // 重复确认不报错, 但不会重复计数
    const again = store.confirmReceipt(r.key);
    assert.equal(again.ok, true);
    assert.equal(again.alreadyConfirmed, true);
  });
});

describe('时钟回拨与跨班次: 时间戳不参与唯一性', () => {
  test('时钟校回后新单时间戳更早, 仍按单调序号归单且班次净重正确', () => {
    const store = new Store();
    store.receive(slip({ seq: 3, netWeight: 17.1, weighedAt: '2026-11-21T08:05:00' }));
    const later = store.receive(slip({
      seq: 4, shift: '中班', netWeight: 23.0,
      weighedAt: '2026-11-21T08:40:00', // 时钟回拨, 时间戳早于真实先后
    }));
    assert.equal(later.status, 'accepted');
    assert.equal(later.key, businessKey('SCALE-A-01', 4));
    const m = store.metrics();
    assert.equal(m.canonicalCount, 2);
    assert.equal(m.netWeightTotal, 40.1);
    assert.deepEqual(m.netWeightByShift, { 早班: 17.1, 中班: 23.0 });
  });
});

describe('换机重号: 设备身份区分业务键', () => {
  test('不同设备同序号是两张单, 各占回执槽位; 换机登记留痕', () => {
    const store = new Store();
    const a = store.receive(slip({ deviceId: 'SCALE-A-01', seq: 1, netWeight: 11.7 }));
    const event = store.registerReplacement('SCALE-A-01', 'SCALE-B-07', '传感器故障');
    const b = store.receive(slip({ deviceId: 'SCALE-B-07', seq: 1, netWeight: 28.1 }));

    assert.notEqual(a.key, b.key);
    assert.equal(a.key, 'SCALE-A-01#1');
    assert.equal(b.key, 'SCALE-B-07#1');
    assert.equal(store.metrics().receiptCount, 2);
    assert.equal(store.metrics().deviceCount, 2);
    assert.equal(store.snapshot().deviceHistory[0].newDeviceId, event.newDeviceId);
    // B 秤继续传 seq=2 不与 A 秤冲突
    assert.equal(store.receive(slip({ deviceId: 'SCALE-B-07', seq: 2, netWeight: 5 })).status, 'accepted');
  });
});

describe('异常结果', () => {
  test('同键重传但净重被篡改 -> conflict, 保留首单且净重总量不变', () => {
    const store = new Store();
    store.receive(slip({ seq: 2, netWeight: 17.2 }));
    const conflict = store.receive(slip({ seq: 2, netWeight: 17.9 }));
    assert.equal(conflict.status, 'conflict');
    const m = store.metrics();
    assert.equal(m.conflictCount, 1);
    assert.equal(m.canonicalCount, 1);
    assert.equal(m.netWeightTotal, 17.2); // 篡改值 17.9 不进入总量
    const doc = store.snapshot().canonical.find((d) => d.key === 'SCALE-A-01#2');
    assert.equal(doc.conflicts.length, 1);
    assert.equal(doc.conflicts[0].payload.netWeight, 17.9);
    assert.equal(store.metrics().receiptCount, 1); // 冲突不产生新回执
  });

  test('字段顺序不同但内容相同的重传仍判为幂等', () => {
    const store = new Store();
    store.receive(slip({ seq: 1 }));
    const reordered = {
      weighedAt: '2026-11-21T07:12:00', netWeight: 11.7, tareWeight: 0.8,
      grossWeight: 12.5, dish: '土豆丝', shift: '早班', seq: 1, deviceId: 'SCALE-A-01',
    };
    assert.equal(store.receive(reordered).status, 'duplicate');
  });

  test('非法单据被拒收: 缺设备/坏序号/负净重/缺班次', () => {
    const store = new Store();
    const bad = [
      slip({ deviceId: '  ' }),
      slip({ seq: 0 }),
      slip({ seq: 1.5 }),
      slip({ seq: '1' }),
      slip({ netWeight: -1 }),
      slip({ netWeight: NaN }),
      slip({ shift: '' }),
      null,
      'not-an-object',
      [slip()],
    ];
    for (const payload of bad) {
      const r = store.receive(payload);
      assert.equal(r.status, 'rejected', `应拒收: ${JSON.stringify(payload)}`);
      assert.ok(r.error.length > 0);
    }
    const m = store.metrics();
    assert.equal(m.rejectedCount, bad.length);
    assert.equal(m.canonicalCount, 0);
    assert.equal(m.receiptCount, 0);
    assert.equal(m.netWeightTotal, 0);
    // 拒收也在接收端留痕
    assert.equal(store.snapshot().rawInbox.length, bad.length);
    assert.ok(store.snapshot().rawInbox.every((e) => e.kind === 'rejected'));
  });

  test('validateSlip 对 weighedAt 非字符串给出明确错误', () => {
    assert.equal(validateSlip(slip({ weighedAt: 123 })), '称重时间 weighedAt 必须是字符串');
    assert.equal(validateSlip(slip()), null);
  });

  test('不存在的业务键无法确认回执', () => {
    const store = new Store();
    assert.deepEqual(store.confirmReceipt('NOPE#9'), { ok: false, reason: 'receipt-not-found' });
    assert.equal(store.attemptDelivery('NOPE#9', true), null);
  });
});

describe('端到端虚构场景: 断网跨班次再重传', () => {
  test('步骤一: 3 单入库, 1 张回执丢包 -> 待确认 1, 净重 46.0', () => {
    const store = createStore();
    const out = receiveOfflineBatch(store);
    const m = out.after;
    assert.equal(m.canonicalCount, 3);
    assert.equal(m.netWeightTotal, 46.0);
    assert.equal(m.netWeightByShift['早班'], 46.0);
    assert.equal(m.pendingConfirmationCount, 1);
    assert.equal(m.receiptsPendingDelivery, 1);
    assert.equal(m.receiptsDelivered, 2);
    assert.deepEqual(out.delta.canonicalCount, 3);
    assert.deepEqual(out.delta.netWeightTotal, 46.0);
    const stuck = store.receipts.get('SCALE-A-01#1');
    assert.equal(stuck.status, 'pending-delivery');
    assert.equal(stuck.deliveryAttempts, 1);
  });

  test('步骤二: 补发幂等 + 跨班次 + 换机重号 + 冲突 + 拒收, 待确认清零', () => {
    const store = createStore();
    receiveOfflineBatch(store);
    const out = simulateReconnect(store);
    const m = out.after;
    // 5 张正式单: 早班 3 + 中班 A#4 + 中班 B#1
    assert.equal(m.canonicalCount, 5);
    assert.equal(m.receiptCount, 5);
    assert.equal(m.netWeightTotal, 97.1);
    assert.deepEqual(m.netWeightByShift, { 早班: 46.0, 中班: 51.1 });
    assert.equal(m.duplicateCount, 1);
    assert.equal(m.conflictCount, 1);
    assert.equal(m.rejectedCount, 1);
    assert.equal(m.rawCount, 7); // 8 次投递中 1 次拒收不计入
    assert.equal(store.snapshot().rawInbox.length, 8);
    assert.equal(m.pendingConfirmationCount, 0);
    assert.equal(m.receiptsPendingDelivery, 0);
    assert.equal(m.receiptsDelivered, 5);
    // 丢过包的回执仍是同一个, 累计投递 2 次
    const r1 = store.receipts.get('SCALE-A-01#1');
    assert.equal(r1.receiptId, 'R-0001');
    assert.equal(r1.deliveryAttempts, 2);
    assert.ok(r1.confirmedAt);
    // 换机重号各自独立
    assert.ok(store.receipts.has('SCALE-A-01#1'));
    assert.ok(store.receipts.has('SCALE-B-07#1'));
  });

  test('步骤三: 查看回执为只读操作, 指标零变化', () => {
    const store = createStore();
    receiveOfflineBatch(store);
    simulateReconnect(store);
    const out = viewReceipts(store);
    assert.deepEqual(out.before, out.after);
    assert.deepEqual(out.delta, {});
    assert.equal(out.snapshot.receipts.length, 5);
  });

  test('快照为纯 JSON 数据且包含换机历史与冲突明细', () => {
    const store = createStore();
    receiveOfflineBatch(store);
    simulateReconnect(store);
    const snap = store.snapshot();
    assert.doesNotThrow(() => JSON.stringify(snap));
    assert.equal(snap.deviceHistory.length, 1);
    const conflicted = snap.canonical.find((d) => d.key === 'SCALE-A-01#2');
    assert.equal(conflicted.conflicts.length, 1);
  });
});
