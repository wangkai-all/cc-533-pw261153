'use strict';

// 后厨秤离线称重单: 接收端/入库端状态引擎 (纯逻辑, 不依赖 HTTP, 方便 node --test)
//
// 核心归单规则:
//   业务键 = 设备身份 deviceId + 本机序号 seq
//   与时钟完全无关 —— 换班后时钟被校回去, 时间戳只用于展示, 不参与唯一性与排序。
//   接收端每次投递都落一份原单(rawInbox); 入库端按业务键只保留一张正式单(canonical)。
//   一张业务单据只占一个回执槽位, 重传多少次都不会产生第二张回执。

function round3(n) {
  return Math.round((n + Number.EPSILON) * 1000) / 1000;
}

// 业务键: 设备身份 + 本机序号
function businessKey(deviceId, seq) {
  return `${deviceId}#${seq}`;
}

// 确定性 JSON: 字段顺序不同但内容相同的重传视为同一张单
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJson).join(',') + ']';
  }
  return '{' + Object.keys(value)
    .sort()
    .map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k]))
    .join(',') + '}';
}

// 单据合法性校验, 返回错误说明; 合法返回 null
function validateSlip(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return '称重单必须是 JSON 对象';
  }
  if (typeof payload.deviceId !== 'string' || payload.deviceId.trim() === '') {
    return '缺少设备身份 deviceId (非空字符串)';
  }
  if (!Number.isInteger(payload.seq) || payload.seq <= 0) {
    return '本机序号 seq 必须是正整数';
  }
  if (typeof payload.shift !== 'string' || payload.shift.trim() === '') {
    return '缺少班次 shift (非空字符串)';
  }
  if (typeof payload.netWeight !== 'number' || !Number.isFinite(payload.netWeight) || payload.netWeight <= 0) {
    return '净重 netWeight 必须是正数';
  }
  if (payload.weighedAt !== undefined && typeof payload.weighedAt !== 'string') {
    return '称重时间 weighedAt 必须是字符串';
  }
  return null;
}

class Store {
  constructor() {
    this.inboxSeq = 0;          // 原单流水号 (接收端自己的落盘序号)
    this.canonicalSeq = 0;      // 入库代理键 (仅内部使用, 不用于回执对账)
    this.rawInbox = [];         // 接收端原单: 每次投递一行, 重复也留痕
    this.canonical = new Map(); // 业务键 -> 入库正式单 (唯一)
    this.receipts = new Map();  // 业务键 -> 回执 (一单一槽)
    this.pendingKeys = new Set(); // 上传方视角: 已发出但尚未确认的业务键
    this.devices = new Map();   // 设备身份档案
    this.deviceHistory = [];    // 换机登记
    this.duplicateCount = 0;    // 内容一致的幂等重传次数
    this.conflictCount = 0;     // 同键但内容冲突的重传次数
    this.rejectedCount = 0;     // 校验拒收次数
  }

  _registerDevice(deviceId) {
    let device = this.devices.get(deviceId);
    if (!device) {
      device = { deviceId, firstSeenAt: new Date().toISOString() };
      this.devices.set(deviceId, device);
    }
    return device;
  }

  // 换机登记: 新设备以新身份起号, 从源头避免序号撞车无法辨认
  registerReplacement(oldDeviceId, newDeviceId, reason) {
    this._registerDevice(oldDeviceId);
    this._registerDevice(newDeviceId);
    const event = {
      at: new Date().toISOString(),
      oldDeviceId,
      newDeviceId,
      reason,
    };
    this.deviceHistory.push(event);
    return event;
  }

  // 接收一张称重单 (可能是首次上传, 也可能是掉线后的补发)
  receive(payload) {
    // 1. 合法性校验: 拒收也在接收端留痕, 但不进入库端
    const validationError = validateSlip(payload);
    if (validationError) {
      this.rejectedCount += 1;
      const entry = {
        inboxId: `IN-${++this.inboxSeq}`,
        receivedAt: new Date().toISOString(),
        kind: 'rejected',
        error: validationError,
        payload: payload === undefined ? null : payload,
      };
      this.rawInbox.push(entry);
      return { status: 'rejected', inboxId: entry.inboxId, error: validationError };
    }

    const { deviceId, seq } = payload;
    this._registerDevice(deviceId);
    const key = businessKey(deviceId, seq);

    // 2. 接收端先落一份原单 (重传也落, 保证投递事实可追溯)
    const rawEntry = {
      inboxId: `IN-${++this.inboxSeq}`,
      key,
      receivedAt: new Date().toISOString(),
      kind: 'raw',
      payload,
    };
    this.rawInbox.push(rawEntry);

    // 3. 入库端按业务键归单
    const existing = this.canonical.get(key);
    if (existing) {
      if (canonicalJson(existing.payload) !== canonicalJson(payload)) {
        // 同设备同序号但内容被改动: 保留首单, 冲突留痕, 不覆盖、不发新回执
        this.conflictCount += 1;
        existing.conflicts.push({
          inboxId: rawEntry.inboxId,
          receivedAt: rawEntry.receivedAt,
          payload,
        });
        rawEntry.kind = 'conflict';
        rawEntry.duplicateOf = existing.canonicalId;
        return {
          status: 'conflict',
          key,
          inboxId: rawEntry.inboxId,
          canonicalId: existing.canonicalId,
          error: '同设备同序号重传但单据内容不一致, 已保留首单并登记冲突',
        };
      }
      // 内容一致的补发: 幂等, 不新增正式单、不新增回执, 只占原单的一行投递记录
      this.duplicateCount += 1;
      rawEntry.kind = 'duplicate';
      rawEntry.duplicateOf = existing.canonicalId;
      return {
        status: 'duplicate',
        key,
        inboxId: rawEntry.inboxId,
        canonicalId: existing.canonicalId,
        receiptId: this.receipts.get(key).receiptId,
      };
    }

    // 4. 新业务单: 入库并只开一个回执槽位
    this.canonicalSeq += 1;
    const doc = {
      canonicalId: this.canonicalSeq,
      key,
      deviceId,
      seq,
      shift: payload.shift,
      payload,
      confirmMode: 'device-seq', // 按 设备身份+本机序号 确认
      firstReceivedAt: rawEntry.receivedAt,
      conflicts: [],
    };
    this.canonical.set(key, doc);

    const receipt = {
      receiptId: `R-${String(this.canonicalSeq).padStart(4, '0')}`,
      key,
      canonicalId: doc.canonicalId,
      deviceId,
      seq,
      shift: payload.shift,
      dish: payload.dish || '',
      netWeight: payload.netWeight,
      status: 'pending-delivery', // 回执已生成, 等待送达上传方
      createdAt: rawEntry.receivedAt,
      deliveredAt: null,
      deliveryAttempts: 0,
      confirmedAt: null,
    };
    this.receipts.set(key, receipt);
    this.pendingKeys.add(key);

    return {
      status: 'accepted',
      key,
      inboxId: rawEntry.inboxId,
      canonicalId: doc.canonicalId,
      receiptId: receipt.receiptId,
    };
  }

  // 回执投递尝试; success=false 模拟回执包丢失 (槽位仍是同一个)
  attemptDelivery(key, success) {
    const receipt = this.receipts.get(key);
    if (!receipt) return null;
    receipt.deliveryAttempts += 1;
    if (success && receipt.status !== 'delivered') {
      receipt.status = 'delivered';
      receipt.deliveredAt = new Date().toISOString();
    }
    return receipt;
  }

  // 上传方凭送达的回执确认; 未送达不允许确认
  confirmReceipt(key) {
    const receipt = this.receipts.get(key);
    if (!receipt) return { ok: false, reason: 'receipt-not-found' };
    if (receipt.status !== 'delivered') {
      return { ok: false, reason: 'receipt-not-delivered' };
    }
    const wasPending = this.pendingKeys.delete(key);
    if (wasPending) {
      receipt.confirmedAt = new Date().toISOString();
    }
    return { ok: true, alreadyConfirmed: !wasPending, receipt };
  }

  metrics() {
    const netWeightByShift = {};
    let netWeightTotal = 0;
    for (const doc of this.canonical.values()) {
      netWeightTotal += doc.payload.netWeight;
      netWeightByShift[doc.shift] = round3((netWeightByShift[doc.shift] || 0) + doc.payload.netWeight);
    }
    let receiptsDelivered = 0;
    let receiptsPendingDelivery = 0;
    for (const r of this.receipts.values()) {
      if (r.status === 'delivered') receiptsDelivered += 1;
      else receiptsPendingDelivery += 1;
    }
    return {
      rawCount: this.rawInbox.filter((e) => e.kind !== 'rejected').length,
      rejectedCount: this.rejectedCount,
      duplicateCount: this.duplicateCount,
      conflictCount: this.conflictCount,
      canonicalCount: this.canonical.size,
      netWeightTotal: round3(netWeightTotal),
      netWeightByShift,
      receiptCount: this.receipts.size,
      receiptsDelivered,
      receiptsPendingDelivery,
      pendingConfirmationCount: this.pendingKeys.size,
      deviceCount: this.devices.size,
    };
  }

  snapshot() {
    return {
      metrics: this.metrics(),
      rawInbox: structuredClone(this.rawInbox),
      canonical: structuredClone([...this.canonical.values()]),
      receipts: structuredClone([...this.receipts.values()]),
      pendingKeys: [...this.pendingKeys],
      devices: structuredClone([...this.devices.values()]),
      deviceHistory: structuredClone(this.deviceHistory),
    };
  }
}

module.exports = { Store, businessKey, validateSlip, canonicalJson, round3 };
