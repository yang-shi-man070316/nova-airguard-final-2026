// ============================================================
// AirGuard · MQTT 3.1.1 简易客户端（微信小程序原生 WebSocket 实现）
// 无第三方 mqtt 库，规避 WebSocket 构造函数兼容问题。
// 与 pages/index 内联实现同一套协议，新增 publish（QoS0）供 E3 跨端指令发布。
// ============================================================

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

// PUBLISH 报文（QoS 0，不保留）
function buildPublishPacket(topic, payload) {
  const body = mqttString(topic).concat(utf8Encode(payload));
  return [0x30].concat(encodeRemainingLength(body.length), body);
}

// PINGREQ 报文（固定 0xC0 0x00）
const PINGREQ_PACKET = [0xC0, 0x00];

// ---------- 简易 MQTT 客户端（微信原生 WebSocket 实现） ----------

class MqttClient {
  constructor(url) {
    this.url = url;
    this.clientId = 'airguard-e3-' + Math.random().toString(16).slice(2, 10);
    this.handlers = {};
    this.connected = false;
    this.ended = false;
    this.packetId = 1;
    this.subscribedTopics = []; // 已订阅主题清单：CONNACK 后统一发送，断线重连后自动重新订阅
    this.recvBuf = new Uint8Array(0);
    this.task = null;
    this.pingTimer = null;
    this.reconnectTimer = null;
  }

  // 简单事件模型
  on(event, fn) { (this.handlers[event] = this.handlers[event] || []).push(fn); }
  off(event, fn) {
    const fns = this.handlers[event] || [];
    const idx = fns.indexOf(fn);
    if (idx > -1) fns.splice(idx, 1);
  }
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
        // 连接失败（如超出微信最多 2 个 socket 限制）：task 无效置空，
        // 避免后续 close 报 closeSocket:fail task not found；5 秒后重试
        self.task = null;
        self.emit('error', new Error((err && err.errMsg) || 'connectSocket fail'));
        if (!self.ended) {
          clearTimeout(self.reconnectTimer);
          self.reconnectTimer = setTimeout(function () { self.connect(); }, 5000);
        }
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
      // 未主动结束时 5 秒后自动重连（Broker 短暂断连恢复后自动同步最新状态）
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

  // 订阅主题：记录到清单；已连接立即发送，未连接等待 CONNACK 后统一发送。
  // 关键：socket 断开自动重连后，CONNACK 会按清单重新订阅
  // （clean session 模式下 broker 不保留订阅，不重发会收不到任何消息）
  subscribe(topic) {
    if (this.subscribedTopics.indexOf(topic) === -1) this.subscribedTopics.push(topic);
    if (this.connected) this.sendSubscribe(topic);
  }

  sendSubscribe(topic) {
    if (!this.task || !this.connected) return;
    const pkt = buildSubscribePacket(this.packetId++, topic);
    this.task.send({ data: new Uint8Array(pkt).buffer });
  }

  // 发布消息（QoS 0）：E3 跨端指令（切换重点区域 / 事件状态）经此广播
  publish(topic, payload) {
    if (!this.connected) return false;
    const pkt = buildPublishPacket(topic, payload);
    this.task.send({ data: new Uint8Array(pkt).buffer });
    return true;
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
      // CONNACK：握手完成（含断线重连后的新握手），重新发送全部已订阅主题
      const self = this;
      this.connected = true;
      this.startPing();
      const topics = this.subscribedTopics.slice();
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

module.exports = MqttClient;
