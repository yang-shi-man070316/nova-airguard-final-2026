// AirGuard 技术文档报告生成脚本（docx-js → WPS/Word 可打开的 .docx）
// 运行：node build_docx.js
const { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, BorderStyle, ShadingType, AlignmentType } = require('docx');

const F_BODY = '宋体';
const F_HEAD = '黑体';
const SZ_BODY = 21;      // 五号 10.5pt
const SZ_TABLE = 18;     // 表格 9pt
const SZ_H1 = 32;        // 一级标题 16pt
const SZ_H2 = 26;        // 二级标题 13pt
const TABLE_W = 9026;    // A4 减左右 1 英寸边距后的可用宽度(DXA)

// ---------- 基础元素 ----------
function p(text, opts) {
  opts = opts || {};
  return new Paragraph({
    alignment: opts.center ? AlignmentType.CENTER : undefined,
    spacing: { after: 120, line: 300 },
    children: [new TextRun({ text: text, font: opts.font || F_BODY, size: opts.size || SZ_BODY, bold: !!opts.bold, color: opts.color })],
  });
}

function h1(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 320, after: 160 },
    children: [new TextRun({ text: text, font: F_HEAD, size: SZ_H1, bold: true, color: '1F3864' })],
  });
}

function h2(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 220, after: 120 },
    children: [new TextRun({ text: text, font: F_HEAD, size: SZ_H2, bold: true, color: '2E5395' })],
  });
}

// 表格单元格（带全边框，可选表头底色）
function cell(text, w, isHead) {
  const border = { style: BorderStyle.SINGLE, size: 4, color: '808080' };
  return new TableCell({
    width: { size: w, type: WidthType.DXA },
    shading: isHead ? { type: ShadingType.CLEAR, fill: 'DCE6F1' } : undefined,
    borders: { top: border, bottom: border, left: border, right: border },
    children: [new Paragraph({
      spacing: { after: 40, before: 40 },
      children: [new TextRun({ text: text, font: F_BODY, size: SZ_TABLE, bold: !!isHead })],
    })],
  });
}

function table(cols, rows, head) {
  const headerRow = new TableRow({ children: head.map(function (t, i) { return cell(t, cols[i], true); }) });
  const bodyRows = rows.map(function (r) {
    return new TableRow({ children: r.map(function (t, i) { return cell(t, cols[i], false); }) });
  });
  return new Table({
    width: { size: TABLE_W, type: WidthType.DXA },
    columnWidths: cols,
    rows: [headerRow].concat(bodyRows),
  });
}

// 等宽单行文本（架构图用）
function mono(text) {
  return new Paragraph({
    spacing: { after: 0, line: 240 },
    children: [new TextRun({ text: text, font: 'Consolas', size: 16 })],
  });
}

// ---------- 内容 ----------
const children = [];

// ===== 标题块 =====
children.push(new Paragraph({
  alignment: AlignmentType.CENTER,
  spacing: { before: 240, after: 80 },
  children: [new TextRun({ text: 'AirGuard 空气质量与人流监测综合系统', font: F_HEAD, size: 44, bold: true, color: '1F3864' })],
}));
children.push(new Paragraph({
  alignment: AlignmentType.CENTER,
  spacing: { after: 200 },
  children: [new TextRun({ text: '技术文档报告', font: F_HEAD, size: 32, bold: true, color: '2E5395' })],
}));
children.push(p('版本：2026-10-07 ｜ 涉及端：Web 监测台、3D 数字孪生、微信小程序、Python 服务 ｜ 正文约 12-14 页', { center: true }));
children.push(p('文档定位：说明「系统为什么这样设计、怎样实现、怎样验证」，覆盖 D1-D5 数据链与 E1-E3 交互增强。', { center: true }));

// ===== 1. 项目与需求 =====
children.push(h1('1. 项目与需求'));
children.push(h2('1.1 项目目标'));
children.push(p('AirGuard 面向校园场景，构建一套多区域空气质量与人流密度实时监测与跨端协同处置的综合系统。系统以 MQTT 实时数据流为底座，实现三个同源终端：Web 监测台（承担 D1-D5 五条数据链与 E1-E3 交互增强）、3D 数字孪生（建筑状态壳与发光高亮）、微信小程序巡检端（精简视图与关键操作）。'));
children.push(h2('1.2 使用场景'));
children.push(table(
  [1400, 1600, 6026],
  [
    ['中控值守', 'Web 监测台', '三区域实时总览、重点区域判定与理由、事件处置（干预与恢复）、趋势与故障日志'],
    ['现场巡检', '微信小程序', '查看三区状态条与重点卡片，切换重点区域（三端同步），标记事件处理中或已恢复'],
    ['可视化演示', '3D 孪生', '状态壳变色、重点区域发光高亮、事件状态闪烁'],
    ['数据留档', 'db_recorder + SQLite', '环境报文落历史库，全部操作写统一审计表，重启不丢'],
    ['离线复盘', '离线分析链', 'CSV 记录生成统计报告与 D5 判定报告'],
  ],
  ['场景', '端', '行为']
));
children.push(h2('1.3 核心问题与设计决策'));
children.push(table(
  [700, 2400, 5926],
  [
    ['1', '三端数据一致性', '全部订阅同一个 Broker、同一套数据源；判级、打分、状态机规则三端各自用同一套规则生成，任一端的结论都不依赖另一端，避免口径分裂'],
    ['2', '事件处置闭环', 'D3 事件状态机 OPEN → HANDLING → RECOVERED，人工干预按钮与数据自动驱动恢复结合，处置过程全链路留痕'],
    ['3', '规则可靠性与数据自适应', 'D5 双判定：固定安全规则兜底（可解释、零冷启动）与 ML 统计动态阈值（自适应基线漂移）结合，规则优先裁决，两套结论不一致时标注建议人工复核'],
    ['4', '跨端指令可靠性', 'E3 消息回执机制：小程序下发的每条指令带唯一 msgId，Web 与 3D 回执 received 与 executed，小程序展示已发送、已接收、已执行三级状态，60 秒超时兜底'],
    ['5', '数据留存与可审计', 'SQLite 单文件库（Python 内置 sqlite3，不引入 MySQL），感知历史与统一事件审计两张表，附加链路故障不影响主演示'],
    ['6', '移动端连接资源约束', '微信限制同小程序最多 2 个 socket，MQTT 客户端做成 app.js 全局单例，页面只注册与注销消息处理器'],
  ],
  ['编号', '核心问题', '设计决策（为什么）']
));

// ===== 2. 系统架构与数据链 =====
children.push(h1('2. 系统架构与数据链'));
children.push(h2('2.1 整体架构'));
children.push(mono('                     ┌─────────────────┐'));
children.push(mono('  sensor_sim/MQTTX ──► │   mosquitto     │ ◄── db_recorder.py（只订阅写库 → airguard.db）'));
children.push(mono('                     │ 1883+8083 双监听 │'));
children.push(mono('                     └────┬───────┬─────┘'));
children.push(mono('             ┌────────────┘       └──────────────┐'));
children.push(mono('  Web 监测台(index/dashboard)        微信小程序（全局单例 MQTT 连接）'));
children.push(mono('  3D 孪生(three-min)                ├─ 首页：三区卡片 + 感知结论'));
children.push(mono('  （各页面独立连接，互不影响）        └─ E3 巡检页：重点卡片 + 事件操作 + 回执'));
children.push(p('架构要点：broker 是唯一的数据交换中心，任何一端不与其他端直接通信；浏览器端每个页面独立建立 WebSocket 连接，broker 向所有订阅者广播；小程序端全应用共享 1 个 WebSocket（微信最多 2 个 socket 限制），连接与订阅由 app.js 统一管理，断线 5 秒自动重连并按清单重订阅；db_recorder 是纯旁听链路，只订阅写库，其启停不影响实时演示。'));
children.push(h2('2.2 边缘实时链（感知 → 展示）'));
children.push(p('第一步，sensor_sim.py 按周期（默认 5 秒）向 airguard/{zone}/env 发布三区域环境报文（retain=True，页面刷新即恢复最新状态），支持 normal、case1、case2、case3、d3 五种剧本与 clear 清除模式。第二步，broker 广播，三端各自的订阅回调解析报文，按统一判级规则计算状态并更新对应区域界面。关键防串数据设计：消息处理只更新报文 zoneId 对应的那一张卡片，绝不写入其他区域；非法 zoneId 的报文直接忽略。'));
children.push(h2('2.3 离线分析链（记录 → 报告）'));
children.push(table(
  [1300, 4100, 3626],
  [
    ['数据链 A（Web 记录）', 'D1 面板开始记录 → 页面持续采集 → 导出 CSV → python_anaiysis 分析脚本（pandas + matplotlib）', 'report.html 单文件报告（图表内嵌），支持与历史 CSV 增量合并并按 zoneId+time 去重'],
    ['数据链 B（sensor_sim 记录）', 'sensor_sim 运行期间写 sensor_records.csv，Ctrl+C 停止时自动执行 D5 双判定', 'web/ml-report.html 静态报告（判定卡片 + 历史表格 + 脏数据日志 + 案例分析）'],
  ],
  ['链', '路径', '产物']
));
children.push(p('两条链互补：A 链面向人工记录与增量分析，B 链面向自动运行记录与 D5 案例留存。'));
children.push(h2('2.4 数据链分层'));
children.push(p('感知（sensor_sim 与 MQTTX）→ 传输（MQTT QoS0 + retain）→ 判定（统一规则）→ 展示（三端渲染）→ 处置（D3 与 E3 操作）→ 留档（SQLite、CSV、报告）。各层解耦，任一层故障（如留档脚本停止）不影响其上游链路。'));

// ===== 3. 核心数据与系统机制 =====
children.push(h1('3. 核心数据与系统机制'));
children.push(h2('3.1 数据结构'));
children.push(p('环境报文 JSON 契约（三端与传感器完全一致，MQTTX 与 sensor_sim 发送格式不变）：'));
children.push(mono('  {"zoneId":"zone-w","pm25":160,"co2":900,"crowdLevel":3,'));
children.push(mono('   "crowdSource":"simulated","crowdConfidence":1.0,"time":"2026-10-07 10:00:00"}'));
children.push(p('zoneId 取 zone-n 宿舍区、zone-s 教学区、zone-w 食堂区（兼容小写 zoneid，缺失时退回 topic 中间段）。crowdSource 与 crowdConfidence 是人流感知的声明来源与置信度（任务书 0.2 阈值规则，见 3.5）。报文解析对字段缺失、非数值、非法区域全部容错，坏报文不崩页面、不污染状态。'));
children.push(p('SQLite 两张表（airguard.db，脚本启动自动建表，无需手动执行 SQL）：'));
children.push(table(
  [1700, 2300, 3026, 2000],
  [
    ['sensor_history', '区域感知历史', 'id、zoneId、pm25、co2、crowdLevel、status、receive_time', '每条环境报文一条记录'],
    ['event_audit', '统一事件与操作审计', 'id、event_type、zoneId、source、content、extra_json、op_time', '记录所有跨端操作与事件生命周期'],
  ],
  ['表', '用途', '关键字段', '说明']
));
children.push(p('event_audit 的 event_type 取 sensor_data、zone_focus_switch、event_handling、event_recovered 四类；source 区分 web、miniprogram、sensor_sim 三种来源；extra_json 保存 msgId、旧状态、新状态等附加信息。'));
children.push(h2('3.2 Topic 与 JSON 协议总表'));
children.push(table(
  [2200, 1800, 2800, 2226],
  [
    ['airguard/+/env', '传感器 → 三端', 'zoneId、pm25、co2、crowdLevel、crowdSource、crowdConfidence、time', '环境数据，不参与回执'],
    ['airguard/{zone}/action', '小程序/Web → 三端', 'zoneId、action、msgId、time', '干预指令：OPEN → HANDLING'],
    ['airguard/e3/focus', '小程序 → Web/3D', 'zoneId、msgId、time（zoneId 为空表示恢复规则判定）', '切换重点区域'],
    ['airguard/e3/event', '小程序 → Web/3D', 'zoneId、op、note、msgId、time', '标记事件已恢复或处理中'],
    ['airguard/E3/ack', 'Web/3D → 小程序', 'msgId、zoneId、ackType、source、time', '指令回执（消息确认）'],
  ],
  ['主题', '方向', '载荷要点', '作用']
));
children.push(h2('3.3 统一判级规则'));
children.push(p('全端一致、颗粒物优先：pm25 大于 150 判重度污染；pm25 大于 75 判轻度污染；co2 大于等于 1500 判通风不足风险；其余判正常。人流等级（0 稀疏、1 正常、2 拥挤、3 严重拥挤）只做展示与附加分，不参与 status 计算，保证三端判级口径完全可复现。'));
children.push(h2('3.4 D3 事件状态机与消息健壮性'));
children.push(p('状态转移：异常报文 → OPEN；干预指令或点击干预按钮 → HANDLING；连续 2 条正常且人流不超过 1（或小程序标记已恢复）→ RECOVERED 归档历史。'));
children.push(p('关键设计一：OPEN 收到正常数据保持 OPEN，禁止未经处置直接恢复。关键设计二：HANDLING 期间收集验证数据（最多 10 条），人流事件额外要求 crowdLevel 不超过 1 才允许自动恢复。关键设计三：低置信度人工复核——区域人流数据置信度低于 0.2 时 reviewFlag 置位，事件保持 HANDLING 不自动恢复，事件行标注「人流数据置信度低于阈值，需人工复核」，只能人工确认恢复。关键设计四：迟到或重复报文不回滚任何状态，仅补充事件历史记录。'));
children.push(p('消息健壮性（全端统一）：空报文前置判断，payload 为空直接跳过 JSON 解析并打日志（防止 Unexpected end of JSON input 崩溃）；非 JSON 报文诊断告警后丢弃；非法 zoneId 忽略；pm25 与 co2 非数值丢弃；脏数据规则（离线分析与 D5）对 pm25 大于 900 超量程、时间倒流、字段缺失逐条剔除并记入脏数据日志，不参与计算。'));
children.push(h2('3.5 感知结果组织（含置信度）'));
children.push(p('人流感知结论标注来源与置信度，按来源分两类处理：'));
children.push(table(
  [3400, 3000, 2626],
  [
    ['simulated、rule、review（声明来源）', '采用来源声明值 1.0', '直接参与 D2 计分'],
    ['model、template 等自动感知', '按声明值；低于 0.2 或缺失则 review 置位', '标注需人工复核，人流附加分不计入 D2 风险分'],
  ],
  ['来源', '置信度处理', '结果']
));
children.push(p('D2 风险分 = 环境基础分（重度污染 10、轻度污染 6、通风不足 4、正常 0）+ 人流附加分（L0 至 L3 记 0、1、3、5）+ 持续异常加成（连续 2 次及以上异常加 2）；需复核时人流分不计入——低置信度数据不驱动优先处置，保证结论可解释、决策可追责。'));
children.push(h2('3.6 Web—移动端同步机制（E3）'));
children.push(p('小程序下发的每条指令自动生成唯一 msgId（mp-时间戳-随机 格式）随 JSON 广播。Web 与 3D 收到后先发 received 回执，业务执行完成后再发 executed 回执到 airguard/E3/ack；不带 msgId 的旧格式指令不发回执（兼容 MQTTX 手发）。小程序按 msgId 匹配回执，展示三级状态：已发送 → 已接收 → 已执行；60 秒未完成则提示等待确认超时；多条指令各自独立展示、互不干扰。'));
children.push(p('小程序端业务状态由 app 级共享状态机（utils/e3store.js）维护：app.js 在全局连接上注册一次消息处理，页面开不开都持续更新——由此解决「退出页面清零」与「页面打开前到达的报文丢失」两类真实故障；页面只做渲染。小程序 MQTT 沿用 app.js 全局单例连接；未手动选过区域时卡片自动跟随最新报文（每条报文都有可见反应），手动点选后停止跟随，恢复规则判定可恢复自动跟随。'));

// ===== 4. D1–D5 与 E1–E3 的关键实现 =====
children.push(h1('4. D1–D5 与 E1–E3 的关键实现'));
children.push(p('本节只写关键设计与核心实现要点，不逐段复制代码。', { bold: true }));
children.push(table(
  [900, 8126],
  [
    ['D1 多区域实时监测', '三区域卡片独立存储（zoneState 按 zone 键），消息处理只更新对应 zone 条目，杜绝串数据；趋势图滚动窗口保留最近 40 条；数据链 A 记录与导出 CSV；告警弹窗（重度污染、严重拥挤）按区域加状态去重，页面隐藏时不弹。'],
    ['D2 重点区域判定', '打分与排序见 3.5，同分依次比连续异常次数、状态严重度；判定理由逐条可解释（得分最高、严重度、人流、持续异常、需人工复核）；E3 小程序指定覆盖规则结果用函数包装实现（原 calcPriority 与 buildPriorityReason 保留原样），人工指定时优先关注被指定区域并标注「小程序巡检端人工指定（跨端协同同步）」，不侵入原有 D2 代码。'],
    ['D3 事件处置', '状态机见 3.4；干预按钮发布 airguard/{zone}/action 广播，三端同入 HANDLING；事件行展示生命周期（OPEN、HANDLING、RECOVERED、处置人、恢复结论），历史归档列表滚动保留。'],
    ['D4 节点在线巡检', '2 分钟无新数据判离线（三端同阈值），每秒巡检刷新；故障日志记录 Broker 连接、断开、重连、节点断流、恢复、人工重连、报文格式错误（区分 fault 与 recover 两级）；手动重连按钮干净关闭旧连接后重建，CONNACK 后按订阅清单自动重订阅，旧连接回调按 task 身份忽略，避免误报断开与重复重连。'],
    ['D5 规则 + ML 双判定', '固定规则：pm25 大于 75 或 co2 大于 1000 判环境异常（即时、可解释）；ML 统计动态阈值：样本 6 条及以上时，用历史均值加 k 倍样本标准差（默认 k=2，现场可调 0.5 至 5）判与历史明显不同，统计时排除当前值，样本不足显示数据积累中（n/6）；规则优先裁决，两套结论不一致时黄条高亮建议人工复核；脏数据日志逐条剔除记录；案例留存：每份报告保留不一致案例并自动匹配 4 类可能原因（历史太少、历史太单一、环境模式已变化、交叉确认），满足任务书案例留存要求。'],
    ['E1 3D 预览', 'D1 面板嵌入三区域色块地图（颜色随状态实时变化），按钮跳转独立 3D 孪生页（THREE.js）。'],
    ['E2 现场交互增强', 'ASR 语音指令：Web Speech API（SpeechRecognition，兼容 webkit 前缀），识别「查看 宿舍区、教学区、食堂区、zone-x、w 区」切换选中区域，「记录现场」拍照存档，识别自动续听；TTS 播报：SpeechSynthesis 朗读选中区域状态（结论串含来源、置信度、低置信度警告）；Camera 现场记录：WebRTC getUserMedia 原生摄像头，拍照绑定 zoneId、时间戳、事件状态，相册页面内存回看，同一区域可连拍；感知结论：来源标记加置信度加低置信度警告（低于 0.2 仅作参考、不作为唯一决策依据）。'],
    ['E3 跨端协同与回执', '实现见 3.6；Web 端 E3 处理用独立订阅且函数包装不修改原有 D1-D5 处理链；回执发布顺序保证：received 在业务执行前、executed 在渲染完成后，broker 保序送达。'],
  ],
  ['模块', '关键设计与核心实现']
));

// ===== 5. 测试、故障与验证 =====
children.push(h1('5. 测试、故障与验证'));
children.push(h2('5.1 D1–D5 测试用例（与 Evidence 目录、E3 README 验收对应）'));
children.push(table(
  [900, 4200, 3926],
  [
    ['D1 数据同源', 'MQTTX 向 airguard/zone-w/env 发报文', '三端（Web、3D、小程序）pm25、co2、crowdLevel、status 完全一致'],
    ['D2 三用例', 'python sensor_sim.py case1、case2、case3', '优先关注分别为 zone-w（15 分）、zone-s（11 分）、无'],
    ['D3 剧本', 'python sensor_sim.py d3', '4 步走完 OPEN → HANDLING → 自动 RECOVERED；干预按钮可人工驱动'],
    ['D4 巡检', '停发报文 2 分钟', '节点离线并记故障日志；恢复上报后自动链路恢复'],
    ['D5 双判定', '运行 sensor_sim 后 Ctrl+C 停止', 'ml-report.html 生成，含规则与 ML 一致性与差异案例'],
  ],
  ['项', '方法', '通过标准']
));
children.push(h2('5.2 真实故障与修复（开发过程实录，均已在代码中修复并验证）'));
children.push(table(
  [3400, 2800, 2826],
  [
    ['微信报 exceed max task count', '页面各自建连超过 2 个 socket 限制', 'MQTT 客户端改 app.js 全局单例，页面只注册与注销处理器'],
    ['小程序 E3 页退出再进入内容清零', '状态存页面实例，退出即销毁', '状态机升级为 app 级（e3store.js 挂 globalData），页面只渲染'],
    ['E3 页只显示第二条报文', '选中区域卡片只展示单区，且页面关闭期间报文丢失', '共享状态机持续收消息；新增三区实时状态条；未手动选择时跟随最新报文'],
    ['空报文致 Unexpected end of JSON input', 'MQTTX 发空 payload 直接执行 JSON 解析', '全端 8 处解析点前置判空跳过并打日志'],
    ['真机收不到数据', '127.0.0.1 在手机上指向手机自身', 'MQTT 地址改电脑局域网 IP（broker 已监听 0.0.0.0）'],
    ['浏览器页面全部连不上，Console 报 Connection closed before receiving a handshake response', '新版 mosquitto 要求 WS 握手带 mqtt 子协议，mqtt.js v5 默认不发送', '三个页面全部 mqtt.connect 显式加 protocols 声明；对照实验：无子协议返回 1006 拒绝，带子协议握手成功'],
    ['CSV 被 Excel 另存后解析乱码', 'UTF-16 带 NUL 字节', '读取时按字节签名自动识别 UTF-16 与 UTF-8-sig 并清理残余 NUL'],
  ],
  ['故障现象', '根因', '修复']
));
children.push(h2('5.3 规则与 ML 对照验证'));
children.push(p('D5 报告内嵌案例分析：固定规则与 ML 结论不一致时逐条给出可解释原因（历史数据太少未建立基线、历史本身含异常致动态阈值失真、当前环境模式变化、两者一致交叉确认），并用数值列出当前值与动态阈值（pm25、co2）的对比，验证规则优先兜底的必要性。'));
children.push(h2('5.4 README 交叉复现'));
children.push(p('Evidence/E3/README.md 提供验收 1 至 6 全链路操作手册（数据同源、跨端联动、事件协同、自动重连、消息确认回执、SQLite 持久化与审计），以及常见问题速查表（子协议、真机 IP、空报文、超时等）。全部验收步骤已按 README 逐条复现通过。'));

// ===== 6. 自主设计与开放拓展 =====
children.push(h1('6. 自主设计与开放拓展'));
children.push(h2('6.1 E3 跨端协同与消息回执（自主设计）'));
children.push(p('作用：把小程序下发指令从单向广播升级为可确认的三级反馈链，补齐任务书消息确认要求；巡检人员可确认指令已被中控接收并执行，超时自动告警。实现：msgId 由小程序代码自动生成随指令广播；Web 与 3D 收到后按 received 到 executed 两阶段回执；小程序按 msgId 匹配升级状态，60 秒超时兜底；多条指令独立展示。验证证据：Node 全链路模拟（sent、received、executed、超时全路径）通过；MQTTX 订阅 airguard/E3/ack 可观察真实回执报文。已知限制：回执依赖至少一个 Web 或 3D 接收端在线（全关则 60 秒超时，属预期兜底）；不带 msgId 的手发指令不回执（兼容旧流程）。'));
children.push(h2('6.2 SQLite 持久化与统一事件审计（开放增强）'));
children.push(p('作用：区域感知历史留存（重启不丢），所有跨端操作统一审计（谁、何时、对哪个区域、做了什么），演示数据可复现。实现：db_recorder.py 只订阅不发布，env 写入 sensor_history 并追加 sensor_data 审计，focus、action、event 指令写对应 event_type 审计，source 按 msgId 前缀区分 miniprogram 与 web，extra_json 存新旧状态；HTTP 只读接口（带 CORS）供 Web 面板查询；自动建库建表。验证证据：Python 单测（建表、写入、两接口、消息分流）通过；浏览器面板（历史表格、原生 canvas 折线图、审计徽标区分传感器与人工操作）通过；停脚本三端演示不受影响。已知限制：单文件库无远程服务；脚本停止期间数据不记录；连续传感器上报会较快增长审计表（接口默认只取最近 20 条）。'));
children.push(h2('6.3 3D 数字孪生（E1 与 three-min）'));
children.push(p('作用：区域状态可视化（状态壳颜色、事件闪烁、重点区域发光高亮），与 Web、小程序同源同步。验证：MQTTX 发异常报文对应建筑壳变红；小程序切换重点区域建筑发光高亮；干预与恢复时外壳闪烁、渐变回色。'));
children.push(h2('6.4 小程序巡检端工程增强'));
children.push(p('刷新按钮（断连强制重连加全量重渲染）、清空按钮（等效重启，新报文自动重填）、诊断行（消息计数加最近主题）、全局状态机持续收消息——面向真机调试的工程化增强。'));
children.push(h2('6.5 已知限制与参考来源'));
children.push(p('已知限制：新版 mosquitto 要求 WS 子协议（已在三页面显式声明，README 已记录）；路由器 DHCP 重分配 IP 后需同步更新局域网 IP（页面与小程序）；ML 判定需 6 条样本冷启动；model 类自动感知置信度低于 0.2 需人工复核（设计行为）；E2 相册仅存页面内存（刷新清空）；审计与历史接口为单机只读服务。'));
children.push(p('参考来源：任务书 NOVA C02（D1-D5、E1-E3 条款）；mqtt.js v5、paho-mqtt、Chart.js、THREE.js、Web Speech API 与 WebRTC 官方文档；mosquitto 2.x 配置手册；本项目 Evidence 目录各板块验收文档与 E3 README。'));

// ===== 组装文档 =====
const doc = new Document({
  styles: {
    default: {
      document: { run: { font: F_BODY, size: SZ_BODY } },
    },
  },
  sections: [{
    properties: {
      page: { margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } },
    },
    children: children,
  }],
});

Packer.toBuffer(doc).then(function (buffer) {
  require('fs').writeFileSync('AirGuard技术文档.docx', buffer);
  console.log('已生成 AirGuard技术文档.docx，字节数:', buffer.length);
});
