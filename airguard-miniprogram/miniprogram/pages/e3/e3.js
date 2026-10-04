// ============================================================
// AirGuard E3 巡检协同页 · pages/e3/e3.js
// 与 Web 监测台 / three-min.html 订阅同一个 MQTT Broker、同一套数据源，
// 业务状态（判级 / D5 双判定 / D3 事件状态机）与 Web 端同一套规则生成。
// 跨端指令：切换重点关注区域 → airguard/e3/focus；
//          标记处理中 → airguard/{zone}/action（复用现有干预协议）；
//          标记已恢复 → airguard/e3/event。
// ============================================================

// MQTT 连接由 app.js 全局单例提供（共享 1 个 WebSocket），本页只注册消息处理器
const ZONES = { 'zone-n': '宿舍区', 'zone-s': '教学区', 'zone-w': '食堂区' };
const ZONE_IDS = Object.keys(ZONES);
const OFFLINE_MS = 120000;   // 与 Web/3D 一致：2 分钟无新数据判离线
const D5_MIN = 6;            // D5 ML 判定所需最少历史样本数
const D5_MAX = 60;           // 历史数组上限
const D5_MULT = 2;           // 标准差倍数（与 Web 默认一致）

const STATUS_ACCENT = {
  '正常': '#22c55e',
  '轻度污染': '#f59e0b',
  '重度污染': '#ef4444',
  '通风不足风险': '#9c27b0',
};
const CROWD_TEXT = { 0: '稀疏', 1: '正常', 2: '拥挤', 3: '严重拥挤' };

// 统一判级规则（与全端一致，仅用 pm25/co2）
function calcStatus(pm25, co2) {
  if (pm25 > 150) return '重度污染';
  if (pm25 > 75) return '轻度污染';
  if (co2 >= 1500) return '通风不足风险';
  return '正常';
}

// 样本均值与样本标准差（与 Web 端 d5MeanStd 同公式）
function meanStd(arr) {
  const n = arr.length;
  let sum = 0, i;
  for (i = 0; i < n; i++) sum += arr[i];
  const mean = sum / n;
  let sq = 0;
  for (i = 0; i < n; i++) sq += (arr[i] - mean) * (arr[i] - mean);
  return { mean: mean, std: Math.sqrt(sq / (n - 1)) };
}

function p2(n) { return (n < 10 ? '0' : '') + n; }

function nowStr() {
  const d = new Date();
  return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' +
    p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds());
}

function fmtClock(d) {
  return p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds());
}

Page({
  data: {
    connText: '未连接',
    connClass: '', // '' | 'ok' | 'err'
    selected: 'zone-w',
    zones: ZONE_IDS.map(function (z) { return { zoneid: z, zoneName: ZONES[z] }; }),
    focus: {
      zoneid: 'zone-w', zoneName: '食堂区',
      pm25: '--', co2: '--', crowdText: '--', crowdLevel: '--', time: '--',
      statusText: '等待数据', accent: '#9ca3af',
      ruleText: '—', mlText: '—', mismatch: false,
      online: false, lastSeen: '—',
      eventState: null, eventDesc: '无事件',
    },
    events: [],
    onlineText: '在线 0/3',
  },

  onLoad: function () {
    const self = this;
    const app = getApp();
    this.zoneState = {}; // zone → {pm25,co2,crowdLevel,crowdText,time,statusText,accent}
    this.d5State = {};   // zone → {pm25Hist,co2Hist,rule,ml,mismatch}
    this.d3Events = {};  // zone → {state:'OPEN'|'HANDLING', desc, action, normalStreak}
    this.d3History = []; // 已恢复事件
    this.lastSeen = {};  // zone → Date
    ZONE_IDS.forEach(function (z) {
      self.zoneState[z] = null;
      self.d5State[z] = { pm25Hist: [], co2Hist: [], rule: '—', ml: '—', mismatch: false };
      self.d3Events[z] = null;
      self.lastSeen[z] = null;
    });

    this.client = app.globalData.mqtt; // 全局单例连接（共享 1 个 WebSocket）

    // 消息处理器（onUnload 时注销；连接与订阅由 app.js 统一管理）
    this._onMsg = function (topic, payload) {
      self.handleMsg(topic, payload);
    };
    this.client.on('message', this._onMsg);

    // 连接状态跟随全局单例
    this._onConn = function () {
      const st = app.globalData.connState;
      self.setData({
        connText: app.globalData.connText,
        connClass: st === 'on' ? 'ok' : (st === 'off' ? 'err' : ''),
      });
    };
    app.onConnChange(this._onConn);
    this._onConn();

    // 每秒巡检：节点在线/离线与 lastSeen（与 Web D4 阈值一致）
    this.timer = setInterval(function () { self.renderAll(); }, 1000);
    this.renderAll();
  },

  onUnload: function () {
    const app = getApp();
    clearInterval(this.timer);
    if (this.client && this._onMsg) this.client.off('message', this._onMsg);
    if (this._onConn) app.offConnChange(this._onConn);
  },

  // ---------- 消息分流 ----------
  handleMsg: function (topic, payload) {
    if (topic.indexOf('airguard/e3/') === 0) { this.handleE3(topic, payload); return; }
    if (topic.indexOf('/action') > -1) { this.handleAction(topic, payload); return; }
    this.handleEnv(topic, payload);
  },

  // 环境报文：更新区域数据 + D5 双判定 + D3 状态机（与 Web 同一套规则）
  handleEnv: function (topic, payload) {
    let msg;
    try { msg = JSON.parse(payload); } catch (e) { return; }
    const z = msg.zoneId || msg.zoneid;
    if (ZONE_IDS.indexOf(z) < 0) return;
    const pm25 = Number(msg.pm25);
    const co2 = Number(msg.co2);
    const crowd = Number(msg.crowdLevel);
    const statusText = calcStatus(pm25, co2);
    this.lastSeen[z] = new Date();
    this.zoneState[z] = {
      pm25: pm25, co2: co2, crowdLevel: crowd,
      crowdText: CROWD_TEXT[crowd] !== undefined ? CROWD_TEXT[crowd] : '--',
      time: msg.time, statusText: statusText, accent: STATUS_ACCENT[statusText] || '#9ca3af',
    };

    // ---- D5 双判定（固定规则 + ML 统计动态阈值，与 Web 端一致）----
    const s = this.d5State[z];
    s.pm25Hist.push(pm25);
    s.co2Hist.push(co2);
    if (s.pm25Hist.length > D5_MAX) { s.pm25Hist.shift(); s.co2Hist.shift(); }
    s.rule = (pm25 > 75 || co2 > 1000) ? '环境异常' : '正常';
    if (s.pm25Hist.length >= D5_MIN) {
      const mp = meanStd(s.pm25Hist.slice(0, -1)); // 统计用历史（不含当前值）
      const mc = meanStd(s.co2Hist.slice(0, -1));
      s.ml = (pm25 > mp.mean + D5_MULT * mp.std || co2 > mc.mean + D5_MULT * mc.std)
        ? '与历史明显不同' : '符合历史常态';
      s.mismatch = (s.rule === '环境异常') !== (s.ml === '与历史明显不同');
    } else {
      s.ml = '数据积累中';
      s.mismatch = false;
    }

    // ---- D3 事件状态机（与 Web 端同一套转移规则）----
    const ev = this.d3Events[z];
    if (statusText !== '正常') {
      if (!ev) {
        this.d3Events[z] = { state: 'OPEN', desc: statusText, action: null, normalStreak: 0 };
      } else {
        ev.desc = statusText;
      }
    } else if (ev && ev.state === 'HANDLING') {
      ev.normalStreak += 1;
      if (ev.normalStreak >= 2) this.recoverLocal(z, '连续正常报文自动恢复');
    }
    this.renderAll();
  },

  // 干预指令（本端或 Web/3D 任何一端发布）：OPEN → HANDLING
  handleAction: function (topic, payload) {
    let msg;
    try { msg = JSON.parse(payload); } catch (e) { return; }
    const z = msg.zoneId || (topic.split('/')[1] || '');
    if (ZONE_IDS.indexOf(z) < 0) return;
    const ev = this.d3Events[z];
    if (ev && ev.state === 'OPEN') {
      ev.state = 'HANDLING';
      ev.action = msg.action || '干预';
      ev.normalStreak = 0;
      this.renderAll();
    }
  },

  // E3 跨端指令：重点关注区域 / 事件已恢复
  handleE3: function (topic, payload) {
    let msg;
    try { msg = JSON.parse(payload); } catch (e) { return; }
    if (topic.indexOf('focus') > -1) {
      const z = msg.zoneId;
      if (z === '' || z === 'clear') return; // 恢复规则判定，小程序端本身即规则+人工混合，无需处理
      if (ZONE_IDS.indexOf(z) < 0) return;
      if (this.data.selected !== z) this.setData({ selected: z });
      this.renderAll();
    } else if (topic.indexOf('event') > -1 && msg.op === 'recovered') {
      const z = msg.zoneId;
      if (ZONE_IDS.indexOf(z) < 0) return;
      this.recoverLocal(z, '小程序巡检端标记已恢复');
      this.renderAll();
    }
  },

  // 本地事件恢复：活跃事件 → 历史（与 Web 端 RECOVERED 归档一致）
  recoverLocal: function (z, result) {
    const ev = this.d3Events[z];
    if (!ev) return;
    this.d3History.push({ zoneid: z, desc: ev.desc, action: ev.action, result: result });
    if (this.d3History.length > 20) this.d3History.shift();
    this.d3Events[z] = null;
  },

  // ---------- 操作按钮 ----------

  // 切换重点关注区域：本页切换 + 发布指令，Web 监测台 / three-min 3D 同步更新
  onSelectZone: function (e) {
    const z = e.currentTarget.dataset.zone;
    if (ZONE_IDS.indexOf(z) < 0) return;
    this.setData({ selected: z });
    this.publish('airguard/e3/focus', JSON.stringify({ zoneId: z, time: nowStr() }));
    this.renderAll();
  },

  // 恢复规则判定（清除人工指定）
  onClearFocus: function () {
    this.publish('airguard/e3/focus', JSON.stringify({ zoneId: '', time: nowStr() }));
  },

  // 标记处理中：复用现有干预协议广播，Web / 3D 同步进入 HANDLING
  onMarkHandling: function () {
    const z = this.data.selected;
    const ev = this.d3Events[z];
    if (!ev || ev.state !== 'OPEN') return;
    ev.state = 'HANDLING';
    ev.action = '小程序巡检标记处理中';
    ev.normalStreak = 0;
    this.publish('airguard/' + z + '/action', JSON.stringify({
      zoneId: z, action: '小程序巡检标记处理中', time: nowStr(),
    }));
    this.renderAll();
  },

  // 标记已恢复：发布 E3 事件消息，Web / 3D 同步归档事件
  onMarkRecovered: function () {
    const z = this.data.selected;
    const ev = this.d3Events[z];
    if (!ev || ev.state !== 'HANDLING') return;
    this.recoverLocal(z, '小程序巡检端标记已恢复');
    this.publish('airguard/e3/event', JSON.stringify({
      zoneId: z, op: 'recovered', note: '小程序巡检确认', time: nowStr(),
    }));
    this.renderAll();
  },

  publish: function (topic, payload) {
    if (!this.client || !this.client.connected) {
      wx.showToast({ title: 'MQTT 未连接，无法发布', icon: 'none' });
      return;
    }
    this.client.publish(topic, payload);
  },

  // ---------- 渲染 ----------

  renderAll: function () {
    const z = this.data.selected;
    const d = this.zoneState[z];
    const s = this.d5State[z];
    const ev = this.d3Events[z];
    const online = !!(this.lastSeen[z] && (Date.now() - this.lastSeen[z].getTime()) <= OFFLINE_MS);

    const focus = {
      zoneid: z,
      zoneName: ZONES[z],
      pm25: d ? d.pm25 : '--',
      co2: d ? d.co2 : '--',
      crowdText: d ? d.crowdText : '--',
      crowdLevel: d ? d.crowdLevel : '--',
      time: d ? d.time : '--',
      statusText: d ? d.statusText : '等待数据',
      accent: d ? d.accent : '#9ca3af',
      ruleText: s.rule === '环境异常' ? '异常' : (s.rule === '—' ? '—' : '正常'),
      mlText: s.ml === '数据积累中'
        ? '数据积累中(' + s.pm25Hist.length + '/' + D5_MIN + ')'
        : (s.ml === '与历史明显不同' ? 'ML异常' : 'ML常态'),
      mismatch: !!s.mismatch,
      online: online,
      lastSeen: this.lastSeen[z] ? fmtClock(this.lastSeen[z]) : '—',
      eventState: ev ? ev.state : null,
      eventDesc: ev
        ? (ev.state === 'OPEN' ? 'OPEN 待处理' : 'HANDLING 处理中 · ' + (ev.action || '—'))
        : '无事件',
    };

    // 极简事件列表：活跃事件（三区）+ 最近已恢复（最多 5 条）
    const items = [];
    const self = this;
    ZONE_IDS.forEach(function (id) {
      const e = self.d3Events[id];
      if (e) {
        items.push({
          key: 'ev-' + id,
          chip: 'D3', cls: 'd3',
          text: ZONES[id] + '：' + (e.state === 'OPEN' ? 'OPEN 待处理' : 'HANDLING 处理中 · ' + (e.action || '—')) + ' · ' + e.desc,
        });
      }
    });
    this.d3History.slice(-5).reverse().forEach(function (e, i) {
      items.push({
        key: 'his-' + i,
        chip: '恢复', cls: 'ok',
        text: ZONES[e.zoneid] + '：RECOVERED 已恢复 · ' + e.result,
      });
    });

    const onlineCount = ZONE_IDS.filter(function (id) {
      return self.lastSeen[id] && (Date.now() - self.lastSeen[id].getTime()) <= OFFLINE_MS;
    }).length;

    this.setData({
      focus: focus,
      events: items.slice(0, 5),
      onlineText: '在线 ' + onlineCount + '/3',
    });
  },
});
