#!/usr/bin/env python3
# ============================================================
# AirGuard SQLite 持久化 + 统一事件审计 · db_recorder.py（黄色扩展项）
#
# 职责（纯附加，不影响三端 MQTT 演示）：
#   1. 订阅全部 MQTT 主题（只订阅，不发布）：
#        airguard/+/env        环境传感器报文 → sensor_history 表 + event_audit(sensor_data)
#        airguard/e3/focus     切换重点区域指令 → event_audit(zone_focus_switch)
#        airguard/+/action     标记处理中指令 → event_audit(event_handling)
#        airguard/e3/event     标记已恢复指令 → event_audit(event_recovered)
#   2. SQLite 单文件库 airguard.db（自动建库建表，无需手动执行 SQL）
#   3. 简易 HTTP 只读查询接口（供 web/index.html 历史与审计面板调用，CORS 开放）：
#        GET /api/sensorHistory?zoneId=zone-w[&limit=100]
#        GET /api/eventAudit?limit=20
#   注意：本脚本停止后整套 AirGuard 三端监测 / E3 回执照常运行，不受影响。
#
# 用法：
#   pip install paho-mqtt
#   python db_recorder.py          # Ctrl+C 停止
# ============================================================
import json
import os
import sqlite3
import threading
import time
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import paho.mqtt.client as mqtt

BROKER_HOST = "127.0.0.1"
BROKER_PORT = 1883          # mosquitto 默认 TCP 端口
HTTP_HOST = "0.0.0.0"       # 局域网可访问（只读查询）
HTTP_PORT = 8090

_BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(_BASE_DIR, "airguard.db")

ZONES = ("zone-n", "zone-s", "zone-w")
ZONE_CN = {"zone-n": "宿舍区", "zone-s": "教学区", "zone-w": "食堂区"}

_db_lock = threading.Lock()  # MQTT 写入线程与 HTTP 查询线程共用一把锁


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


def now_str():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


# ==================== SQLite（自动建库建表） ====================

def init_db():
    conn = sqlite3.connect(DB_PATH)
    # 表1：区域感知历史表
    conn.execute(
        """CREATE TABLE IF NOT EXISTS sensor_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            zoneId TEXT NOT NULL,
            pm25 REAL,
            co2 REAL,
            crowdLevel INTEGER,
            status TEXT,
            receive_time TEXT NOT NULL
        )"""
    )
    # 表2：统一事件 & 操作审计表（记录所有跨端操作与事件生命周期）
    conn.execute(
        """CREATE TABLE IF NOT EXISTS event_audit (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_type TEXT NOT NULL,
            zoneId TEXT,
            source TEXT NOT NULL,
            content TEXT,
            extra_json TEXT,
            op_time TEXT NOT NULL
        )"""
    )
    conn.commit()
    conn.close()


def db_exec(sql, params=()):
    """写操作：每次新建连接（跨线程安全），由 _db_lock 串行化"""
    with _db_lock:
        conn = sqlite3.connect(DB_PATH)
        conn.execute(sql, params)
        conn.commit()
        conn.close()


def db_fetch(sql, params=()):
    """读操作：返回 [(col,...), ...]"""
    with _db_lock:
        conn = sqlite3.connect(DB_PATH)
        cur = conn.execute(sql, params)
        rows = cur.fetchall()
        conn.close()
        return rows


def insert_sensor(zone, pm25, co2, crowd, status, recv_time):
    db_exec(
        "INSERT INTO sensor_history (zoneId, pm25, co2, crowdLevel, status, receive_time) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (zone, pm25, co2, crowd, status, recv_time),
    )


def insert_audit(event_type, zone, source, content, extra):
    db_exec(
        "INSERT INTO event_audit (event_type, zoneId, source, content, extra_json, op_time) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (event_type, zone, source, content, json.dumps(extra, ensure_ascii=False), now_str()),
    )


# ==================== MQTT 订阅与落库 ====================

def source_of(payload):
    """操作来源判定：小程序下发的指令带 mp- 前缀 msgId；其余（Web / MQTTX 手发）记为 web"""
    msg_id = str(payload.get("msgId") or "")
    return "miniprogram" if msg_id.startswith("mp-") else "web"


def src_cn(source):
    return "小程序" if source == "miniprogram" else "Web"


def on_connect(client, userdata, flags, rc):
    topics = ("airguard/+/env", "airguard/+/action", "airguard/e3/focus", "airguard/e3/event")
    for t in topics:
        client.subscribe(t)
    print("[db_recorder] MQTT 已连接，已订阅: %s" % ", ".join(topics))


def on_message(client, userdata, msg):
    topic = msg.topic
    try:
        payload = json.loads(msg.payload.decode("utf-8")) if msg.payload else {}
    except Exception:
        print("[db_recorder] 非 JSON 报文，忽略:", topic)
        return
    if not isinstance(payload, dict):
        return

    if topic.startswith("airguard/e3/focus"):
        # 切换重点区域 / 恢复规则判定
        z = str(payload.get("zoneId") or "")
        source = source_of(payload)
        extra = {"msgId": payload.get("msgId", ""), "zoneId": z}
        if z in ZONES:
            insert_audit("zone_focus_switch", z, source,
                         "%s切换重点区域到%s（%s）" % (src_cn(source), ZONE_CN[z], z), extra)
        else:
            insert_audit("zone_focus_switch", "", source,
                         "%s恢复规则判定重点区域" % src_cn(source), extra)
        print("[db_recorder] 审计: focus zone=%s source=%s" % (z or "（恢复规则）", source))

    elif topic.startswith("airguard/e3/event"):
        z = str(payload.get("zoneId") or "")
        op = str(payload.get("op") or "")
        source = source_of(payload)
        extra = {"msgId": payload.get("msgId", ""), "zoneId": z,
                 "oldState": "HANDLING", "newState": "RECOVERED"}
        if op == "recovered":
            insert_audit("event_recovered", z, source,
                         "%s将%s标记为已恢复（%s）" % (src_cn(source), ZONE_CN.get(z, z), z), extra)
            print("[db_recorder] 审计: recovered zone=%s source=%s" % (z, source))
        elif op == "handling":
            extra.update({"oldState": "OPEN", "newState": "HANDLING"})
            insert_audit("event_handling", z, source,
                         "%s将%s标记为处理中（%s）" % (src_cn(source), ZONE_CN.get(z, z), z), extra)
            print("[db_recorder] 审计: handling zone=%s source=%s" % (z, source))

    elif "/action" in topic:
        z = str(payload.get("zoneId") or (topic.split("/")[1] if len(topic.split("/")) > 1 else ""))
        source = source_of(payload)
        action = str(payload.get("action") or "干预")
        insert_audit("event_handling", z, source,
                     "%s将%s标记为处理中：%s" % (src_cn(source), ZONE_CN.get(z, z), action),
                     {"msgId": payload.get("msgId", ""), "zoneId": z, "action": action,
                      "oldState": "OPEN", "newState": "HANDLING"})
        print("[db_recorder] 审计: action zone=%s source=%s" % (z, source))

    elif "/env" in topic:
        # 环境传感器报文：写 sensor_history，同时写一条 sensor_data 审计记录
        z = str(payload.get("zoneId") or payload.get("zoneid") or "")
        if z not in ZONES:
            return
        try:
            pm25 = float(payload.get("pm25"))
            co2 = float(payload.get("co2"))
        except (TypeError, ValueError):
            print("[db_recorder] env 报文 pm25/co2 非数值，忽略:", topic)
            return
        crowd = payload.get("crowdLevel")
        status = calc_status(pm25, co2)
        recv_time = str(payload.get("time") or now_str())
        insert_sensor(z, pm25, co2, crowd, status, recv_time)
        insert_audit("sensor_data", z, "sensor_sim",
                     "%s 环境数据上报：PM2.5=%s CO₂=%s 人流L%s %s" % (
                         ZONE_CN[z], pm25, co2, crowd if crowd is not None else "—", status),
                     {"pm25": pm25, "co2": co2, "crowdLevel": crowd, "status": status})


# ==================== 简易 HTTP 只读查询接口 ====================

class ApiHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        qs = parse_qs(parsed.query)

        if parsed.path == "/api/sensorHistory":
            zone = (qs.get("zoneId") or [""])[0]
            try:
                limit = min(max(int((qs.get("limit") or ["100"])[0]), 1), 500)
            except ValueError:
                limit = 100
            rows = db_fetch(
                "SELECT id, zoneId, pm25, co2, crowdLevel, status, receive_time "
                "FROM sensor_history WHERE zoneId = ? ORDER BY id DESC LIMIT ?",
                (zone, limit),
            )
            rows = list(reversed(rows))  # 返回给前端按时间升序（画图用）
            data = [{"id": r[0], "zoneId": r[1], "pm25": r[2], "co2": r[3],
                     "crowdLevel": r[4], "status": r[5], "receive_time": r[6]} for r in rows]
            self._json({"ok": True, "zoneId": zone, "count": len(data), "data": data})

        elif parsed.path == "/api/eventAudit":
            try:
                limit = min(max(int((qs.get("limit") or ["20"])[0]), 1), 500)
            except ValueError:
                limit = 20
            rows = db_fetch(
                "SELECT id, event_type, zoneId, source, content, extra_json, op_time "
                "FROM event_audit ORDER BY id DESC LIMIT ?",
                (limit,),
            )
            data = [{"id": r[0], "event_type": r[1], "zoneId": r[2], "source": r[3],
                     "content": r[4], "extra_json": r[5], "op_time": r[6]} for r in rows]
            self._json({"ok": True, "count": len(data), "data": data})

        else:
            self._json({"ok": False, "error": "not found"}, status=404)

    def _json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")  # file:// 页面 fetch 需要 CORS
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        pass  # 静默 HTTP 访问日志，避免刷屏


# ==================== 主流程 ====================

def main():
    print("[db_recorder] SQLite 数据库: %s" % os.path.abspath(DB_PATH))
    init_db()
    print("[db_recorder] 数据表已就绪: sensor_history / event_audit")

    httpd = ThreadingHTTPServer((HTTP_HOST, HTTP_PORT), ApiHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    print("[db_recorder] HTTP 查询接口: http://127.0.0.1:%d/api/sensorHistory?zoneId=zone-w" % HTTP_PORT)
    print("[db_recorder] HTTP 查询接口: http://127.0.0.1:%d/api/eventAudit?limit=20" % HTTP_PORT)

    # 兼容 paho-mqtt 1.x / 2.x 两种 Client 构造方式
    if hasattr(mqtt, "CallbackAPIVersion"):
        client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION1, client_id="airguard-db-recorder")
    else:
        client = mqtt.Client(client_id="airguard-db-recorder")
    client.on_connect = on_connect
    client.on_message = on_message
    client.connect(BROKER_HOST, BROKER_PORT, 60)
    client.loop_start()

    print("[db_recorder] 运行中（broker=%s:%s）… Ctrl+C 停止。停止不影响三端 MQTT 监测与 E3 回执。" %
          (BROKER_HOST, BROKER_PORT))
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        client.disconnect()
        print("\n[db_recorder] 已停止。历史数据已保存在 %s，重启脚本后继续累加。" % os.path.abspath(DB_PATH))


if __name__ == "__main__":
    main()
