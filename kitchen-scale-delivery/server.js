'use strict';

// 本地演示服务: 仅使用 Node.js 内置模块
// 启动: node server.js  (端口取环境变量 PORT, 默认 3000; 绑定 127.0.0.1)

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const {
  createStore,
  receiveOfflineBatch,
  simulateReconnect,
  viewReceipts,
} = require('./lib/scenario');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY_BYTES = 1024 * 1024;

function createApp() {
  let store = createStore();
  let lastStep = 0;

  function sendJson(res, statusCode, body) {
    const text = JSON.stringify(body, null, 2);
    res.writeHead(statusCode, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(text);
  }

  function readJsonBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          reject(new Error('请求体超过 1MB 限制'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (chunks.length === 0) return resolve({});
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          reject(new Error('请求体不是合法 JSON'));
        }
      });
      req.on('error', reject);
    });
  }

  function ensureStepOrder(reqStep) {
    if (reqStep === 2 && lastStep < 1) {
      return '请先执行步骤 1「接收离线称重单」';
    }
    if (reqStep === 3 && lastStep < 1) {
      return '暂无回执, 请先执行步骤 1';
    }
    return null;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);

    // 静态页面
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      try {
        const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'));
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(html);
      } catch {
        sendJson(res, 500, { error: '页面文件缺失' });
      }
      return;
    }

    if (req.method !== 'POST' && url.pathname.startsWith('/api/')) {
      sendJson(res, 405, { error: '仅支持 POST' });
      return;
    }

    try {
      if (req.method === 'POST' && url.pathname === '/api/demo/receive') {
        if (lastStep >= 1) {
          sendJson(res, 409, { error: '步骤 1 已执行, 如需重跑请先重置演示' });
          return;
        }
        const result = receiveOfflineBatch(store);
        lastStep = 1;
        sendJson(res, 200, result);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/demo/reconnect') {
        const orderError = ensureStepOrder(2);
        if (orderError) {
          sendJson(res, 409, { error: orderError });
          return;
        }
        if (lastStep >= 2) {
          sendJson(res, 409, { error: '步骤 2 已执行, 如需重跑请先重置演示' });
          return;
        }
        const result = simulateReconnect(store);
        lastStep = 2;
        sendJson(res, 200, result);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/demo/receipts') {
        const orderError = ensureStepOrder(3);
        if (orderError) {
          sendJson(res, 409, { error: orderError });
          return;
        }
        const result = viewReceipts(store);
        lastStep = Math.max(lastStep, 3);
        sendJson(res, 200, result);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/demo/reset') {
        store = createStore();
        lastStep = 0;
        sendJson(res, 200, { ok: true, state: store.snapshot() });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/slip/receive') {
        // 通用入口: 直接投递一张称重单, 供异常用例/手工验证
        const body = await readJsonBody(req);
        const result = store.receive(body);
        sendJson(res, result.status === 'rejected' ? 422 : 200, {
          result,
          metrics: store.metrics(),
        });
        return;
      }

      sendJson(res, 404, { error: '未找到该路径' });
    } catch (err) {
      sendJson(res, 400, { error: err.message || '请求处理失败' });
    }
  });

  return server;
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const host = '127.0.0.1';
  const server = createApp();
  server.listen(port, host, () => {
    console.log(`后厨秤离线称重单演示已启动: http://${host}:${port}`);
    console.log('页面按钮: 接收离线称重单 / 模拟掉线补交 / 查看称重回执');
  });
}

module.exports = { createApp };
