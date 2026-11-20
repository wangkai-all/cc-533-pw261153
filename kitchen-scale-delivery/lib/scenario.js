'use strict';

// 虚构演示数据与场景编排 (全部为虚构的后厨称重数据)
//
// 时间线:
//   早班期间 SCALE-A-01 离线称了 3 单 (本机序号 1~3), 回执 R-0001 发出时丢包;
//   换班到中班, 时钟被校回 (9:05 -> 8:40), 补传时序号继续递增, 不看时间戳;
//   备用秤 SCALE-B-07 启用 (换机登记), 它的 seq=1 与 A 的 seq=1 靠设备身份区分;
//   另含一单据内容篡改的重传 (冲突) 与一张字段非法的单据 (拒收)。

const { Store } = require('./store');

function createStore() {
  return new Store();
}

// 步骤一: 接收离线称重单 (早班 3 单; 模拟第 1 张回执送达失败)
function receiveOfflineBatch(store) {
  const events = [];
  const before = store.metrics();

  const slips = [
    {
      deviceId: 'SCALE-A-01', seq: 1, shift: '早班', dish: '土豆丝',
      grossWeight: 12.5, tareWeight: 0.8, netWeight: 11.7,
      weighedAt: '2026-11-21T07:12:00',
    },
    {
      deviceId: 'SCALE-A-01', seq: 2, shift: '早班', dish: '黄瓜片',
      grossWeight: 18.2, tareWeight: 1.0, netWeight: 17.2,
      weighedAt: '2026-11-21T07:40:00',
    },
    {
      deviceId: 'SCALE-A-01', seq: 3, shift: '早班', dish: '萝卜块',
      grossWeight: 19.4, tareWeight: 2.3, netWeight: 17.1,
      weighedAt: '2026-11-21T08:05:00',
    },
  ];

  slips.forEach((slip, i) => {
    const result = store.receive(slip);
    events.push({ action: 'receive', slip, result });
    // 前两张回执送达; 第 1 张 (seq=1) 回执包丢失
    if (i === 0) {
      const delivery = store.attemptDelivery(result.key, false);
      events.push({
        action: 'receipt-delivery',
        key: result.key,
        success: false,
        note: '回执包在网络上丢失, 槽位仍保留, 等待补发后重投',
        deliveryAttempts: delivery.deliveryAttempts,
      });
    } else {
      const delivery = store.attemptDelivery(result.key, true);
      const confirm = store.confirmReceipt(result.key);
      events.push({
        action: 'receipt-delivery',
        key: result.key,
        success: true,
        deliveryAttempts: delivery.deliveryAttempts,
        confirm,
      });
    }
  });

  const after = store.metrics();
  return {
    step: 1,
    title: '接收离线称重单',
    narrative: [
      '早班期间后厨秤 SCALE-A-01 离线作业, 3 张称重单按本机序号 1/2/3 暂存本机。',
      '网络恢复后批量上传: 接收端对每次投递都落一份原单 (rawInbox), 入库端按「设备身份+本机序号」归单。',
      'seq=1 的回执 R-0001 发出后丢包, 上传方未收到 -> 该单进入待确认; seq=2/3 回执送达并确认。',
    ],
    before,
    after,
    delta: diffMetrics(before, after),
    events,
    snapshot: store.snapshot(),
  };
}

// 步骤二: 模拟掉线补交 (跨班次 + 时钟回拨 + 换机重号 + 异常单)
function simulateReconnect(store) {
  const events = [];
  const before = store.metrics();

  // 换机登记: A 秤故障, 备用秤 B 启用, B 从自己的 seq=1 开始
  const replacement = store.registerReplacement(
    'SCALE-A-01', 'SCALE-B-07', 'A 秤传感器故障, 换用备用秤',
  );
  events.push({ action: 'device-replacement', replacement });

  // 1) 时钟回拨后补发 seq=1 (内容完全一致) -> 幂等 duplicate, 原回执槽位重投
  const resend1 = {
    deviceId: 'SCALE-A-01', seq: 1, shift: '早班', dish: '土豆丝',
    grossWeight: 12.5, tareWeight: 0.8, netWeight: 11.7,
    weighedAt: '2026-11-21T07:12:00',
  };
  events.push({ action: 'receive', slip: resend1, result: store.receive(resend1) });
  const redelivery = store.attemptDelivery('SCALE-A-01#1', true);
  const confirm1 = store.confirmReceipt('SCALE-A-01#1');
  events.push({
    action: 'receipt-delivery',
    key: 'SCALE-A-01#1',
    success: true,
    note: '同槽回执重投成功, 不会生成第二张回执',
    deliveryAttempts: redelivery.deliveryAttempts,
    confirm: confirm1,
  });

  // 2) 中班新单 seq=4, 时钟已被校回 (08:40 早于早班 seq=3 的 08:05 之后的真实时间)
  //    归单只看设备+序号, 时间戳回拨不影响顺序与唯一性
  const shiftSlip = {
    deviceId: 'SCALE-A-01', seq: 4, shift: '中班', dish: '白菜帮',
    grossWeight: 25.0, tareWeight: 2.0, netWeight: 23.0,
    weighedAt: '2026-11-21T08:40:00', // 时钟校回后产生的时间戳
    note: '时钟已被校回, 但 seq 单调递增, 仍排在 seq=3 之后',
  };
  events.push({ action: 'receive', slip: shiftSlip, result: store.receive(shiftSlip) });
  store.attemptDelivery('SCALE-A-01#4', true);
  events.push({ action: 'receipt-delivery', key: 'SCALE-A-01#4', success: true,
    confirm: store.confirmReceipt('SCALE-A-01#4') });

  // 3) 备用秤 B 的 seq=1: 与 A 的 seq=1 同号, 靠设备身份区分 -> 新单据, 新回执槽位
  const scaleBSlip = {
    deviceId: 'SCALE-B-07', seq: 1, shift: '中班', dish: '洋葱丝',
    grossWeight: 30.5, tareWeight: 2.4, netWeight: 28.1,
    weighedAt: '2026-11-21T09:02:00',
  };
  events.push({ action: 'receive', slip: scaleBSlip, result: store.receive(scaleBSlip) });
  store.attemptDelivery('SCALE-B-07#1', true);
  events.push({ action: 'receipt-delivery', key: 'SCALE-B-07#1', success: true,
    confirm: store.confirmReceipt('SCALE-B-07#1') });

  // 4) 异常 A: 同设备同序号重传但净重被篡改 -> conflict, 保留首单, 不发新回执
  const tampered = {
    deviceId: 'SCALE-A-01', seq: 2, shift: '早班', dish: '黄瓜片',
    grossWeight: 18.2, tareWeight: 1.0, netWeight: 17.9, // 17.2 -> 17.9
    weighedAt: '2026-11-21T07:40:00',
  };
  events.push({ action: 'receive', slip: tampered, result: store.receive(tampered) });

  // 5) 异常 B: 字段非法 (净重为负, 缺班次) -> rejected, 只落原单不入库
  const malformed = {
    deviceId: 'SCALE-A-01', seq: 9, shift: '', dish: '异常单',
    grossWeight: 5, tareWeight: 6, netWeight: -1,
    weighedAt: '2026-11-21T09:10:00',
  };
  events.push({ action: 'receive', slip: malformed, result: store.receive(malformed) });

  const after = store.metrics();
  return {
    step: 2,
    title: '模拟掉线补交',
    narrative: [
      '换班后设备时钟被校回 (新单时间戳反而更早), 但归单只认设备身份+本机序号, seq 单调递增, 顺序不受影响。',
      'seq=1 原单内容不变地补发 -> 幂等命中, 不新增入库单、不新增回执; 原回执槽位重投成功, 待确认清零。',
      '备用秤 SCALE-B-07 启用并先做换机登记; 它的 seq=1 与 A 秤 seq=1 业务键不同, 各自占独立回执槽位。',
      '篡改净重的重传被识别为冲突 (保留首单); 字段非法的单据被拒收, 两者都不影响净重总量。',
    ],
    before,
    after,
    delta: diffMetrics(before, after),
    events,
    snapshot: store.snapshot(),
  };
}

// 步骤三: 查看回执 (只读, 不改任何状态)
function viewReceipts(store) {
  const before = store.metrics();
  const snapshot = store.snapshot();
  return {
    step: 3,
    title: '查看称重回执',
    narrative: [
      '一张业务单据自始至终只有一个回执槽位: 补发再多, 回执号不变、状态只更新一次。',
      '待确认单据以上传方视角统计: 回执未送达 (pending-delivery) 才算待确认; 已送达未确认也在 pendingKeys 中体现。',
      '换机重号通过业务键 deviceId#seq 区分, 回执号与入库代理键一一对应。',
    ],
    before,
    after: before,
    delta: {}, // 只读操作, 无任何指标变化
    snapshot,
  };
}

function diffMetrics(before, after) {
  const out = {};
  for (const k of Object.keys(after)) {
    if (typeof after[k] === 'number') {
      out[k] = roundDelta(after[k] - before[k]);
    }
  }
  return out;
}

function roundDelta(n) {
  return Math.round((n + Number.EPSILON) * 1000) / 1000;
}

module.exports = { createStore, receiveOfflineBatch, simulateReconnect, viewReceipts };
