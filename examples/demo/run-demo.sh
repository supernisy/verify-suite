#!/usr/bin/env bash
# 最小 demo 一键运行：
#   起一个独立的 headless 浏览器 → 三条路线各跑一遍 → 截图
# 浏览器不常驻，本脚本结束即退出；用的是独立 profile，不碰你正在用的浏览器。
#
# 用法: bash examples/demo/run-demo.sh
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT" || exit 1

# 本机有 http_proxy，Node 的 fetch 会去连代理导致 127.0.0.1 不通
export no_proxy="127.0.0.1,localhost" NO_PROXY="127.0.0.1,localhost"
export VERIFY_CDP_HOST=127.0.0.1 VERIFY_CDP_PORT=9222

EDGE="${VERIFY_EDGE:-C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe}"
PROFILE="${VERIFY_PROFILE:-C:/Users/super/AppData/Local/Temp/vs-profile}"
BASE="file:///$(cygpath -m "$ROOT")/examples/demo"
OUT="examples/demo/out"
mkdir -p "$OUT" docs

# --- 1. 起浏览器（脚本结束自动收掉） ---------------------------------------
if ! curl -s --noproxy '*' -m 1 http://127.0.0.1:9222/json/version >/dev/null 2>&1; then
  "$EDGE" --remote-debugging-port=9222 --user-data-dir="$PROFILE" \
    --no-first-run --no-default-browser-check --headless=new about:blank \
    >/dev/null 2>&1 &
  EDGE_PID=$!
  trap 'kill $EDGE_PID 2>/dev/null' EXIT
  for _ in $(seq 1 40); do
    curl -s --noproxy '*' -m 1 http://127.0.0.1:9222/json/version >/dev/null 2>&1 && break
    sleep 0.5
  done
  echo "浏览器已启动 (pid=$EDGE_PID, headless, 独立 profile)"
else
  echo "复用已运行的 9222 调试实例"
fi
echo

# --- 2. 路线 B：语义指纹对齐（零配置，只要 URL） ---------------------------
echo "########## 路线 B · 语义指纹对齐 ##########"
node scripts/ax-collect.mjs --url "$BASE/demo.html" --side expected --out "$OUT/ax-demo.json" >/dev/null
node scripts/ax-collect.mjs --url "$BASE/prod.html" --side actual   --out "$OUT/ax-prod.json" >/dev/null
node scripts/ax-diff.mjs "$OUT/ax-demo.json" "$OUT/ax-prod.json" --label-exp 设计稿 --label-act 产线
echo "退出码=$?"
echo

# --- 3. 路线 A：人工探针精确卡尺 -------------------------------------------
echo "########## 路线 A · 探针几何比对 ##########"
node scripts/geo-collect.mjs --url "$BASE/demo.html" --probes examples/demo/probes.json \
  --side expected --out "$OUT/geo-demo.json" >/dev/null
node scripts/geo-collect.mjs --url "$BASE/prod.html" --probes examples/demo/probes.json \
  --side actual --out "$OUT/geo-prod.json" >/dev/null
node scripts/geo-compare.mjs "$OUT/geo-demo.json" "$OUT/geo-prod.json" \
  examples/demo/probes.json --label-exp 设计稿 --label-act 产线
echo "退出码=$?"
echo

# --- 4. 交互还原：同一份断言两侧各跑一遍 -----------------------------------
echo "########## 交互还原 · 轨迹两侧各自对照同一份断言 ##########"
node scripts/trace-run.mjs --url "$BASE/demo.html" --trace examples/demo/trace.json \
  --side expected --out "$OUT/tr-demo.json" >/dev/null
node scripts/trace-run.mjs --url "$BASE/prod.html" --trace examples/demo/trace.json \
  --side actual --out "$OUT/tr-prod.json" >/dev/null
node scripts/trace-diff.mjs "$OUT/tr-demo.json" "$OUT/tr-prod.json"
echo "退出码=$?"
echo

# --- 5. 截图 ---------------------------------------------------------------
echo "########## 截图 ##########"
node examples/demo/shot.mjs "$BASE/demo.html" docs/demo.png
node examples/demo/shot.mjs "$BASE/prod.html" docs/prod.png
node examples/demo/shot.mjs "$BASE/demo.html" docs/demo-clicked.png "[data-testid=btn-new]"
node examples/demo/shot.mjs "$BASE/prod.html" docs/prod-clicked.png "[data-testid=btn-new]"
echo
echo "产物: docs/*.png  中间数据: $OUT/"
