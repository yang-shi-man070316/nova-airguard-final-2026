// ============================================================
// AirGuard 环境监测小程序 · pages/index/index.js
// MQTT 连接由 app.js 全局单例提供（全小程序共享 1 个 WebSocket，
// 避免超出微信「同时最多 2 个 socket」限制），页面只注册消息处理器。
// ============================================================

const TOPIC_SUB = 'airguard/+/env';

// 状态 → 强调色（标签底色 / 卡片左边框）
const ACCENT_COLORS = {
  green: '#22c55e',
  orange: '#f59e0b',
  red: '#ef4444',
  purple: '#9c27b0', // 通风不足风险（与全端统一判级规则一致）
  gray: '#9ca3af',
};

Page({
  data: {
    connText: '未连接',
    connClass: '', // '' | 'ok' | 'err'
    topicText: TOPIC_SUB,
    onlineText: '在线区域 0/3',
    conclusionText: '等待采集数据，暂无现场感知结论',
    conclusionClass: 'wait',
    conclusionIcon: '⏳',
    zoneList: [
      { zoneid: 'zone-n', zoneName: '宿舍区', pm25: '--', co2: '--', crowdLevel: null, crowdText: '--', time: '--', statusText: '等待数据', accentColor: ACCENT_COLORS.gray },
      { zoneid: 'zone-s', zoneName: '教学区', pm25: '--', co2: '--', crowdLevel: null, crowdText: '--', time: '--', statusText: '等待数据', accentColor: ACCENT_COLORS.gray },
      { zoneid: 'zone-w', zoneName: '食堂区', pm25: '--', co2: '--', crowdLevel: null, crowdText: '--', time: '--', statusText: '等待数据', accentColor: ACCENT_COLORS.gray },
    ],
  },

  onLoad: function () {
    const self = this;
    const app = getApp();
    this.lastAlert = {}; // 告警去重：同一区域同一状态只弹一次
    this.visible = true;
    this.client = app.globalData.mqtt; // 全局单例连接

    // 消息处理器：页面在导航栈中保持存活期间持续接收（数据不落后），onUnload 时注销
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
  },

  onShow: function () { this.visible = true; },
  onHide: function () { this.visible = false; },

  onUnload: function () {
    const app = getApp();
    if (this.client && this._onMsg) this.client.off('message', this._onMsg);
    if (this._onConn) app.offConnChange(this._onConn);
  },

  // E3 巡检协同页入口
  goE3: function () {
    wx.navigateTo({ url: '/pages/e3/e3' });
  },

  // 处理单条环境报文：{"zoneId":"zone-n","pm25":160,"co2":920,"crowdLevel":3,"time":"..."}
  handleMsg: function (topic, payload) {
    if (topic.indexOf('/env') === -1) return; // 共享连接上还有其他主题，只处理环境报文
    let msg;
    try {
      msg = JSON.parse(payload);
    } catch (e) {
      console.error('[AirGuard] 报文解析失败:', e, payload);
      return;
    }
    const zoneid = msg.zoneId || msg.zoneid; // 统一契约：zoneId（大写 I），兼容小写 zoneid
    if (['zone-n', 'zone-s', 'zone-w'].indexOf(zoneid) < 0) {
      console.warn('[AirGuard] 未知区域消息，已忽略:', topic);
      return;
    }
    const pm25 = Number(msg.pm25);
    const co2 = Number(msg.co2);
    const crowdLevel = Number(msg.crowdLevel);

    // 状态判定（与全端统一判级规则一致，仅用 pm25 / co2）：
    // pm25>150 重度污染；pm25>75 轻度污染；co2≥1500 通风不足风险；其余 正常
    let statusText = '正常', tagClass = 'green';
    if (pm25 > 150) { statusText = '重度污染'; tagClass = 'red'; }
    else if (pm25 > 75) { statusText = '轻度污染'; tagClass = 'orange'; }
    else if (co2 >= 1500) { statusText = '通风不足风险'; tagClass = 'purple'; }

    // crowdLevel 映射（与全端统一）：0稀疏 1正常 2拥挤 3严重拥挤
    let crowdText = '--';
    if (crowdLevel === 0) crowdText = '稀疏';
    else if (crowdLevel === 1) crowdText = '正常';
    else if (crowdLevel === 2) crowdText = '拥挤';
    else if (crowdLevel === 3) crowdText = '严重拥挤';

    // 只更新对应区域卡片，绝不写入其他区域
    const zoneList = this.data.zoneList.map(function (item) {
      if (item.zoneid === zoneid) {
        return Object.assign({}, item, {
          pm25: msg.pm25,
          co2: msg.co2,
          crowdLevel: crowdLevel,
          crowdText: crowdText,
          time: msg.time,
          statusText: statusText,
          accentColor: ACCENT_COLORS[tagClass],
        });
      }
      return item;
    });
    this.setData({ zoneList: zoneList });
    this.updateStats();

    // 告警：重度污染或人流严重拥挤时弹出 wx.showModal（同一状态去重；页面隐藏时不弹）
    const alertKey = statusText + '|' + crowdLevel;
    if ((statusText === '重度污染' || crowdLevel === 3) &&
        this.lastAlert[zoneid] !== alertKey && this.visible !== false) {
      this.lastAlert[zoneid] = alertKey;
      wx.showModal({
        title: '告警提醒',
        content: zoneid + ' 出现异常：' + statusText + (crowdLevel === 3 ? '，人流严重拥挤' : ''),
        showCancel: false,
      });
    }
  },

  // 汇总三区域最新状态：在线区域计数 + 一句话感知结论
  updateStats: function () {
    const list = this.data.zoneList;
    const online = list.filter(function (i) { return i.statusText !== '等待数据'; });

    let conclusionText = '等待采集数据，暂无现场感知结论';
    let conclusionClass = 'wait';
    let conclusionIcon = '⏳';

    if (online.length > 0) {
      const names = function (arr) {
        return arr.map(function (i) { return i.zoneName; }).join('、');
      };
      const heavy = list.filter(function (i) { return i.statusText === '重度污染'; });
      const light = list.filter(function (i) { return i.statusText === '轻度污染'; });
      const vent = list.filter(function (i) { return i.statusText === '通风不足风险'; });
      const crowd3 = list.filter(function (i) { return i.crowdLevel === 3; });
      const crowd2 = list.filter(function (i) { return i.crowdLevel === 2; });

      if (heavy.length) {
        conclusionText = '当前' + names(heavy) + '出现重度污染，建议减少户外活动并开启空气净化。';
        conclusionClass = 'red'; conclusionIcon = '🚨';
      } else if (light.length) {
        conclusionText = names(light) + '轻度污染，敏感人群建议减少长时间停留。';
        conclusionClass = 'orange'; conclusionIcon = '⚠️';
      } else if (vent.length) {
        conclusionText = names(vent) + '通风不足，建议开窗或开启新风系统。';
        conclusionClass = 'purple'; conclusionIcon = '💨';
      } else if (crowd3.length) {
        conclusionText = names(crowd3) + '人流严重拥挤，建议错峰前往。';
        conclusionClass = 'red'; conclusionIcon = '🚨';
      } else if (crowd2.length) {
        conclusionText = names(crowd2) + '人流拥挤，注意保持间距。';
        conclusionClass = 'orange'; conclusionIcon = '⚠️';
      } else {
        conclusionText = '校园空气质量整体良好，各区域状态正常。';
        conclusionClass = 'green'; conclusionIcon = '✅';
      }
    }

    this.setData({
      onlineText: '在线区域 ' + online.length + '/3',
      conclusionText: conclusionText,
      conclusionClass: conclusionClass,
      conclusionIcon: conclusionIcon,
    });
  },
});
