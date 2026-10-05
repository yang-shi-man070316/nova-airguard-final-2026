// AirGuard 环境监测小程序入口
// MQTT 全局单例：全小程序共享 1 个 WebSocket 连接（微信限制同时最多 2 个 socket，
// 各页面分别建连会超限报 exceed max task count）。
// 统一订阅全部主题，页面按需注册/注销消息处理器；连接状态经 onConnChange 通知各页面。
const MqttClient = require('./utils/mqtt.js');
const e3store = require('./utils/e3store.js');

// 真机联调：手机连的是这台电脑，必须用电脑局域网 IP（127.0.0.1 在手机上指向手机自己）
// 电脑端模拟器用该 IP 同样可连（本机回环）。若路由器重新分配 IP 导致连不上，用 ipconfig 查新 IP 更新这里。
const MQTT_URL = 'ws://192.168.100.102:8083/mqtt';

App({
  globalData: {
    mqtt: null,
    connState: '', // '' 连接中 | 'on' 已连接 | 'off' 断开
    connText: '连接中…',
    e3State: null, // E3 巡检协同页跨页面状态：页面退出再进入不清零（见 pages/e3/e3.js onLoad）
  },

  onLaunch: function () {
    const self = this;
    const mqtt = new MqttClient(MQTT_URL);

    mqtt.on('connect', function () {
      self.globalData.connState = 'on';
      self.globalData.connText = '已连接 ' + MQTT_URL;
      self.notifyConn();
    });
    mqtt.on('close', function () {
      self.globalData.connState = 'off';
      self.globalData.connText = '连接断开，自动重连中…';
      self.notifyConn();
    });
    mqtt.on('error', function (err) {
      console.error('[AirGuard] MQTT 错误:', err);
      self.globalData.connState = 'off';
      self.globalData.connText = '连接错误，自动重连中…';
      self.notifyConn();
    });

    this.globalData.mqtt = mqtt;
    this._connListeners = [];

    // E3 巡检协同共享状态机：在全局连接上注册一次消息处理，
    // 无论 E3 页面是否打开都持续更新（页面只渲染，不再自己接消息）
    this.globalData.e3store = e3store.create(this);
    mqtt.on('message', function (topic, payload) {
      self.globalData.e3store.handleMsg(topic, payload);
    });

    mqtt.connect();

    // 统一订阅：环境数据 + 干预指令 + E3 跨端指令 + E3 指令回执（CONNACK 前自动排队）
    mqtt.subscribe('airguard/+/env');
    mqtt.subscribe('airguard/+/action');
    mqtt.subscribe('airguard/e3/focus');
    mqtt.subscribe('airguard/e3/event');
    mqtt.subscribe('airguard/E3/ack');
  },

  // 连接状态变化通知（页面 onLoad 注册 / onUnload 注销）
  notifyConn: function () {
    const fns = this._connListeners || [];
    for (let i = 0; i < fns.length; i++) fns[i]();
  },
  onConnChange: function (fn) {
    (this._connListeners = this._connListeners || []).push(fn);
  },
  offConnChange: function (fn) {
    this._connListeners = (this._connListeners || []).filter(function (f) { return f !== fn; });
  },
});
