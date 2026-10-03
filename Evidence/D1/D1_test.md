# AirGuard D1 Web 监测台功能测试记录

测试时间：2026-10-03
测试环境：本地 Mosquitto MQTT Broker；Web 前端经 ws://127.0.0.1:8083 连接（mqtt.js v5），订阅 `airguard/+/env`

## 测试依据（与 index.html 当前实现一致）

- JSON 字段：`zoneid`（小写）、`pm25`、`co2`、`crowdLevel`、`time`
- status 判定顺序：pm25>150 → 重度污染；pm25>75 → 轻度污染；co2≥1500 → 通风不足风险；其余 → 正常
- crowdLevel 不参与 status 判定，仅映射为中文渲染至【人流等级】：0 稀疏 / 1 正常 / 2 拥挤 / 3 严重拥挤

## 测试用例

1. zone-n —— 重度污染（验证 pm25>150 优先于 co2≥1500）
   Topic: `airguard/zone-n/env`
   Payload: `{"zoneid":"zone-n","pm25":190,"co2":2000,"crowdLevel":3,"time":"2026-10-03 21:00:00"}`
   结果：状态【重度污染】，人流等级【严重拥挤】，卡片左边框与徽章为红色

2. zone-s —— 轻度污染（验证 pm25>75 优先于 co2≥1500）
   Topic: `airguard/zone-s/env`
   Payload: `{"zoneid":"zone-s","pm25":82,"co2":1600,"crowdLevel":2,"time":"2026-10-03 21:05:00"}`
   结果：状态【轻度污染】，人流等级【拥挤】

3. zone-w —— 通风不足风险（co2≥1500 且 pm25≤75）
   Topic: `airguard/zone-w/env`
   Payload: `{"zoneid":"zone-w","pm25":18,"co2":1600,"crowdLevel":1,"time":"2026-10-03 21:08:00"}`
   结果：状态【通风不足风险】，人流等级【正常】

4. zone-w —— 正常（pm25≤75 且 co2<1500）
   Topic: `airguard/zone-w/env`
   Payload: `{"zoneid":"zone-w","pm25":35,"co2":800,"crowdLevel":0,"time":"2026-10-03 21:10:00"}`
   结果：状态【正常】，人流等级【稀疏】

## 测试结论

Web 监测台成功建立 MQTT WebSocket 连接（连接指示灯绿色，显示「已连接 ws://127.0.0.1:8083」），订阅 `airguard/+/env` 后正确解析各区域的 `zoneid`（小写）环境数据；status 严格按任务书顺序仅由 pm25/co2 判定，四种状态分支及优先级全部验证通过；crowdLevel 正确映射为中文渲染至【人流等级】位置且不影响 status 判定；界面随消息实时刷新，各区域数据互不串线。
