// ============================================================
// AirGuard E3 巡检协同共享状态机 · utils/e3store.js
// 由 app.js 在全局 MQTT 连接上注册一次消息处理：无论 E3 页面是否打开，
// 区域数据 / D5 双判定 / D3 事件状态机都持续更新，页面只负责渲染。
// 状态挂 app.globalData.e3State：页面退出再进入不清零；
// 未手动选过区域时，选中区域跟随最新报文（每条报文在页面上都有可见反应）。
// ============================================================

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

// ============ E3 消息确认回执（任务书：已发送 / 已接收 / 已执行 三级反馈） ============
const ACK_TOPIC = 'airguard/E3/ack'; // 回执主题：Web / 3D 收到小程序指令后自动发布
const ACK_TIMEOUT_MS = 60000;        // 60 秒未收到回执判超时
const CMD_LOG_MAX = 10;               // 页面上最多展示最近 10 条指令状态

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

function nowStr() {
  const p2 = function (n) { return (n < 10 ? '0' : '') + n; };
  const d = new Date();
  return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' +
    p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds());
}

// 创建（或恢复）全局唯一状态机，并挂到 app.globalData
function create(app) {
  const st = app.globalData.e3State || (app.globalData.e3State = {
    zoneState: {},   // zone → {pm25,co2,crowdLevel,crowdText,time,statusText,accent}
    d5State: {},     // zone → {pm25Hist,co2Hist,rule,ml,mismatch}
    d3Events: {},    // zone → {state:'OPEN'|'HANDLING', desc, action, normalStreak}
    d3History: [],   // 已恢复事件（最多 20 条）
    lastSeen: {},    // zone → Date
    userPicked: false, // 用户是否手动选过区域（未选过时跟随最新报文区域）
    selected: 'zone-w',
    msgCount: 0,     // 自诊断：累计收到消息数（页面未打开时也计数）
    lastTopic: '—',  // 自诊断：最近收到的主题
    cmdLog: [],      // 指令确认记录：{msgId,zoneId,type,desc,time,sendAt,status,ackSource}
  });
  if (!st.cmdLog) st.cmdLog = [];
  ZONE_IDS.forEach(function (z) {
    if (st.zoneState[z] === undefined) st.zoneState[z] = null;
    if (!st.d5State[z]) st.d5State[z] = { pm25Hist: [], co2Hist: [], rule: '—', ml: '—', mismatch: false };
    if (st.d3Events[z] === undefined) st.d3Events[z] = null;
    if (st.lastSeen[z] === undefined) st.lastSeen[z] = null;
  });

  const listeners = [];
  function emit() { for (let i = 0; i < listeners.length; i++) listeners[i](); }

  // 本地事件恢复：活跃事件 → 历史（与 Web 端 RECOVERED 归档一致）
  function recoverLocal(z, result) {
    const ev = st.d3Events[z];
    if (!ev) return;
    st.d3History.push({ zoneid: z, desc: ev.desc, action: ev.action, result: result });
    if (st.d3History.length > 20) st.d3History.shift();
    st.d3Events[z] = null;
  }

  // 环境报文：更新区域数据 + D5 双判定 + D3 状态机（与 Web 同一套规则）
  function handleEnv(topic, payload) {
    let msg;
    try { msg = JSON.parse(payload); } catch (e) {
      console.error('[AirGuard][E3] 环境报文解析失败:', e.message);
      return;
    }
    const z = msg.zoneId || msg.zoneid;
    if (ZONE_IDS.indexOf(z) < 0) return;
    const pm25 = Number(msg.pm25);
    const co2 = Number(msg.co2);
    const crowd = Number(msg.crowdLevel);
    const statusText = calcStatus(pm25, co2);
    st.lastSeen[z] = new Date();
    st.zoneState[z] = {
      pm25: pm25, co2: co2, crowdLevel: crowd,
      crowdText: CROWD_TEXT[crowd] !== undefined ? CROWD_TEXT[crowd] : '--',
      time: msg.time, statusText: statusText, accent: STATUS_ACCENT[statusText] || '#9ca3af',
    };
    console.log('[AirGuard][E3] 环境数据更新:', z, 'pm25=' + pm25, 'co2=' + co2, 'crowd=' + crowd);

    // 未手动选过区域时跟随最新报文区域：每条报文在页面上都有可见反应
    if (!st.userPicked && st.selected !== z) st.selected = z;

    // ---- D5 双判定（固定规则 + ML 统计动态阈值，与 Web 端一致）----
    const s = st.d5State[z];
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
    const ev = st.d3Events[z];
    if (statusText !== '正常') {
      if (!ev) {
        st.d3Events[z] = { state: 'OPEN', desc: statusText, action: null, normalStreak: 0 };
      } else {
        ev.desc = statusText;
      }
    } else if (ev && ev.state === 'HANDLING') {
      ev.normalStreak += 1;
      if (ev.normalStreak >= 2) recoverLocal(z, '连续正常报文自动恢复');
    }
    emit();
  }

  // 干预指令（本端或 Web/3D 任何一端发布）：OPEN → HANDLING
  function handleAction(topic, payload) {
    let msg;
    try { msg = JSON.parse(payload); } catch (e) {
      console.error('[AirGuard][E3] 干预指令解析失败:', e.message);
      return;
    }
    const z = msg.zoneId || (topic.split('/')[1] || '');
    if (ZONE_IDS.indexOf(z) < 0) return;
    const ev = st.d3Events[z];
    if (ev && ev.state === 'OPEN') {
      ev.state = 'HANDLING';
      ev.action = msg.action || '干预';
      ev.normalStreak = 0;
      emit();
    }
  }

  // E3 跨端指令：重点关注区域 / 事件已恢复
  function handleE3(topic, payload) {
    let msg;
    try { msg = JSON.parse(payload); } catch (e) {
      console.error('[AirGuard][E3] E3指令解析失败:', e.message);
      return;
    }
    if (topic.indexOf('focus') > -1) {
      const z = msg.zoneId;
      if (z === '' || z === 'clear') return; // 恢复规则判定：本端恢复自动跟随（clearFocus 处理）
      if (ZONE_IDS.indexOf(z) < 0) return;
      if (st.selected !== z) st.selected = z;
      emit();
    } else if (topic.indexOf('event') > -1 && msg.op === 'recovered') {
      const z = msg.zoneId;
      if (ZONE_IDS.indexOf(z) < 0) return;
      recoverLocal(z, '小程序巡检端标记已恢复');
      emit();
    }
  }

  // 回执报文（airguard/E3/ack，Web / 3D 自动发布）：按 msgId 匹配本地指令记录，
  // received → 已接收；executed → 已执行。只升级不降级。
  function handleAck(payload) {
    let ack;
    try { ack = JSON.parse(payload); } catch (e) {
      console.error('[AirGuard][E3] 回执解析失败:', e.message);
      return;
    }
    if (!ack.msgId || (ack.ackType !== 'received' && ack.ackType !== 'executed')) return;
    const entry = st.cmdLog.filter(function (c) { return c.msgId === ack.msgId; })[0];
    if (!entry) {
      console.warn('[AirGuard][E3] 回执无匹配指令，已忽略 msgId=' + ack.msgId);
      return;
    }
    if (ack.ackType === 'executed') {
      entry.status = 'executed';
      entry.ackSource = ack.source || entry.ackSource;
    } else if (entry.status === 'sent') {
      entry.status = 'received';
      entry.ackSource = ack.source || entry.ackSource;
    }
    console.log('[AirGuard][E3] 收到回执:', ack.ackType, ack.msgId, 'source=' + ack.source);
    emit();
  }

  // 统一入口：app.js 全局注册，页面开不开都持续处理
  function handleMsg(topic, payload) {
    // 前置判断：空报文直接跳过，避免 JSON.parse 抛 Unexpected end of JSON input
    if (!payload || payload.trim() === '') {
      console.warn('[AirGuard] 收到空报文，跳过解析 topic=' + topic);
      return;
    }
    st.msgCount += 1;
    st.lastTopic = topic;
    if (topic.indexOf(ACK_TOPIC) === 0) { handleAck(payload); return; }
    if (topic.indexOf('airguard/e3/') === 0) { handleE3(topic, payload); return; }
    if (topic.indexOf('/action') > -1) { handleAction(topic, payload); return; }
    handleEnv(topic, payload);
  }

  // ---------- 指令确认回执（页面按钮调用；msgId 由这里生成并追加到指令 JSON） ----------

  // 记录一条待确认指令，返回唯一 msgId（发布时一并写入指令 JSON）
  function sendCmd(zoneId, type, desc) {
    const msgId = 'mp-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    st.cmdLog.push({
      msgId: msgId, zoneId: zoneId, type: type, desc: desc,
      time: nowStr(), sendAt: Date.now(), status: 'sent', ackSource: '',
    });
    if (st.cmdLog.length > CMD_LOG_MAX) st.cmdLog.splice(0, st.cmdLog.length - CMD_LOG_MAX);
    emit();
    return msgId;
  }

  // 发布失败（MQTT 未连接）：标记未发送
  function markFailed(msgId) {
    const entry = st.cmdLog.filter(function (c) { return c.msgId === msgId; })[0];
    if (entry && entry.status === 'sent') {
      entry.status = 'failed';
      emit();
    }
  }

  // 超时巡检：60 秒仍未收到 executed 回执 → 超时（由定时器周期调用）
  function checkTimeouts() {
    let changed = false;
    const now = Date.now();
    st.cmdLog.forEach(function (c) {
      if ((c.status === 'sent' || c.status === 'received') && now - c.sendAt > ACK_TIMEOUT_MS) {
        c.status = 'timeout';
        changed = true;
      }
    });
    if (changed) emit();
  }

  // 回执超时定时器：app 级单例，页面开不开都检查
  setInterval(checkTimeouts, 5000);

  // 清空全部业务状态（页面「清空」按钮调用，等效小程序重启）：
  // MQTT 连接保持不动，新报文到达后自动重新填充
  function reset() {
    ZONE_IDS.forEach(function (z) {
      st.zoneState[z] = null;
      st.d5State[z] = { pm25Hist: [], co2Hist: [], rule: '—', ml: '—', mismatch: false };
      st.d3Events[z] = null;
      st.lastSeen[z] = null;
    });
    st.d3History = [];
    st.cmdLog = [];
    st.userPicked = false;
    st.selected = 'zone-w';
    st.msgCount = 0;
    st.lastTopic = '—';
    emit();
  }

  // ---------- 页面操作（由 e3 页按钮调用；发布由页面执行） ----------

  // 手动切换区域：停止自动跟随
  function selectZone(z) {
    if (ZONE_IDS.indexOf(z) < 0) return false;
    st.userPicked = true; // 手动选择后不再自动跟随
    st.selected = z;
    emit();
    return true;
  }

  // 恢复规则判定：清除人工指定，本端恢复自动跟随最新报文
  function clearFocus() {
    st.userPicked = false;
    emit();
  }

  // 标记处理中：OPEN → HANDLING（复用现有干预协议广播）
  function markHandling(z, action) {
    const ev = st.d3Events[z];
    if (!ev || ev.state !== 'OPEN') return false;
    ev.state = 'HANDLING';
    ev.action = action;
    ev.normalStreak = 0;
    emit();
    return true;
  }

  // 标记已恢复：本地归档 RECOVERED
  function markRecovered(z) {
    const ev = st.d3Events[z];
    if (!ev || ev.state !== 'HANDLING') return false;
    recoverLocal(z, '小程序巡检端标记已恢复');
    emit();
    return true;
  }

  return {
    state: st,
    handleMsg: handleMsg,
    selectZone: selectZone,
    clearFocus: clearFocus,
    markHandling: markHandling,
    markRecovered: markRecovered,
    sendCmd: sendCmd,
    markFailed: markFailed,
    checkTimeouts: checkTimeouts,
    reset: reset,
    ACK_TOPIC: ACK_TOPIC,
    onChange: function (fn) { listeners.push(fn); },
    offChange: function (fn) {
      for (let i = listeners.length - 1; i >= 0; i--) {
        if (listeners[i] === fn) listeners.splice(i, 1);
      }
    },
    nowStr: nowStr,
    ZONES: ZONES,
    ZONE_IDS: ZONE_IDS,
    OFFLINE_MS: OFFLINE_MS,
  };
}

module.exports = {
  create: create,
  ZONES: ZONES,
  ZONE_IDS: ZONE_IDS,
  STATUS_ACCENT: STATUS_ACCENT,
  CROWD_TEXT: CROWD_TEXT,
};
