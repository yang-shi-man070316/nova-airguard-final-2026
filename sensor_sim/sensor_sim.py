#!/usr/bin/env python3
# AirGuard 传感器模拟器：周期发布三区域环境报文（retain=True 保留消息）
# 运行期间自动记录所有已发布报文到 sensor_records.csv（每次运行覆盖上一份）；
# 按 Ctrl+C 停止时，自动执行 D5 双判定（固定规则 + ML 统计动态阈值），
# 生成静态报告 web/ml-report.html（每次停止都替换成本次运行的新数据）。
# 报告内含「案例分析」板块：自动保留至少 1 个规则/ML 差异案例并说明可能原因
# （历史数据太少 / 历史数据太单一 / 历史本身包含异常 / 当前环境模式已变化，任务书 D5 案例留存要求）。
#
# 用法：
#   pip install paho-mqtt
#   python sensor_sim.py            # 正常模式（健康值轻微波动）
#   python sensor_sim.py case1      # D2 用例1：zone-w 连续重度污染+拥挤
#   python sensor_sim.py case2      # D2 用例2：zone-s 重度污染
#   python sensor_sim.py case3      # D2 用例3：全部正常
#   python sensor_sim.py d3         # D3 剧本：异常→改善→正常×2 完整事件链路
#   python sensor_sim.py clear      # 清除三个区域主题的保留消息
import csv
import io
import json
import math
import os
import random
import sys
import time
from datetime import datetime

import paho.mqtt.client as mqtt

BROKER_HOST = "127.0.0.1"
BROKER_PORT = 1883          # mosquitto 默认 TCP 端口
INTERVAL = 5                # 发布周期（秒）
TOPIC = "airguard/{zone}/env"

# 记录文件与 D5 报告输出路径
_BASE_DIR = os.path.dirname(os.path.abspath(__file__))
RECORDS_CSV = os.path.join(_BASE_DIR, "sensor_records.csv")
REPORT_PATH = os.path.join(_BASE_DIR, "..", "web", "ml-report.html")

ZONES = ("zone-n", "zone-s", "zone-w")
ZONE_CN = {"zone-n": "宿舍区", "zone-s": "教学区", "zone-w": "食堂区"}

# 各场景固定基准值：(pm25, co2, crowdLevel)
SCENARIOS = {
    "normal": {
        "zone-n": (35, 800, 0),
        "zone-s": (50, 900, 1),
        "zone-w": (45, 850, 1),
    },
    # D2 用例1：预期优先关注 zone-w（重度污染 10 分 + 拥挤 3 分 + 持续异常 2 分 = 15 分）
    "case1": {
        "zone-n": (35, 800, 0),    # 正常
        "zone-s": (40, 1600, 1),   # 通风不足风险（4 分）
        "zone-w": (160, 900, 2),   # 重度污染 + 拥挤
    },
    # D2 用例2：预期优先关注 zone-s（10+1=11 分 > zone-w 的 6+3=9 分）
    "case2": {
        "zone-n": (35, 800, 0),    # 正常
        "zone-s": (160, 700, 1),   # 重度污染
        "zone-w": (90, 1000, 2),   # 轻度污染 + 拥挤
    },
    # D2 用例3：全部正常 → 无优先关注区域
    "case3": {
        "zone-n": (35, 800, 0),
        "zone-s": (50, 900, 1),
        "zone-w": (45, 850, 1),
    },
}

# D3 剧本（zone-w 按 4 步推进，每一步自动生成新时间戳）：
#   步骤0：重度污染+拥挤 → 事件 OPEN（请在此期间点击「干预」按钮）
#   步骤1：轻度污染（改善仍异常）→ 保持 HANDLING，存入验证列表
#   步骤2：正常 ×1 → 连续正常计数 1
#   步骤3：正常 ×2 且人流 ≤1 → RECOVERED，事件归档
D3_SEQUENCE = [
    (160, 900, 2),
    (90, 1000, 1),
    (35, 800, 1),
    (30, 750, 0),
]


def calc_status(pm25, co2):
    """统一判级规则（与全端一致，颗粒物优先）：
    ①pm25>150→重度污染 ②pm25>75→轻度污染 ③co2≥1500→通风不足风险 ④其余→正常"""
    if pm25 > 150:
        return "重度污染"
    if pm25 > 75:
        return "轻度污染"
    if co2 >= 1500:
        return "通风不足风险"
    return "正常"


def build_payload(zone, pm25, co2, crowd_level):
    # 数据契约：zoneId（大写 I）、pm25、co2、crowdLevel、time
    # crowdLevel 保留 source 标记（任务书 D2 要求）：simulated 来源按 README 声明置信度 1.0
    return {
        "zoneId": zone,
        "pm25": pm25,
        "co2": co2,
        "crowdLevel": crowd_level,
        "crowdSource": "simulated",
        "crowdConfidence": 1.0,
        "time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    }


# ==================== D5 报告生成（纯 Python，无 pandas 依赖） ====================
D5_MIN_SAMPLES = 6   # 判定所需最少历史样本数（含当前值，统计用前 N-1 条）
D5_MULT = 2          # 标准差倍数

REPORT_CSS = """
body { font-family: "Microsoft YaHei", "Segoe UI", sans-serif; background:#eef1f5; color:#1f2937; margin:0; padding:24px; }
.wrap { max-width: 1200px; margin: 0 auto; }
h1 { font-size: 18px; color: #fff; margin: 0; }
.topbar { background: #0f172a; color: #e5e7eb; padding: 14px 24px; border-radius: 10px; margin-bottom: 16px; }
.topbar .sub { font-size: 12px; color: #94a3b8; margin-top: 4px; }
.panel { background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; padding: 16px; margin-bottom: 16px; box-shadow: 0 1px 3px rgba(0,0,0,.04); }
.panel-head { display: flex; justify-content: space-between; border-bottom: 1px solid #e5e7eb; padding-bottom: 10px; margin-bottom: 14px; flex-wrap: wrap; gap: 8px; }
.panel-head h2 { font-size: 15px; margin: 0; }
.meta { font-size: 12px; color: #6b7280; }
.cards-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 12px; }
.zone-card { border: 1px solid #e5e7eb; border-left: 4px solid #9ca3af; border-radius: 8px; padding: 12px; background: #f8fafc; }
.card-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.card-head b { font-size: 14px; }
.zone-id { font-size: 11px; color: #6b7280; font-family: Consolas, monospace; }
.tag { font-size: 12px; padding: 2px 10px; border-radius: 999px; color: #fff; margin-left: auto; white-space: nowrap; }
.tag.ok { background: #22c55e; }
.tag.bad { background: #ef4444; }
.tag.wait { background: #9ca3af; }
.rows { list-style: none; font-size: 13px; color: #374151; display: grid; gap: 4px; margin: 0; padding: 0; }
.rows .ml { color: #6d28d9; }
.rows .verdict { font-weight: 600; }
.rows .conflict { color: #c62828; }
.hist-wrap { margin-bottom: 16px; }
.hist-wrap h3 { font-size: 13px; color: #6b7280; margin: 0 0 6px; }
.hist-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.hist-table th, .hist-table td { border: 1px solid #e5e7eb; padding: 4px 8px; text-align: center; }
.hist-table th { background: #f8fafc; color: #6b7280; }
.hist-table .mismatch-row td { background: #fff8e6; }
.dirty-log { list-style: none; font-size: 12px; max-height: 220px; overflow-y: auto; margin: 0; padding: 0; }
.dirty-log li { padding: 4px 8px; border-bottom: 1px dashed #e5e7eb; color: #b45309; }
.dirty-log li.empty { color: #6b7280; }
.line-no { font-family: Consolas, monospace; color: #6b7280; margin-right: 8px; }
.case-list { display: grid; gap: 10px; }
.case-item { border: 1px solid #e5e7eb; border-left: 4px solid #f59e0b; border-radius: 8px; padding: 10px 12px; background: #fffbeb; }
.case-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.case-head b { font-size: 13px; }
.case-tag { font-size: 12px; padding: 2px 10px; border-radius: 999px; background: #f59e0b; color: #fff; white-space: nowrap; }
.case-seq { font-size: 12px; color: #6b7280; margin-left: auto; }
.case-row { font-size: 12.5px; color: #374151; line-height: 1.6; }
.case-row.cause { color: #92400e; }
.case-empty { font-size: 13px; color: #6b7280; padding: 4px 0; }
footer { text-align: center; color: #9ca3af; font-size: 12px; margin-top: 24px; }
"""


def _mean_std(vals):
    """样本均值与样本标准差（n≥2）"""
    n = len(vals)
    mean = sum(vals) / n
    var = sum((v - mean) ** 2 for v in vals) / (n - 1)
    return mean, math.sqrt(var)


def _case_tag(v):
    """案例条目差异类型标签（任务书 D5 案例留存）"""
    if v["ml"] == "数据积累中":
        return "ML 数据积累中（需继续积累）"
    ml_ab = v["ml"] == "与历史明显不同"
    rule_ab = v["rule"] == "环境异常"
    if rule_ab != ml_ab:
        return "规则/ML 判断不一致"
    return "两者一致（原因可解释）"


def _explain_case(v):
    """为一条判定自动匹配任务书 D5 的可能原因之一"""
    if v["ml"] == "数据积累中":
        return ("历史数据太少：该区域截至本条仅 %d 条有效记录（不足 %d 条），ML 尚无法建立统计基线，"
                "本条由固定规则独立裁决，建议继续积累数据后复核。" % (v["seq"], D5_MIN_SAMPLES))
    ml_ab = v["ml"] == "与历史明显不同"
    rule_ab = v["rule"] == "环境异常"
    if rule_ab and not ml_ab:
        return ("历史数据太单一 / 历史本身包含异常：该区域历史值长期贴近甚至略超规则限值，"
                "ML 学到的「常态」已包含异常，动态阈值（pm25 %s / co2 %s）随之失真；"
                "固定规则兜底报警，体现规则优先裁决的必要性。" % (v["pthr"], v["cthr"]))
    if ml_ab and not rule_ab:
        return ("当前环境模式已经变化：当前值显著高于历史基线（动态阈值 pm25 %s / co2 %s），"
                "但尚未触及固定限值（pm25>75 或 co2>1000），固定规则不报警，ML 捕捉到了相对偏离，"
                "建议人工核查是否有新增污染源或季节变化。" % (v["pthr"], v["cthr"]))
    if rule_ab and ml_ab:
        return "两者一致且原因清楚：当前值既超过固定限值、又显著偏离历史基线，规则与 ML 交叉确认，异常置信度高。"
    return "两者一致且原因清楚：当前值在固定限值与历史动态阈值之内，历史覆盖充分、常态未变，两套判定均维持正常。"


def generate_d5_report(csv_path, out_path):
    """读取本次运行记录的 CSV → D5 双判定（固定规则 + ML 动态阈值）→ 生成静态报告"""
    # ---- 读取 + 脏数据前置检查 ----
    dirty = []  # (line, zone, reason)
    pending = {z: [] for z in ZONES}  # zone → [(pm25, co2, time)]
    try:
        with open(csv_path, "rb") as f:
            raw = f.read()
        # 编码容错：文件被 Excel 另存为「Unicode 文本」（UTF-16，含 NUL 字节）时自动识别；
        # 残余 NUL 兜底清理，保证任何情况下都能读出记录
        if b"\x00" in raw:
            text = raw.decode("utf-16", errors="ignore")
        else:
            text = raw.decode("utf-8-sig", errors="ignore")
        text = text.replace("\x00", "")
        reader = csv.reader(io.StringIO(text))
        header = next(reader, None)
        if not header:
            print("[sensor_sim] 记录文件为空，未生成报告")
            return
        for line_no, row in enumerate(reader, start=2):
                if len(row) < 6:
                    continue
                zone, pm25_s, co2_s, crowd_s, status_s, time_s = row[:6]
                zone = (zone or "").strip()
                time_s = (time_s or "").strip()
                if zone not in ZONES:
                    dirty.append((line_no, zone or "—", "zoneId 非法取值"))
                    continue
                if pm25_s == "" or co2_s == "":
                    dirty.append((line_no, zone, "pm25/co2 为空或缺失，报文丢弃"))
                    continue
                try:
                    p = float(pm25_s)
                    c = float(co2_s)
                except ValueError:
                    dirty.append((line_no, zone, "pm25/co2 非数值，报文丢弃"))
                    continue
                if p > 900:
                    dirty.append((line_no, zone, "pm25=%s 超出量程（>900），离群脏数据不参与计算" % p))
                    continue
                if not time_s:
                    dirty.append((line_no, zone, "time 字段缺失，不更新历史数据"))
                    continue
                rows = pending[zone]
                if rows and time_s < rows[-1][2]:
                    dirty.append((line_no, zone, "时间倒流（%s < %s），不更新历史数据" % (time_s, rows[-1][2])))
                    continue
                rows.append((p, c, time_s))
    except Exception as e:
        print("[sensor_sim] 报告生成失败（读取记录）:", e)
        return

    # ---- D5 双判定（固定规则 + ML 统计动态阈值，规则优先裁决） ----
    cards_html = []
    tables_html = []
    cases = []  # 案例留存条目：(zone_cn, zone, tag, verdict, cause)
    total_valid = 0
    span_min = span_max = None

    for zone in ZONES:
        rows = pending[zone]
        verdicts = []
        ph, ch = [], []
        for p, c, t in rows:
            rule = "环境异常" if (p > 75 or c > 1000) else "正常"
            ph.append(p)
            ch.append(c)
            ml = "数据积累中"
            pthr = cthr = None
            if len(ph) >= D5_MIN_SAMPLES:
                m1, s1 = _mean_std(ph[:-1])  # 统计用历史（不含当前值）
                m2, s2 = _mean_std(ch[:-1])
                pthr = round(m1 + D5_MULT * s1, 1)
                cthr = round(m2 + D5_MULT * s2, 1)
                ml = "与历史明显不同" if (p > pthr or c > cthr) else "符合历史常态"
            mismatch = (rule == "环境异常") != (ml == "与历史明显不同")
            verdicts.append({
                "seq": len(verdicts) + 1, "time": t, "pm25": p, "co2": c,
                "rule": rule, "ml": ml, "mismatch": mismatch, "pthr": pthr, "cthr": cthr,
            })
            if span_min is None or t < span_min:
                span_min = t
            if span_max is None or t > span_max:
                span_max = t
        total_valid += len(verdicts)

        # 区域卡片（取最新一条判定）
        if not verdicts:
            cards_html.append(
                '<div class="zone-card"><div class="card-head"><b>%s</b>'
                '<span class="zone-id">%s</span><span class="tag wait">无有效数据</span></div></div>'
                % (ZONE_CN[zone], zone))
        else:
            v = verdicts[-1]
            tag_cls = "bad" if v["mismatch"] else "ok"
            tag_txt = "Δ结论不一致" if v["mismatch"] else "一致"
            if v["ml"] == "数据积累中":
                ml_line = "ML 判定：数据积累中（%d/%d 条）" % (len(verdicts), D5_MIN_SAMPLES)
            else:
                ml_line = "ML 判定：%s（pm25 %s vs 阈值 %s；co2 %s vs 阈值 %s）" % (
                    v["ml"], v["pm25"], v["pthr"], v["co2"], v["cthr"])
            verdict_txt = ("综合裁决（规则优先）：环境异常，建议按异常处置"
                           if v["rule"] == "环境异常" else "综合裁决（规则优先）：正常，维持常规监测")
            if v["mismatch"]:
                verdict_txt += "；<span class='conflict'>两套结论不一致，建议人工复核</span>"
            cards_html.append(
                '<div class="zone-card">'
                '<div class="card-head"><b>%s</b><span class="zone-id">%s</span>'
                '<span class="tag %s">%s</span></div>'
                '<ul class="rows">'
                '<li>当前 PM2.5 / CO₂：%s / %s（%s）</li>'
                '<li>固定规则：%s（pm25&gt;75 或 co2&gt;1000 为异常）</li>'
                '<li class="ml">%s</li>'
                '<li class="verdict">%s</li>'
                '</ul></div>'
                % (ZONE_CN[zone], zone, tag_cls, tag_txt,
                   v["pm25"], v["co2"], v["time"], v["rule"], ml_line, verdict_txt))

        # 历史表格（最多显示最近 100 条，序号从 1 开始）
        if verdicts:
            shown = verdicts[-100:]
            start_seq = len(verdicts) - len(shown) + 1
            rows_html = "".join(
                '<tr class="%s"><td>%d</td><td>%s</td><td>%s</td><td>%s</td>'
                '<td>%s</td><td>%s</td><td>%s</td></tr>' % (
                    "mismatch-row" if v["mismatch"] else "",
                    start_seq + i, v["time"], v["pm25"], v["co2"],
                    v["rule"], v["ml"], "⚠不一致" if v["mismatch"] else "一致")
                for i, v in enumerate(shown))
            tables_html.append(
                '<div class="hist-wrap"><h3>%s（%s）· 共 %d 条</h3>'
                '<table class="hist-table"><tr><th>序号</th><th>time</th><th>PM2.5</th>'
                '<th>CO₂</th><th>固定规则</th><th>ML判定</th><th>一致性</th></tr>%s</table></div>'
                % (ZONE_CN[zone], zone, len(verdicts), rows_html))

            # 案例留存：优先保留「不一致」条目（最近 3 条）；无不一致时保留最近 1 条「一致但可解释」
            zone_cases = [v for v in verdicts if v["mismatch"]] or [verdicts[-1]]
            for v in zone_cases[-3:]:
                cases.append((ZONE_CN[zone], zone, _case_tag(v), v, _explain_case(v)))

    # ---- 案例分析板块（任务书 D5：至少保留 1 个说明规则与 ML 差异的案例并说明可能原因）----
    case_html_parts = []
    for zone_cn, zone, tag, v, cause in cases[:6]:
        case_html_parts.append(
            '<div class="case-item">'
            '<div class="case-head"><b>%s（%s）</b><span class="case-tag">%s</span>'
            '<span class="case-seq">第 %d 条 · %s</span></div>'
            '<div class="case-row">数据 pm25=%s / co2=%s ｜ 固定规则：%s ｜ ML：%s'
            '（动态阈值 pm25 %s / co2 %s）｜ 裁决：规则优先 → %s%s</div>'
            '<div class="case-row cause">可能原因：%s</div></div>'
            % (zone_cn, zone, tag, v["seq"], v["time"],
               v["pm25"], v["co2"], v["rule"], v["ml"],
               v["pthr"] if v["pthr"] is not None else "—",
               v["cthr"] if v["cthr"] is not None else "—",
               "环境异常，按异常处置" if v["rule"] == "环境异常" else "正常，维持常规监测",
               "（两套结论不一致，建议人工复核）" if v["mismatch"] else "",
               cause))
    cases_html = ("".join(case_html_parts)
                  if case_html_parts
                  else '<div class="case-empty">暂无有效数据，无法形成案例。运行 sensor_sim 并 Ctrl+C 停止后自动生成。</div>')

    dirty_html = ("".join(
        '<li><span class="line-no">行 %d</span>%s：%s</li>' % (ln, ZONE_CN.get(zone, "区域[" + zone + "]"), reason)
        for ln, zone, reason in dirty)
        if dirty else '<li class="empty">暂无脏数据记录</li>')

    page = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AirGuard D5 判定报告 · sensor_sim 运行记录</title>
<style>{css}</style>
</head>
<body>
<div class="wrap">
<div class="topbar">
  <h1>AirGuard D5 判定报告（sensor_sim 运行记录）</h1>
  <div class="sub">固定安全规则 + ML 统计动态阈值 双判定 · 按 Ctrl+C 停止时自动生成，每次运行替换上一份数据</div>
</div>

<div class="panel">
  <div class="panel-head">
    <h2>各区域判定卡片</h2>
    <span class="meta">生成时间：{gen_time} ｜ 有效记录 {valid} 条 ｜ 脏数据 {dirty_n} 条 ｜ 数据区间 {span_min} ~ {span_max}</span>
  </div>
  <div class="cards-grid">{cards}</div>
</div>

<div class="panel">
  <div class="panel-head">
    <h2>案例分析：规则 vs ML 判断依据差异（本次保留 {case_n} 例）</h2>
    <span class="meta">任务书 D5：每份报告至少保留 1 个说明规则与 ML 差异的案例并说明可能原因；优先保留不一致案例，无不一致时保留「一致但可解释」案例</span>
  </div>
  <div class="case-list">{case_list}</div>
</div>

<div class="panel">
  <div class="panel-head"><h2>历史数据表格（含逐条判定，最多显示最近 100 条）</h2></div>
  {tables}
</div>

<div class="panel">
  <div class="panel-head"><h2>脏数据日志</h2></div>
  <ul class="dirty-log">{dirty_list}</ul>
</div>

<footer>AirGuard D5 · 报告由 sensor_sim 停止时自动生成，样式与监测台统一 · 再次运行并停止即替换为新数据</footer>
</div>
</body>
</html>""".format(
        css=REPORT_CSS,
        gen_time=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        valid=total_valid,
        dirty_n=len(dirty),
        span_min=span_min or "—",
        span_max=span_max or "—",
        cards="".join(cards_html),
        tables="".join(tables_html),
        dirty_list=dirty_html,
        case_n=min(len(cases), 6),
        case_list=cases_html,
    )

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(page)
    print("[sensor_sim] D5 报告已生成: %s" % os.path.abspath(out_path))


# ==================== 主流程 ====================
def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "normal"
    if mode != "d3" and mode != "clear" and mode not in SCENARIOS:
        print("用法: python sensor_sim.py [normal|case1|case2|case3|d3|clear]")
        sys.exit(1)
    base = SCENARIOS.get(mode, SCENARIOS["normal"])

    # 兼容 paho-mqtt 1.x / 2.x 两种 Client 构造方式
    if hasattr(mqtt, "CallbackAPIVersion"):
        client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION1, client_id="airguard-sensor-sim")
    else:
        client = mqtt.Client(client_id="airguard-sensor-sim")

    client.connect(BROKER_HOST, BROKER_PORT, 60)
    client.loop_start()

    # clear 模式：向三个区域主题发布空消息（retain），清除保留数据后退出
    if mode == "clear":
        for zone in ZONES:
            client.publish(TOPIC.format(zone=zone), "", qos=0, retain=True)
            print("[sensor_sim] 已清除保留消息:", TOPIC.format(zone=zone))
        client.disconnect()
        print("[sensor_sim] 清除完成，页面刷新后显示「暂无数据」")
        return

    # 本次运行记录文件（每次运行覆盖上一份；Ctrl+C 后据此生成 D5 报告）
    records_f = open(RECORDS_CSV, "w", newline="", encoding="utf-8-sig")
    records_w = csv.writer(records_f)
    records_w.writerow(["zoneId", "pm25", "co2", "crowdLevel", "status", "time"])

    def publish_row(zone, pm25, co2, crowd):
        payload = build_payload(zone, pm25, co2, crowd)
        client.publish(TOPIC.format(zone=zone), json.dumps(payload), qos=0, retain=True)
        # 同步记录到本地 CSV（status 用统一判级规则计算，供报告使用）
        records_w.writerow([zone, pm25, co2, crowd, calc_status(pm25, co2), payload["time"]])
        print("[%s] %s -> %s" % (
            datetime.now().strftime("%H:%M:%S"), TOPIC.format(zone=zone),
            json.dumps(payload, ensure_ascii=False)))

    print("[sensor_sim] 场景=%s broker=%s:%s 周期=%ss retain=True（Ctrl+C 停止后自动生成 D5 报告）" %
          (mode, BROKER_HOST, BROKER_PORT, INTERVAL))

    try:
        step = 0
        while True:
            if mode == "d3":
                # D3 剧本：zone-w 按 4 步序列推进，zone-n / zone-s 保持正常
                pm25, co2, crowd = D3_SEQUENCE[step % len(D3_SEQUENCE)]
                publish_row("zone-w", pm25, co2, crowd)
                print("[D3 步骤 %d/4]" % (step % len(D3_SEQUENCE) + 1))
                for zone in ("zone-n", "zone-s"):
                    p, c, k = base[zone]
                    publish_row(zone, max(5, p + random.randint(-3, 3)),
                                max(400, c + random.randint(-30, 30)), k)
                step += 1
            else:
                for zone, (pm25, co2, crowd) in base.items():
                    p, c, k = pm25, co2, crowd
                    if mode == "normal":
                        # 健康值附近轻微波动，保持状态为正常
                        p = max(5, pm25 + random.randint(-3, 3))
                        c = max(400, co2 + random.randint(-30, 30))
                    publish_row(zone, p, c, k)
            time.sleep(INTERVAL)
    except KeyboardInterrupt:
        print("\n[sensor_sim] 已停止，正在生成 D5 报告...")
        records_f.close()
        client.disconnect()
        generate_d5_report(RECORDS_CSV, REPORT_PATH)
        print("[sensor_sim] 记录文件: %s" % os.path.abspath(RECORDS_CSV))


if __name__ == "__main__":
    main()
