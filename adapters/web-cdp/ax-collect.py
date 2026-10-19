#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""通用 AX 采集轻量骨架（verify-suite · 驱动层 adapter: web-cdp）【主适配器】

Web / 浏览器场景的轻量骨架，与 adapters/ax-native/ax-collect.py 同构，
但走 CDP / Accessibility 语义树（AX）而非原生 UIA。

这是 verify-suite 的**主适配器**：浏览器是立身之本（scripts/ax-collect.mjs 是
生产级实现）。本文件只做"可移植骨架"，演示「枚举/富化分离 + 超集采集门 +
无静默降级 + 完整性断言」的通用结构，目标特定逻辑以 TODO 标注。

生产实现请直接用 verify-suite 自带：
    node scripts/ax-collect.mjs --url <url> --out <file>
它已具备：Accessibility.getFullAXTree → 语义指纹 role|norm(name) →
视觉度量 → 降级链主键，与本骨架的判定层完全对齐。

无浏览器时可用 `python ax-collect.py --demo` 打印 schema 示例，验证结构正确。

设计灵魂（与 ax-native 一致，仅感知通道换成 CDP/AX）：
  1) 需求驱动: 只序列化需求字段；AX 已含文字就不截图。
  2) 确定性 + 可溯源: AX 为 ground truth；截图补位标 confidence=medium。
  3) 两遍分离: 枚举遍只读 AX 不截图（快且全）；富化遍仅 AX 盲区字段截图。
  4) 超集采集门: 语义 role 命中 OR 名称含日期时间；被过滤节点进账本。
  5) 完整性断言: 去重 + 已知总数比对；空/缺 = 执行错误，不是"完成"。
"""
from __future__ import annotations
import argparse
import collections
import json
import os
import re
import time

ROOT = os.path.dirname(os.path.abspath(__file__))

# ---------------------------------------------------------------------------
# 采集门（超集，禁止白名单静默丢行）
# 浏览器侧用"语义 role"判定（W3C accname 已由浏览器算好名字，对页面零侵入）。
# ---------------------------------------------------------------------------
SEMANTIC_ROLES = {
    "button", "link", "menuitem", "menuitemcheckbox", "menuitemradio",
    "tab", "textbox", "heading", "checkbox", "radio", "switch",
    "combobox", "listbox", "option", "searchbox", "slider", "spinbutton",
    "navigation", "main", "banner", "contentinfo", "region",
    "form", "group", "article", "section", "toolbar", "menu", "menubar",
    "tablist", "table", "row", "grid", "tree", "list", "listitem",
    "alert", "dialog", "tooltip", "img", "figure", "separator", "status",
}
DT_RE = re.compile(r"(20\d{2})[-/年.](\d{1,2})[-/月.](\d{1,2})[日\s]*(\d{1,2}):(\d{2})")


def collection_gate(role: str, name: str) -> bool:
    """超集门：语义 role 命中 OR 名称含日期时间，二者满足其一即收录。"""
    if role in SEMANTIC_ROLES:
        return True
    if DT_RE.search(name or ""):
        return True
    return False


# ---------------------------------------------------------------------------
# CDP 会话（目标特定 TODO：接 WebSocket）
# ---------------------------------------------------------------------------
class CdpSession:
    """最小 CDP 封装。TODO(目标特定): 用 WebSocket 连 debugger 端点。

    生产实现见 scripts/lib/cdp.mjs（零依赖，Node>=22 原生 WebSocket）。
    本骨架只定义接口，便于非 Node 环境移植。
    """

    def __init__(self, host: str = "127.0.0.1", port: int = 9222):
        self.host = host
        self.port = port
        self._ws = None  # TODO: websocket-client / 原生 ws

    def connect(self):
        # TODO(目标特定):
        #   import websocket  # pip install websocket-client
        #   targets = json.load(urlopen(f"http://{host}:{port}/json"))
        #   ws_url = next(t["webSocketDebuggerUrl"] for t in targets if t["type"]=="page")
        #   self._ws = websocket.create_connection(ws_url)
        raise NotImplementedError("目标特定逻辑未实现：接入 CDP WebSocket（见 scripts/lib/cdp.mjs）。")

    def send(self, method: str, params: dict | None = None):
        # TODO(目标特定): 发命令、收结果
        raise NotImplementedError("目标特定逻辑未实现：CDP send。")


# ---------------------------------------------------------------------------
# 枚举遍：只读 AX，不截图，快且全
# ---------------------------------------------------------------------------
def read_ax(session: CdpSession) -> tuple[list[dict], collections.Counter]:
    """取完整 AX 树 → 过滤语义 role / 日期时间 → 结构化条目。

    返回 (items, filtered_roles)。被采集门过滤的节点角色进账本，绝不静默丢弃。
    """
    out, filtered = [], collections.Counter()
    # TODO(目标特定): ax = session.send("Accessibility.getFullAXTree")
    #   for n in ax["nodes"]:
    #       if n.get("ignored"): continue
    #       role = n["role"]["value"]; name = n.get("name", {}).get("value", "")
    #       if not collection_gate(role, name):
    #           filtered[role] += 1; continue
    #       # 浏览器天然有 role + accname，主键直接 role|norm(name)
    #       out.append({... "source":"ax-tree","confidence":"high" ...})
    return out, filtered


def sweep_enum(session: CdpSession) -> list[dict]:
    """枚举遍：整页 AX 一次取全（Web 多为整页树，无需像原生虚拟列表那样逐屏滚）。

    若目标页面是**无限滚动 / 虚拟列表**（如聊天流、长表格），则需：
      滚到底 → read_ax → 去重 → 再滚 → 直到首/末节点签名稳定（settle 思想）。
    同步纪律：滚动后等 AX 树重新稳定再读，不截图。
    """
    records = {}
    items, _ = read_ax(session)
    for it in items:
        records.setdefault(it["sig"], it)
    # TODO(目标特定): 若是虚拟列表，循环滚动直到稳定（见 ax-native 的 sweep_enum）。
    return list(records.values())


# ---------------------------------------------------------------------------
# 富化遍：仅 AX 盲区字段截图，带 degradation
# ---------------------------------------------------------------------------
def enrich_blind_fields(records: list[dict], session: CdpSession) -> tuple[list[dict], dict]:
    """对 AX 拿不到的字段（如头像图、纯视觉状态）截图补位，medium，记 degradation。

    同步纪律：settle(等 AX 稳定) → 取该节点 DOM 几何 → 截帧（方向前缀避免覆盖）。
    候选优先用 AX 几何（Set-of-Marks 思想），不要靠固定像素框猜。
    """
    has_blind = any(r.get("needsEnrich") for r in records)
    degradation = {
        "blindFieldsInAX": not has_blind,
        "reason": "AX 树无头像/纯视觉字段时，靠截图补位（medium）。",
        "filteredRoles": [],
    }
    # TODO(目标特定):
    #   for rec in records:
    #       if rec.get("needsEnrich"):
    #           rect = session.send("DOM.getBoxModel", {"nodeId": rec["nodeId"]})
    #           frame = session.send("Page.captureScreenshot", {"clip": rect})
    #           rec["blind"] = {"source":"screenshot","confidence":"medium",
    #                           "evidence":{"frame":...,"method":"som-id|pixel-stats"}}
    return records, degradation


# ---------------------------------------------------------------------------
# 完整性断言
# ---------------------------------------------------------------------------
def assert_integrity(msgs: list[dict], expected: int | None = None):
    """去重 + 已知总数比对。空/缺 = 执行错误，不是"完成"。"""
    sigs = [m["sig"] for m in msgs]
    dedup = len(sigs) == len(set(sigs))
    count_ok = (expected is None) or (len(msgs) == expected)
    if not (dedup and count_ok):
        raise AssertionError(
            f"完整性断言失败: 去重={dedup} 期望数={expected} 实得={len(msgs)}"
        )


# ---------------------------------------------------------------------------
# 输出 schema
# ---------------------------------------------------------------------------
def build_serialized(target: str, windows: dict, frames: list, degradation: dict) -> dict:
    return {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "target": target,
        "adapter": "web-cdp",
        "windows": windows,
        "frames": frames,
        "degradation": degradation,
    }


def demo():
    """无浏览器时打印 schema 示例，验证结构正确。"""
    sample = [
        {"sig": "row|候选人A · 2026-10-18 21:39", "role": "row",
         "name": "候选人A · 2026-10-18 21:39", "body": "候选人A", "time": "2026-10-18 21:39",
         "rect": {"left": 0, "top": 100, "right": 720, "bottom": 140},
         "dtKey": [2026, 10, 18, 21, 39], "contentType": "text",
         "source": "ax-tree", "confidence": "high"},
    ]
    deg = {"blindFieldsInAX": True, "reason": "示例：无盲区字段", "filteredRoles": []}
    return build_serialized("AcmeHR Web(示例)",
                            {"W0": {"title": "候选人沟通记录", "rect": {}, "count": 1, "messages": sample}},
                            [], deg)


# ---------------------------------------------------------------------------
# Playwright 变体（直接调用 Playwright 官方库，零侵入替换 CDP）
# 仅骨架：演示 API 等价映射；生产实现见 scripts/ax-collect-pw.mjs。
# 需要: pip install playwright && playwright install chromium
# ---------------------------------------------------------------------------
class PlaywrightDriver:
    """语义定位 + strict / auto-wait 交互 / web-first 可重试断言 / trace。

    等价于 JS 引擎:
      get_ax_tree -> page.accessibility.snapshot()
      locate      -> page.get_by_role(role, name=...)  (strict 默认开)
      click/fill  -> locator.click()/fill()  (自带 actionability 等待)
      assert_*    -> expect(locator).to_be_visible()  (@playwright/test)
      trace       -> context.tracing.start/stop()
      measure     -> locator.bounding_box() + evaluate(getComputedStyle)
    """

    def __init__(self, headless: bool = True, viewport: tuple = (1440, 900)):
        self.headless = headless
        self.viewport = viewport
        self._browser = None

    def launch(self):
        # TODO(目标特定): 接入 Playwright
        #   from playwright.sync_api import sync_playwright
        #   self._pw = sync_playwright().start()
        #   self._browser = self._pw.chromium.launch(headless=self.headless)
        #   ctx = self._browser.new_context(viewport={"width": self.viewport[0], "height": self.viewport[1]})
        #   self.page = ctx.new_page()
        raise NotImplementedError("目标特定逻辑未实现：接入 Playwright（见 scripts/ax-collect-pw.mjs）。")

    def get_ax_tree(self):
        # TODO: return self.page.accessibility.snapshot()
        raise NotImplementedError

    def locate(self, role: str, name: str | None = None):
        # TODO: return self.page.get_by_role(role, name=name)
        raise NotImplementedError

    def measure(self, locator):
        # TODO: return locator.bounding_box() 与 evaluate 取计算样式
        raise NotImplementedError


def main():
    ap = argparse.ArgumentParser(description="通用 Web/AX 采集轻量骨架 (web-cdp)")
    ap.add_argument("--demo", action="store_true", help="打印 schema 示例后退出")
    ap.add_argument("--url", default=None, help="目标页面 URL（需 CDP 调试端口）")
    ap.add_argument("--out", default="serialized.json")
    ap.add_argument("--expected", type=int, default=None, help="已知总数，用于完整性断言")
    a = ap.parse_args()
    if a.demo:
        print(json.dumps(demo(), ensure_ascii=False, indent=2))
        return
    if not a.url:
        raise SystemExit("--url 必填（或用 --demo 查看 schema）。")
    # TODO(目标特定): 接入 CDP 后：
    #   s = CdpSession(); s.connect()
    #   s.send("Page.enable"); s.send("Runtime.enable"); s.send("Accessibility.enable")
    #   s.send("Page.navigate", {"url": a.url});  # 等待 load
    #   msgs = sweep_enum(s)
    #   msgs, deg = enrich_blind_fields(msgs, s)
    #   assert_integrity(msgs, a.expected)
    #   out = build_serialized(a.url, {"W0": {"title":...,"count":len(msgs),"messages":msgs}}, frames, deg)
    #   json.dump(out, open(a.out,"w",encoding="utf-8"), ensure_ascii=False, indent=2)
    raise SystemExit("目标特定逻辑未实现：请在 TODO 处接入 CDP WebSocket（见 scripts/lib/cdp.mjs）。")


if __name__ == "__main__":
    main()
