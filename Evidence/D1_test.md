# AirGuard D1 功能测试记录
测试时间：2026-10-03
测试环境：本地Mosquitto MQTT Broker，Web前端 ws://127.0.0.1:8083

### 测试用例
1. zone-n
Topic: airguard/zone-n/env
Payload: {"pm25":35,"co2":800,"people":2,"time":"2026-10-03 21:00:00"}
结果：页面正常渲染，状态【正常】

2. zone-s
Topic: airguard/zone-s/env
Payload: {"pm25":82,"co2":1200,"people":5,"time":"2026-10-03 21:05:00"}
结果：页面正常渲染，状态【轻度污染】

3. zone-w
Topic: airguard/zone-w/env
Payload: {"pm25":18,"co2":550,"people":1,"time":"2026-10-03 21:08:00"}
结果：页面正常渲染，状态【正常】

### 测试结论
Web监测台可成功建立MQTT WebSocket连接，接收多区域环境数据，自动根据PM2.5、CO₂判断空气质量等级，界面实时刷新。