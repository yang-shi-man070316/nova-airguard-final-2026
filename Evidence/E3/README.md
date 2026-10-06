# E3 Web—移动端实时数据同步与协同 · 操作手册

> 适用版本：2026-10-05 更新（微信小程序 E3 巡检协同页 + Web/3D E3 接入块）
> 涉及端：Web 监测台（web/index.html、web/dashboard.html 多区域总览）· 3D 数字孪生（three3d/three-min.html）· 微信小程序（airguard-miniprogram，首页 + pages/e3 巡检协同页）
> 核心：三端订阅**同一个 MQTT Broker、同一套数据源**，数据同源、状态一致、变化同步、终端分工明确。

## 一、架构与分工

```
                    ┌───────────────┐
   Web 监测台 ──────►│  mosquitto    │◄────── 微信小程序（巡检端）
   （中控总览/多区域 │  1883 + 8083  │        （重点区域卡片/事件操作）
    表格/事件日志）   └──────┬────────┘
                      ▲     │     共享数据流
                      │     ▼
              three-min 3D 孪生（发光高亮/状态壳）
```

SQLite 持久化扩展（黄色扩展项，附加链路，不影响上面主链路）：

```
   db_recorder.py ──订阅(只订阅不发布)──► mosquitto ──► 落库 airguard.db
   （MQTT订阅 + SQLite + 简易HTTP只读查询）              ├─ sensor_history 区域感知历史
                                                         └─ event_audit 统一事件审计
   web/index.html「历史与审计面板」──HTTP GET──► db_recorder.py（只读查询，前端不直接操作SQLite）
```

- **Web 监测台**：中控总览、多区域表格、完整事件日志、热力图，适合电脑值守
- **小程序**：精简巡检视图，只展示当前重点区域、实时感知结论、关键操作按钮（切换重点区域、标记事件处理状态），面向现场巡检人员
- **终端分工**：小程序 ≠ 复刻监测台全部功能

关键实现：小程序 MQTT 客户端为**全局单例**（app.js 统一建连），全小程序共享 1 个 WebSocket（微信限制同时最多 2 个 socket，页面各自建连会超限报 `exceed max task count`），支持 Broker 断连后 5 秒自动重连并继续同步最新状态。

## 二、前置条件

| 项 | 要求 |
|---|---|
| Broker | mosquitto 运行中（TCP 1883 + WebSocket 8083） |
| 数据源 | sensor_sim.py（任意模式）或 MQTTX |
| 小程序 | 微信开发者工具打开 `airguard-miniprogram` 工程；**详情 → 本地设置 → 勾选「不校验合法域名、web-view（业务域名）、TLS 版本以及 HTTPS 证书」**；修改代码后点「编译」；真机调试需手机与电脑同一局域网（app.js 已配电脑局域网 IP） |
| Web / 3D | 浏览器直接打开 web/index.html 与 three3d/three-min.html（可同时开三个窗口对照观察） |
| SQLite 记录（可选） | `pip install paho-mqtt` 后 `python db_recorder.py`：历史/审计落库 + HTTP 只读查询；不启动不影响三端演示 |

## 三、MQTT 协议总表（三端共用）

| 主题 | 方向 | 载荷 | 作用 |
|---|---|---|---|
| `airguard/+/env` | 任意源 → 三端 | `{"zoneId","pm25","co2","crowdLevel","time"}` | 环境数据（核心字段三端完全一致；**不参与回执，无 msgId**） |
| `airguard/{zone}/action` | 小程序/Web → 三端 | `{"zoneId","action","msgId","time"}` | 干预指令：OPEN → HANDLING（复用 D3 协议；小程序下发带 msgId） |
| `airguard/e3/focus` | 小程序 → Web/3D | `{"zoneId","msgId","time"}` | 切换重点区域（zoneId 为空 = 恢复规则判定；带 msgId） |
| `airguard/e3/event` | 小程序 → Web/3D | `{"zoneId","op":"recovered","note","msgId","time"}` | 标记事件已恢复 → 三端归档 RECOVERED（带 msgId） |
| `airguard/E3/ack` | Web/3D → 小程序 | `{"msgId","zoneId","ackType":"received\|executed","source":"web\|three3d","time"}` | **指令回执（消息确认）**：收到指令 → received；业务执行完成 → executed。Web/3D 自动发布，MQTTX 无需手动发布 |

状态一致性（同一套规则生成，任何一端都不各自维护不一致结果）：

| 业务状态 | 三端同规则 |
|---|---|
| status 判级 | pm25>150 重度 → pm25>75 轻度 → co2≥1500 通风不足 → 正常 |
| D5 双判定 | 固定规则 pm25>75 或 co2>1000；ML = 历史均值+2×标准差（≥6 条，不含当前值）；规则优先裁决 |
| D3 事件状态机 | OPEN →（干预）→ HANDLING →（连续 2 条正常 / 小程序标记）→ RECOVERED |
| 节点在线 | 2 分钟无新数据判离线（三端同阈值） |
| 重点区域 | 规则打分（D2）或小程序人工指定（E3 指令，三端同步） |

## 四、小程序操作说明

### 入口

首页（pages/index）底部蓝色按钮「📱 进入 E3 巡检协同（Web 同步）→」→ 跳转 E3 巡检协同页。

### 1. 区域选择（跨端联动核心）

- E3 页顶部「三区实时状态」条 + 三个胶囊标签：宿舍区 / 教学区 / 食堂区，蓝色填充 = 当前选中；状态条三区同屏显示最新数据，点状态条或标签都可切换
- 未手动选过区域时，选中区域**自动跟随最新报文**（每条报文都有可见反应）；手动点选后停止跟随，点「恢复规则判定重点区域」恢复自动跟随
- 点击切换后**立即发布** `airguard/e3/focus` 指令，同时：
  - 本页重点区域卡片切换到该区域
  - **Web 监测台**：D2 面板与概览的「优先关注区域」同步变为该区域，D2 面板头部出现蓝色徽标「📱 小程序指定重点区域：…」，判定理由显示「小程序巡检端人工指定重点区域（跨端协同同步）」，D2 表格对应行高亮
  - **three-min 3D 页面**：该建筑出现红色发光光晕 + 高亮壳（D2 优先关注标记）
- 「恢复规则判定重点区域」：发布 zoneId 为空的指令，Web/3D 恢复按 D2 规则自动计算

### 2. 重点区域卡片

实时展示选中区域：PM2.5（μg/m³）、CO₂（ppm）、人流密度（中文 + L 等级）、上报时间、状态徽章（四色）、D5 判定行（规则结论 + ML 结论 + ⚠不一致黄条）、节点在线/离线 + lastSeen、当前事件状态。数据来自同一 MQTT 流，随报文实时刷新。

### 3. 事件操作

| 按钮 | 可用条件 | 行为 |
|---|---|---|
| 标记处理中（橙） | 该区域事件处于 OPEN | 本地进入 HANDLING + 发布 `airguard/{zone}/action` → Web D3 面板与 3D 状态壳同步 HANDLING |
| 标记已恢复（绿） | 该区域事件处于 HANDLING | 本地归档 + 发布 `airguard/e3/event` → Web/3D 同步 RECOVERED（3D 外框渐变回色） |

条件不满足时按钮显示灰色（非禁用），点击会弹出提示（如「当前无 OPEN 待处理事件」），保证每次点击都有可见反馈。

事件也会被数据自动驱动：异常报文 → OPEN；HANDLING 后连续 2 条正常报文 → 自动 RECOVERED（与 Web 同规则）。

### 6. 指令确认状态（三级回执，任务书消息确认）

小程序下发任意 E3 指令（切换重点区域 / 恢复规则判定 / 标记处理中 / 标记已恢复）时，代码自动生成唯一 msgId 追加到指令 JSON。Web / 3D 收到后自动发布两级回执到 `airguard/E3/ack`，小程序按 msgId 匹配，在操作按钮下方展示确认状态（多条操作各自独立展示，互不干扰）：

| 状态 | 展示 | 触发条件 |
|---|---|---|
| ✅已发送 | 蓝色 | 点击按钮、指令已发布（msgId 已生成） |
| 📩已接收 | 青色 | 收到 Web/3D 的 `ackType:"received"` 回执 |
| 🟢已执行 | 绿色 | 收到 `ackType:"executed"` 回执（业务渲染/状态更新完成） |
| ⚠等待确认超时，请检查连接 | 红色 | 60 秒未收到 executed 回执，自动判超时并弹一次提示 |
| ❌未发送（MQTT 未连接） | 红色 | 发布时 MQTT 未连接，指令未发出 |

说明：传感器环境报文 `airguard/+/env` 格式完全不变、不参与回执；MQTTX 手动发布的指令不带 msgId 时 Web/3D 不发回执（兼容原有流程）。

### 7. 刷新 / 清空按钮（首页与 E3 页底部）

真机调试时电脑端点「编译」只重置模拟器，手机上运行的小程序实例不会清空，页面底部提供两个胶囊按钮：

| 按钮 | 行为 |
|---|---|
| 刷新 | 同步 MQTT 连接状态 + 全量重渲染；若 MQTT 已断开则强制重连（干净关闭旧连接后重建，CONNACK 后按清单自动重订阅），toast 提示「已刷新，正在重连…」 |
| 清空 | 弹确认框 → 页面数据恢复初始状态（E3 页清空共享状态机，等效小程序重启；首页清空三区卡片与感知结论）。MQTT 连接保持不断，新报文到达后自动重新填充 |

### 页面状态保持

E3 业务状态由**共享状态机** `utils/e3store.js` 维护：app.js 在全局 MQTT 连接上注册一次消息处理，**无论 E3 页面是否打开都持续更新**（页面打开前到达的报文同样入状态，不会丢）。页面只做渲染。

- 退出页面（返回首页）再进入：自动恢复上次内容，不清零
- 页面未打开期间收到的报文：进入页面立即可见（状态条 + 事件 + 诊断计数）
- 诊断行的「已收消息 N 条」为状态机全局计数，页面关闭期间也在增长

### 4. 在线状态

卡片内「节点：在线/离线 · lastSeen HH:mm:ss」+ 顶部横幅「在线 N/3」，由 1 秒巡检 + 2 分钟阈值维护（与 Web D4 同规则）；横幅同时显示 MQTT 连接状态（绿点已连接 / 红点断开自动重连中）。

### 5. 极简事件列表

仅展示最近事件（最多 5 条）：黄色「D3」徽标 = 活跃事件（OPEN/HANDLING），绿色「恢复」徽标 = 已恢复事件，与 Web/3D 同源同步。

## 五、验收流程（对应任务书条款逐条）

**准备**：broker 运行 → 开两个浏览器窗口（index.html、three-min.html）+ 小程序编译进入 E3 页 → `python sensor_sim.py normal`。

### 验收 1：数据同源（核心字段一致）

1. MQTTX 向 `airguard/zone-w/env` 发：

```json
{"zoneId":"zone-w","pm25":160,"co2":900,"crowdLevel":3,"time":"当前时间"}
```

2. **通过标准**：Web 监测卡、3D 建筑标签、小程序重点区域卡片**同时刷新**，三端 pm25=160、co2=900、crowdLevel=3（严重拥挤）、time、status=重度污染 完全一致；小程序不需任何手动输入。

### 验收 2：跨端联动（小程序切换重点区域）

1. 小程序点「教学区」标签
2. **通过标准**（约 1 秒内）：Web D2 面板「当前优先关注：教学区」+ 蓝色「📱 小程序指定重点区域」徽标（dashboard.html 的 D2 面板同样出现徽标与置顶高亮行，总览卡片带「📱 小程序指定」角标）；three-min 教学区建筑红色发光高亮；小程序卡片切换为教学区
3. 点「恢复规则判定重点区域」→ Web/3D 回到 D2 规则计算结果（dashboard.html 徽标同步消失）

### 验收 3：事件协同（处理中 / 已恢复）

1. MQTTX 给 zone-s 发 pm25=160 → 三端出现 OPEN 事件（小程序卡片显示「OPEN 待处理」）
2. 小程序点「标记处理中」→ Web D3 面板显示 HANDLING 处理中、3D 教学区外框黄色闪烁、小程序按钮切换为「标记已恢复」
3. 小程序点「标记已恢复」→ 三端事件同步归档 RECOVERED，3D 外框渐变回环境色，三端事件列表出现「已恢复」记录

### 验收 4：自动重连

重启 mosquitto（或断网 10 秒）→ 三端显示断开 → 恢复后自动重连，新报文继续三端同步，无需任何手动操作。

### 验收 5：消息确认回执（三级反馈）

**准备**：broker 运行 → index.html + three-min.html 两个浏览器窗口打开 → 小程序编译进入 E3 页 → MQTTX 先发一条异常报文制造 OPEN 事件。

1. 小程序点「教学区」标签 → 操作按钮下方「指令确认状态」出现 `19:xx:xx · 切换重点区域·教学区`，状态先显示 **✅已发送**，约 1 秒内依次变 **📩已接收** → **🟢已执行**
2. **通过标准**：Web F12 Console 出现 `[AirGuard][E3] 回执: received` 与 `回执: executed` 日志（index.html / dashboard.html / three-min.html 任一打开的页面都会发回执）；MQTTX 订阅 `airguard/E3/ack` 能观察到 received 与 executed 两条回执报文（无需手动发布）
3. 依次操作「标记处理中」「标记已恢复」「恢复规则判定」→ 每条指令各自独立出现一条状态记录，互不影响
4. 关闭所有 Web 页面（index.html、dashboard.html、three-min.html 三个窗口全关，无接收端）→ 小程序再点「标记处理中」→ 显示 **✅已发送**，60 秒后自动变 **⚠等待确认超时，请检查连接** 并弹出一次提示
5. 环境报文回归：MQTTX 发 `airguard/+/env` 报文 → 三端数据照常刷新，不出现任何回执交互

## 六、SQLite 持久化与统一审计（黄色扩展项）

### 1. 简介

`db_recorder.py`（Python 内置 sqlite3，单文件库，**不使用 MySQL**，减少部署依赖）订阅全部 MQTT 主题，把区域感知历史与所有跨端操作/事件生命周期写入 `airguard.db`（脚本启动时自动建库建表，无需手动执行 SQL）。Web 前端只通过 HTTP GET 查询展示，不直接操作 SQLite。

- 写入只由 MQTT 订阅脚本完成（HTTP 只提供 GET 查询，无写入接口）
- 脚本停止后整套三端监测 / E3 回执照常运行，不受影响（纯附加链路）
- 重启整套系统后历史数据不丢失，刷新 Web 页面可重新加载历史记录

### 2. 数据表结构

**表1：sensor_history 区域感知历史表**

| 字段 | 类型 | 说明 |
|---|---|---|
| id | INTEGER | 自增主键 |
| zoneId | TEXT | 区域 ID（zone-n / zone-s / zone-w） |
| pm25 | REAL | PM2.5 数值 |
| co2 | REAL | CO₂ 数值 |
| crowdLevel | INTEGER | 人流等级（0-3） |
| status | TEXT | 状态文本（正常/轻度污染/重度污染/通风不足风险，与全端统一判级规则一致） |
| receive_time | TEXT | 报文接收时间戳 |

**表2：event_audit 统一事件 & 操作审计表（核心）**

| 字段 | 类型 | 说明 |
|---|---|---|
| id | INTEGER | 自增主键 |
| event_type | TEXT | sensor_data / zone_focus_switch / event_handling / event_recovered |
| zoneId | TEXT | 对应区域 |
| source | TEXT | 操作来源：web / miniprogram / sensor_sim |
| content | TEXT | 描述文本（如「小程序切换重点区域到教学区（zone-s）」） |
| extra_json | TEXT | 附加信息 JSON 字符串（msgId、旧状态、新状态等） |
| op_time | TEXT | 操作时间戳 |

### 3. 启动步骤

```bash
pip install paho-mqtt          # 首次需要（与 sensor_sim.py 相同依赖）
python db_recorder.py          # 项目根目录；Ctrl+C 停止
```

启动输出示例：`SQLite 数据库: ...\airguard.db`、`HTTP 查询接口: http://127.0.0.1:8090/...`。之后保持运行，所有 MQTT 报文自动落库。

### 4. HTTP 查询接口（只读）

| 接口 | 说明 |
|---|---|
| `GET /api/sensorHistory?zoneId=zone-w[&limit=100]` | 获取该区域历史感知数据（按时间升序返回，limit 默认 100 最大 500） |
| `GET /api/eventAudit?limit=20` | 获取最近 N 条事件 & 操作审计记录（按时间倒序） |

接口返回 `{"ok":true,"count":N,"data":[...]}`，已带 CORS 头（`file://` 页面 fetch 可用）。Web 面板在 db_recorder.py 未启动时仅显示提示，不影响监测主链路。

### 5. 验收 6：SQLite 持久化与统一审计

**准备**：broker 运行 → `python db_recorder.py` → 打开 web/index.html（滚动到底部「历史与审计」面板）→ 小程序编译进入 E3 页。

1. 启动 db_recorder.py → 项目根目录自动生成 `airguard.db`（含 sensor_history / event_audit 两表，无需手动建表）
2. MQTTX 向 `airguard/zone-w/env` 发一条报文 → 「区域历史数据」标签页选食堂区点「加载历史」→ 表格出现该条记录（PM2.5/CO₂/人流/状态着色正确），下方折线图出现 PM2.5（红）、CO₂（蓝）数据点
3. 小程序点「教学区」标签 → 「统一操作审计」标签页出现 `zone_focus_switch` 记录：橙色「重点区域」徽标 + 来源「小程序」+ 描述内容
4. 小程序依次「标记处理中」「标记已恢复」（先造 OPEN 事件）→ 审计列表出现 `event_handling`、`event_recovered` 记录，与 `sensor_data` 灰色「传感器」记录区分展示
5. 停掉 db_recorder.py（Ctrl+C）→ 三端监测、E3 消息回执照常工作；面板显示「请先启动 db_recorder.py」提示，不报错
6. 重启 db_recorder.py → 刷新 Web 页面 → 历史数据与审计记录完整保留（重启不丢数据）
7. （可选）浏览器直接访问 `http://127.0.0.1:8090/api/eventAudit?limit=5` 验证只读接口 JSON 输出

## 七、常见问题

| 现象 | 原因与处理 |
|---|---|
| Web 页面连接断开：Console 报 `WebSocket connection ... failed: Connection closed before receiving a handshake response` | 新版 mosquitto 要求 WS 握手带 `mqtt` 子协议，mqtt.js v5 默认不发送 → 已修复：三个页面的 mqtt.connect 全部显式加 `protocols: ['mqtt']`（小程序客户端原本就带，故一直正常） |
| `exceed max task count` / 同时最多发起 2 个 socket | 页面各自建连超限 → 已改为 app.js 全局单例（全小程序仅 1 个 WebSocket）；改代码后需点「编译」 |
| `closeSocket:fail task not found` | 关闭无效连接任务 → 连接失败时 task 置空，不再触发 |
| 小程序收不到数据 | 检查本地设置是否勾选「不校验合法域名」；确认 broker 8083 在监听；真机需用电脑局域网 IP（app.js 已默认 192.168.100.102，换网络后 ipconfig 查新 IP 更新） |
| 切换区域后 Web 没变化 | 确认小程序连接状态为绿色「已连接」；打开 Web 页面 F12 Console 看 `[AirGuard][E3] 重点区域指令` 日志 |
| 三端数值不一致 | 属异常：三端字段均直接取自同一 MQTT 报文，status 三端按同一规则计算；若不一致先对比 time 字段是否为同一条报文 |
| 小程序告警弹窗在其他页弹出 | 已修复：弹窗仅在本页可见时触发 |
| E3 页退出再进入内容清零 | 已修复：状态由共享状态机挂 `app.globalData.e3State`，退出再进入自动恢复，不清零 |
| 第一条报文不显示（只显示第二条） | 已修复：状态机 app 级注册，页面开不开都收消息；顶部新增「三区实时状态」条三区同屏；未手动选过区域时卡片跟随最新报文 |
| 点区域标签/事件按钮没有反应 | 每次点击都有 toast 反馈；事件按钮条件不满足时弹出原因；选中无数据区域显示「暂无数据」黄条；Console 有 `[AirGuard][E3]` 点击日志 |
