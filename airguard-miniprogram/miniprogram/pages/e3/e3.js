// ============================================================
// AirGuard E3 巡检协同页 · pages/e3/e3.js（纯渲染层）
// 业务状态（判级 / D5 双判定 / D3 事件状态机）由 utils/e3store.js 共享状态机
// 维护：app.js 在全局 MQTT 连接上注册一次，页面开不开都持续更新，
// 因此页面退出再进入不清零、页面打开前到达的报文也不会丢。
// 本页只做：订阅状态机变化 + 渲染 + 按钮交互（发布跨端指令）。
// 跨端指令：切换重点关注区域 → airguard/e3/focus；
//          标记处理中 → airguard/{zone}/action（复用现有干预协议）；
//          标记已恢复 → airguard/e3/event。
// ============================================================

const e3store = require('../../utils/e3store.js');
const ZONES = e3store.ZONES;
const ZONE_IDS = e3store.ZONE_IDS;
const OFFLINE_MS = e3store.OFFLINE_MS;

function p2(n) { return (n < 10 ? '0' : '') + n; }

function fmtClock(d) {
  return p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds());
}

// 指令确认三级状态展示（任务书消息确认回执）
const ACK_TEXT = {
  sent: '✅已发送',
  received: '📩已接收',
  executed: '🟢已执行',
  timeout: '⚠等待确认超时，请检查连接',
  failed: '❌未发送（MQTT 未连接）',
};
const ACK_CLS = { sent: 'wait', received: 'recv', executed: 'ok', timeout: 'err', failed: 'err' };

Page({
  data: {
    connText: '未连接',
    connClass: '', // '' | 'ok' | 'err'
    selected: 'zone-w',
    zones: ZONE_IDS.map(function (z) { return { zoneid: z, zoneName: ZONES[z] }; }),
    zoneBrief: [], // 三区最新状态条（每条报文都有可见反应，点击即切换重点区域）
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
    msgCount: 0,      // 自诊断：状态机累计收到的消息数（页面未打开时也计数）
    lastTopic: '—',   // 自诊断：最近收到的主题
    ackList: [],      // 指令确认状态（已发送 / 已接收 / 已执行 / 超时），多条独立展示
  },

  onLoad: function () {
    const self = this;
    const app = getApp();
    this.client = app.globalData.mqtt; // 全局单例连接（发布指令用）
    this.store = app.globalData.e3store;
    if (!this.store) {
      console.error('[AirGuard][E3] 共享状态机未初始化，页面无法工作');
      return;
    }
    this.st = this.store.state;
    this._seenTimeouts = {}; // 已弹过超时提示的 msgId（每条指令只提示一次）

    // 恢复上次选中区域（不清零）
    if (ZONE_IDS.indexOf(this.st.selected) > -1 && this.st.selected !== this.data.selected) {
      this.setData({ selected: this.st.selected });
    }

    // 状态机变化（新报文/指令）→ 重渲染
    this._onChange = function () { self.renderAll(); };
    this.store.onChange(this._onChange);

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
    if (this.store && this._onChange) this.store.offChange(this._onChange);
    if (this._onConn) app.offConnChange(this._onConn);
  },

  // ---------- 操作按钮 ----------

  // 切换重点关注区域：状态机切换（停止自动跟随）+ 发布指令，Web 监测台 / three-min 3D 同步更新
  onSelectZone: function (e) {
    const z = e.currentTarget.dataset.zone;
    console.log('[AirGuard][E3] 点击区域标签:', z); // 诊断：确认 tap 事件触发
    if (!this.store.selectZone(z)) return;
    // 生成唯一 msgId 追加到指令：三级回执（已发送 / 已接收 / 已执行）
    const msgId = this.store.sendCmd(z, 'focus', '切换重点区域·' + ZONES[z]);
    const ok = this.publish('airguard/e3/focus', JSON.stringify({ zoneId: z, msgId: msgId, time: this.store.nowStr() }));
    if (!ok) this.store.markFailed(msgId);
    wx.showToast({ title: ok ? '已切换：' + ZONES[z] : '已切换：' + ZONES[z] + '（未同步）', icon: 'none' });
  },

  // 恢复规则判定：本端恢复自动跟随最新报文 + 发布指令清除 Web/3D 人工指定
  onClearFocus: function () {
    console.log('[AirGuard][E3] 点击恢复规则判定');
    this.store.clearFocus();
    const msgId = this.store.sendCmd('', 'focus', '恢复规则判定');
    const ok = this.publish('airguard/e3/focus', JSON.stringify({ zoneId: '', msgId: msgId, time: this.store.nowStr() }));
    if (!ok) this.store.markFailed(msgId);
    wx.showToast({ title: ok ? '已恢复规则判定' : 'MQTT 未连接', icon: 'none' });
  },

  // 标记处理中：复用现有干预协议广播，Web / 3D 同步进入 HANDLING
  onMarkHandling: function () {
    console.log('[AirGuard][E3] 点击标记处理中');
    const z = this.data.selected;
    if (!this.store.markHandling(z, '小程序巡检标记处理中')) {
      wx.showToast({ title: '当前无 OPEN 待处理事件', icon: 'none' });
      return;
    }
    const msgId = this.store.sendCmd(z, 'action', '标记处理中·' + ZONES[z]);
    const ok = this.publish('airguard/' + z + '/action', JSON.stringify({
      zoneId: z, action: '小程序巡检标记处理中', msgId: msgId, time: this.store.nowStr(),
    }));
    if (!ok) this.store.markFailed(msgId);
    wx.showToast({ title: '已标记处理中', icon: 'none' });
  },

  // 标记已恢复：发布 E3 事件消息，Web / 3D 同步归档事件
  onMarkRecovered: function () {
    console.log('[AirGuard][E3] 点击标记已恢复');
    const z = this.data.selected;
    if (!this.store.markRecovered(z)) {
      wx.showToast({ title: '当前无处理中事件', icon: 'none' });
      return;
    }
    const msgId = this.store.sendCmd(z, 'event', '标记已恢复·' + ZONES[z]);
    const ok = this.publish('airguard/e3/event', JSON.stringify({
      zoneId: z, op: 'recovered', note: '小程序巡检确认', msgId: msgId, time: this.store.nowStr(),
    }));
    if (!ok) this.store.markFailed(msgId);
    wx.showToast({ title: '已标记恢复', icon: 'none' });
  },

  publish: function (topic, payload) {
    if (!this.client || !this.client.connected) {
      wx.showToast({ title: 'MQTT 未连接，无法发布', icon: 'none' });
      return false;
    }
    this.client.publish(topic, payload);
    return true;
  },

  // 刷新：同步连接状态 + 从共享状态机全量重渲染；MQTT 断开时手动强制重连
  onRefresh: function () {
    const app = getApp();
    this.renderAll();
    this._onConn();
    const mqtt = app.globalData.mqtt;
    if (mqtt && !mqtt.connected) {
      mqtt.forceReconnect();
      wx.showToast({ title: '已刷新，正在重连…', icon: 'none' });
    } else {
      wx.showToast({ title: '已刷新', icon: 'none' });
    }
  },

  // 清空：共享状态机恢复初始（等效小程序重启；新报文到达会自动重新填充）
  onClear: function () {
    const self = this;
    wx.showModal({
      title: '清空页面',
      content: '确认清空巡检协同页面数据？新报文到达会自动重新填充。',
      confirmText: '清空',
      confirmColor: '#dc2626',
      success: function (res) {
        if (!res.confirm) return;
        self.store.reset();
        self._seenTimeouts = {};
        self.renderAll();
        wx.showToast({ title: '已清空', icon: 'none' });
      },
    });
  },

  // ---------- 渲染（只读共享状态机，全部状态在 st 上） ----------

  renderAll: function () {
    const st = this.st;
    const z = st.selected;
    const d = st.zoneState[z];
    const s = st.d5State[z];
    const ev = st.d3Events[z];
    const online = !!(st.lastSeen[z] && (Date.now() - st.lastSeen[z].getTime()) <= OFFLINE_MS);

    const focus = {
      zoneid: z,
      zoneName: ZONES[z],
      hasData: !!d,
      pm25: d ? d.pm25 : '--',
      co2: d ? d.co2 : '--',
      crowdText: d ? d.crowdText : '--',
      crowdLevel: d ? d.crowdLevel : '--',
      time: d ? d.time : '--',
      statusText: d ? d.statusText : '等待数据',
      accent: d ? d.accent : '#9ca3af',
      ruleText: s.rule === '环境异常' ? '异常' : (s.rule === '—' ? '—' : '正常'),
      mlText: s.ml === '数据积累中'
        ? '数据积累中(' + s.pm25Hist.length + '/6)'
        : (s.ml === '与历史明显不同' ? 'ML异常' : 'ML常态'),
      mismatch: !!s.mismatch,
      online: online,
      lastSeen: st.lastSeen[z] ? fmtClock(st.lastSeen[z]) : '—',
      eventState: ev ? ev.state : null,
      eventDesc: ev
        ? (ev.state === 'OPEN' ? 'OPEN 待处理' : 'HANDLING 处理中 · ' + (ev.action || '—'))
        : '无事件',
    };

    // 三区最新状态条：三个区域同屏展示，每条报文都有可见反应
    const zoneBrief = ZONE_IDS.map(function (id) {
      const b = st.zoneState[id];
      return {
        zoneid: id,
        zoneName: ZONES[id],
        pm25: b ? b.pm25 : '--',
        co2: b ? b.co2 : '--',
        crowdText: b ? b.crowdText : '--',
        statusText: b ? b.statusText : '等待数据',
        accent: b ? b.accent : '#9ca3af',
      };
    });

    // 极简事件列表：活跃事件（三区）+ 最近已恢复（最多 5 条）
    const items = [];
    ZONE_IDS.forEach(function (id) {
      const e = st.d3Events[id];
      if (e) {
        items.push({
          key: 'ev-' + id,
          chip: 'D3', cls: 'd3',
          text: ZONES[id] + '：' + (e.state === 'OPEN' ? 'OPEN 待处理' : 'HANDLING 处理中 · ' + (e.action || '—')) + ' · ' + e.desc,
        });
      }
    });
    st.d3History.slice(-5).reverse().forEach(function (e, i) {
      items.push({
        key: 'his-' + i,
        chip: '恢复', cls: 'ok',
        text: ZONES[e.zoneid] + '：RECOVERED 已恢复 · ' + e.result,
      });
    });

    const onlineCount = ZONE_IDS.filter(function (id) {
      return st.lastSeen[id] && (Date.now() - st.lastSeen[id].getTime()) <= OFFLINE_MS;
    }).length;

    // 指令确认状态：最近 5 条，各条独立展示三级回执状态
    const ackList = st.cmdLog.slice(-5).reverse().map(function (c) {
      return {
        msgId: c.msgId,
        desc: c.time + ' · ' + c.desc,
        statusText: ACK_TEXT[c.status] || c.status,
        cls: ACK_CLS[c.status] || 'wait',
      };
    });

    // 新出现的超时指令弹一次提示
    const self = this;
    const newTimeouts = st.cmdLog.filter(function (c) {
      return c.status === 'timeout' && !self._seenTimeouts[c.msgId];
    });
    if (newTimeouts.length > 0) {
      newTimeouts.forEach(function (c) { self._seenTimeouts[c.msgId] = true; });
      wx.showToast({ title: '⚠ 指令等待确认超时，请检查连接', icon: 'none' });
    }

    this.setData({
      selected: z,
      focus: focus,
      zoneBrief: zoneBrief,
      events: items.slice(0, 5),
      onlineText: '在线 ' + onlineCount + '/3',
      msgCount: st.msgCount,
      lastTopic: st.lastTopic,
      ackList: ackList,
    });
  },
});
