// ============================================================
// AirGuard 环境监测小程序 · pages/index/index.js
// 纯 JS 实现：内置简易 MQTT 3.1.1 客户端（基于微信原生 wx.connectSocket），
// 不依赖任何第三方 mqtt 库，规避 WebSocket 构造函数问题。
// ============================================================

const MQTT_URL = 'ws://127.0.0.1:8083/mqtt'; // 本地联调地址；真机请改为局域网 IP 或 wss
const TOPIC_SUB = 'airguard/+/env';

// ---------- 字节工具 ----------

// 变长剩余长度编码（MQTT 规范）
function encodeRemainingLength(len) {
  const out = [];
  do {
    let digit = len % 128;
    len = Math.floor(len / 128);
    if (len > 0) digit |= 0x80;
    out.push(digit);
  } while (len > 0);
  return out;
}

// UTF-8 字符串 → 字节数组（小程序无 TextEncoder，手写编码）
function utf8Encode(str) {
  const bytes = [];
  for (let i = 0; i < str.length; i++) {
    const code = str.codePointAt(i);
    if (code > 0xFFFF) i++; // 跳过代理对低位
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xC0 | (code >> 6), 0x80 | (code & 0x3F));
    else if (code < 0x10000) bytes.push(0xE0 | (code >> 12), 0x80 | ((code >> 6) & 0x3F), 0x80 | (code & 0x3F));
    else bytes.push(0xF0 | (code >> 18), 0x80 | ((code >> 12) & 0x3F), 0x80 | ((code >> 6) & 0x3F), 0x80 | (code & 0x3F));
  }
  return bytes;
}

// UTF-8 字节流 → 字符串（小程序无 TextDecoder，手写解码）
function utf8Decode(bytes, start, end) {
  let out = '';
  let i = start;
  while (i < end) {
    const b = bytes[i];
    let code, extra;
    if (b < 0x80) { code = b; extra = 0; }
    else if ((b & 0xE0) === 0xC0) { code = b & 0x1F; extra = 1; }
    else if ((b & 0xF0) === 0xE0) { code = b & 0x0F; extra = 2; }
    else { code = b & 0x07; extra = 3; }
    for (let k = 1; k <= extra; k++) code = (code << 6) | (bytes[i + k] & 0x3F);
    i += extra + 1;
    out += String.fromCodePoint(code);
  }
  return out;
}

function concatBytes(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

// MQTT 字符串：2 字节长度前缀 + UTF-8 字节流
function mqttString(str) {
  const bytes = utf8Encode(str);
  return [bytes.length >> 8, bytes.length & 0xFF].concat(bytes);
}

// ---------- MQTT 报文构造 ----------

// CONNECT 报文（MQTT 3.1.1：协议名 MQTT、级别 4、clean session、keepalive 60s）
function buildConnectPacket(clientId) {
  const varHeader = [
    0x00, 0x04, 0x4D, 0x51, 0x54, 0x54, // 协议名 "MQTT"
    0x04,                               // 协议级别 4（3.1.1）
    0x02,                               // 连接标志：clean session
    0x00, 0x3C,                         // keepalive 60 秒
  ];
  const body = varHeader.concat(mqttString(clientId));
  return [0x10].concat(encodeRemainingLength(body.length), body);
}

// SUBSCRIBE 报文（订阅 QoS 0）
function buildSubscribePacket(packetId, topic) {
  const body = [(packetId >> 8) & 0xFF, packetId & 0xFF].concat(mqttString(topic), [0x00]);
  return [0x82].concat(encodeRemainingLength(body.length), body);
}

// PINGREQ 报文（固定 0xC0 0x00）
const PINGREQ_PACKET = [0xC0, 0x00];

// ---------- 简易 MQTT 客户端（微信原生 WebSocket 实现） ----------

class MqttClient {
  constructor(url) {
    this.url = url;
    this.clientId = 'airguard-' + Math.random().toString(16).slice(2, 10);
    this.handlers = {};
    this.connected = false;
    this.ended = false;
    this.packetId = 1;
    this.pendingTopics = []; // CONNACK 之前排队等待订阅的主题
    this.recvBuf = new Uint8Array(0);
    this.task = null;
    this.pingTimer = null;
    this.reconnectTimer = null;
  }

  // 简单事件模型
  on(event, fn) { (this.handlers[event] = this.handlers[event] || []).push(fn); }
  emit(event, a, b) {
    const fns = this.handlers[event] || [];
    for (let i = 0; i < fns.length; i++) fns[i](a, b);
  }

  connect() {
    const self = this;
    this.ended = false;
    this.task = wx.connectSocket({
      url: this.url,
      protocols: ['mqtt'],
      fail: function (err) {
        self.emit('error', new Error((err && err.errMsg) || 'connectSocket fail'));
      },
    });
    this.task.onOpen(function () {
      // WebSocket 建立后发送 MQTT CONNECT 握手报文
      self.task.send({ data: new Uint8Array(buildConnectPacket(self.clientId)).buffer });
    });
    this.task.onMessage(function (res) {
      self.onData(res.data);
    });
    this.task.onClose(function () {
      self.connected = false;
      self.stopPing();
      self.emit('close');
      // 未主动结束时 5 秒后自动重连
      if (!self.ended) {
        clearTimeout(self.reconnectTimer);
        self.reconnectTimer = setTimeout(function () { self.connect(); }, 5000);
      }
    });
    this.task.onError(function (err) {
      self.emit('error', err);
    });
  }

  end() {
    this.ended = true;
    clearTimeout(this.reconnectTimer);
    this.stopPing();
    if (this.task) {
      try { this.task.close({}); } catch (e) { /* 忽略关闭异常 */ }
    }
  }

  // 订阅主题：连接未完成时先排队，CONNACK 后统一发送
  subscribe(topic) {
    if (this.connected) this.sendSubscribe(topic);
    else this.pendingTopics.push(topic);
  }

  sendSubscribe(topic) {
    const pkt = buildSubscribePacket(this.packetId++, topic);
    this.task.send({ data: new Uint8Array(pkt).buffer });
  }

  startPing() {
    const self = this;
    this.stopPing();
    // keepalive 60s，每 30s 发一次 PINGREQ 保活
    this.pingTimer = setInterval(function () {
      if (self.connected) self.task.send({ data: new Uint8Array(PINGREQ_PACKET).buffer });
    }, 30000);
  }

  stopPing() {
    clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  // ---------- 报文接收与解析 ----------

  onData(data) {
    // 统一转成 Uint8Array
    let bytes;
    if (typeof data === 'string') {
      bytes = new Uint8Array(utf8Encode(data));
    } else if (data instanceof ArrayBuffer) {
      bytes = new Uint8Array(data);
    } else {
      bytes = data;
    }
    if (this.recvBuf.length) bytes = concatBytes(this.recvBuf, bytes);

    // 循环解析：固定头 + 变长剩余长度 + 剩余部分
    let offset = 0;
    while (offset + 1 < bytes.length) {
      const type = bytes[offset] >> 4;
      // 读剩余长度（最多 4 字节）
      let rl = 0, mult = 1, pos = offset + 1, ok = false;
      for (let k = 0; k < 4 && pos < bytes.length; k++) {
        const digit = bytes[pos++];
        rl += (digit & 0x7F) * mult;
        if ((digit & 0x80) === 0) { ok = true; break; }
        mult *= 128;
      }
      if (!ok) break; // 剩余长度未收全，等下一包
      const total = pos + rl;
      if (bytes.length < total) break; // 报文未收全，等下一包
      this.handlePacket(type, bytes, pos, total);
      offset = total;
    }
    this.recvBuf = offset < bytes.length ? bytes.subarray(offset) : new Uint8Array(0);
  }

  handlePacket(type, bytes, start, end) {
    if (type === 2) {
      // CONNACK：握手完成，发送排队等待的订阅
      const self = this;
      this.connected = true;
      this.startPing();
      const topics = this.pendingTopics.splice(0);
      topics.forEach(function (t) { self.sendSubscribe(t); });
      this.emit('connect');
    } else if (type === 3) {
      // PUBLISH：解析 topic + payload（订阅为 QoS 0，无报文标识符）
      const tLen = (bytes[start] << 8) | bytes[start + 1];
      const topic = utf8Decode(bytes, start + 2, start + 2 + tLen);
      const payload = utf8Decode(bytes, start + 2 + tLen, end);
      this.emit('message', topic, payload);
    }
    // SUBACK(9) / PINGRESP(13) 无需处理
  }
}

// ---------- 页面逻辑 ----------

Page({
  data: {
    connText: '未连接',
    connClass: '', // '' | 'ok' | 'err'
    zoneList: [
      { zoneid: 'zone-n', zoneName: '宿舍N', pm25: '--', co2: '--', crowdText: '--', time: '--', statusText: '等待数据', tagClass: 'gray' },
      { zoneid: 'zone-s', zoneName: '宿舍S', pm25: '--', co2: '--', crowdText: '--', time: '--', statusText: '等待数据', tagClass: 'gray' },
      { zoneid: 'zone-w', zoneName: '宿舍W', pm25: '--', co2: '--', crowdText: '--', time: '--', statusText: '等待数据', tagClass: 'gray' },
    ],
  },

  onLoad: function () {
    const self = this;
    this.lastAlert = {}; // 告警去重：同一区域同一状态只弹一次
    this.client = new MqttClient(MQTT_URL);

    // MQTT 事件 → 页面连接状态
    this.client.on('connect', function () {
      self.setData({ connText: '已连接 ' + MQTT_URL, connClass: 'ok' });
    });
    this.client.on('close', function () {
      self.setData({ connText: '连接断开，自动重连中…', connClass: 'err' });
    });
    this.client.on('error', function (err) {
      console.error('[AirGuard] MQTT 错误:', err);
      self.setData({ connText: '连接错误，自动重连中…', connClass: 'err' });
    });
    this.client.on('message', function (topic, payload) {
      self.handleMsg(topic, payload);
    });

    this.client.connect();
    this.client.subscribe(TOPIC_SUB); // CONNACK 前会排队，握手完成后自动发送
  },

  onUnload: function () {
    if (this.client) this.client.end();
  },

  // 处理单条环境报文：{"zoneid":"zone-n","pm25":160,"co2":920,"crowdLevel":3,"time":"..."}
  handleMsg: function (topic, payload) {
    let msg;
    try {
      msg = JSON.parse(payload);
    } catch (e) {
      console.error('[AirGuard] 报文解析失败:', e, payload);
      return;
    }
    const zoneid = msg.zoneid; // 报文契约字段为小写 zoneid
    if (['zone-n', 'zone-s', 'zone-w'].indexOf(zoneid) < 0) {
      console.warn('[AirGuard] 未知区域消息，已忽略:', topic);
      return;
    }
    const pm25 = Number(msg.pm25);
    const crowdLevel = Number(msg.crowdLevel);

    // 状态判定：pm25≤75 正常绿色；75<pm25≤150 轻度污染橙色；pm25>150 重度污染红色
    let statusText = '正常', tagClass = 'green';
    if (pm25 > 150) { statusText = '重度污染'; tagClass = 'red'; }
    else if (pm25 > 75) { statusText = '轻度污染'; tagClass = 'orange'; }

    // crowdLevel 映射：0稀疏 1适中 2拥挤 3严重拥挤
    let crowdText = '--';
    if (crowdLevel === 0) crowdText = '稀疏';
    else if (crowdLevel === 1) crowdText = '适中';
    else if (crowdLevel === 2) crowdText = '拥挤';
    else if (crowdLevel === 3) crowdText = '严重拥挤';

    // 只更新对应区域卡片，绝不写入其他区域
    const zoneList = this.data.zoneList.map(function (item) {
      if (item.zoneid === zoneid) {
        return Object.assign({}, item, {
          pm25: msg.pm25,
          co2: msg.co2,
          crowdText: crowdText,
          time: msg.time,
          statusText: statusText,
          tagClass: tagClass,
        });
      }
      return item;
    });
    this.setData({ zoneList: zoneList });

    // 告警：重度污染或人流严重拥挤时弹出 wx.showModal（同一状态去重）
    const alertKey = statusText + '|' + crowdLevel;
    if ((statusText === '重度污染' || crowdLevel === 3) && this.lastAlert[zoneid] !== alertKey) {
      this.lastAlert[zoneid] = alertKey;
      wx.showModal({
        title: '告警提醒',
        content: zoneid + ' 出现异常：' + statusText + (crowdLevel === 3 ? '，人流严重拥挤' : ''),
        showCancel: false,
      });
    }
  },
});
