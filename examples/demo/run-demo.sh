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

# --- 4.5 路线 E：行为契约（视觉一模一样也可能行为不同） --------------------
echo "########## 路线 E · 行为契约（埋点/请求/响应结构） ##########"
node scripts/behavior-collect.mjs --url "$BASE/demo.html" --behavior examples/demo/behavior.json \
  --side expected --out "$OUT/bh-demo.json"
node scripts/behavior-collect.mjs --url "$BASE/prod.html" --behavior examples/demo/behavior.json \
  --side actual --out "$OUT/bh-prod.json"
node scripts/behavior-diff.mjs "$OUT/bh-demo.json" "$OUT/bh-prod.json" \
  --behavior examples/demo/behavior.json --label-exp 设计稿 --label-act 产线
echo "退出码=$?"
echo

# --- 5. 截图 ---------------------------------------------------------------
echo "########## 截图 ##########"
node examples/demo/shot.mjs "$BASE/demo.html" docs/demo.png
node examples/demo/shot.mjs "$BASE/prod.html" docs/prod.png
node examples/demo/shot.mjs "$BASE/demo.html" docs/demo-clicked.png "[data-testid=btn-new]"
node examples/demo/shot.mjs "$BASE/prod.html" docs/prod-clicked.png "[data-testid=btn-new]"
# --- 6. 自检：空采集必须判执行错误(1)，绝不落为无差异(0) ------------------
# 这是 P0-1 的验收用例：检测器必须先证明自己在工作。
# 全绿但检测器其实没采集到任何东西，是最危险的假阳性。
echo "########## 自检 · 空结果 = 执行错误(退出码 1) ##########"
SELF_PASS=0; SELF_FAIL=0
check_exit() {
  local label="$1" want="$2" got="$3"
  if [ "$got" = "$want" ]; then
    echo "  PASS  $label  退出码=$got (期望 $want)"; SELF_PASS=$((SELF_PASS + 1))
  else
    echo "  FAIL  $label  退出码=$got (期望 $want)"; SELF_FAIL=$((SELF_FAIL + 1))
  fi
}

# 6.1 采集器：指向空白页，必须判执行错误
node scripts/ax-collect.mjs   --url "$BASE/blank.html" --side expected \
  --out "$OUT/ax-blank.json" >/dev/null 2>&1
check_exit "ax-collect   空白页" 1 "$?"
node scripts/unit-collect.mjs --url "$BASE/blank.html" --side expected \
  --out "$OUT/unit-blank.json" >/dev/null 2>&1
check_exit "unit-collect 空白页" 1 "$?"
node scripts/geo-collect.mjs --url "$BASE/blank.html" --probes examples/demo/probes.json \
  --side expected --out "$OUT/geo-blank.json" >/dev/null 2>&1
check_exit "geo-collect  空白页" 1 "$?"

# 6.2 比对器：任一侧输入为空，必须判执行错误
printf '{"side":"expected","items":[]}' > "$OUT/empty-a.json"
printf '{"side":"actual","items":[]}'   > "$OUT/empty-b.json"
printf '{"side":"expected","steps":[]}' > "$OUT/empty-tr.json"
node scripts/ax-diff.mjs "$OUT/empty-a.json" "$OUT/empty-b.json" >/dev/null 2>&1
check_exit "ax-diff      空输入" 1 "$?"
node scripts/geo-compare.mjs "$OUT/empty-a.json" "$OUT/empty-b.json" \
  examples/demo/probes.json >/dev/null 2>&1
check_exit "geo-compare  空输入" 1 "$?"
node scripts/trace-diff.mjs "$OUT/empty-tr.json" "$OUT/empty-tr.json" >/dev/null 2>&1
check_exit "trace-diff   空输入" 1 "$?"

# 路线 E 同样适用：目标不存在 / 全程零观测 = 采集失败，不是"没有行为"
node scripts/behavior-collect.mjs --url "$BASE/blank.html" \
  --behavior examples/demo/behavior.json --side expected \
  --out "$OUT/bh-blank.json" >/dev/null 2>&1
check_exit "behavior-collect 空白页" 1 "$?"
printf '{"side":"expected","steps":[]}' > "$OUT/empty-bh.json"
node scripts/behavior-diff.mjs "$OUT/empty-bh.json" "$OUT/empty-bh.json" \
  --behavior examples/demo/behavior.json >/dev/null 2>&1
check_exit "behavior-diff 空输入" 1 "$?"

# P2-6 无进展检测：连点 3 次无反应的按钮，应判「卡住」中止而不是跑完出假结论
node scripts/trace-run.mjs --url "$BASE/demo.html" \
  --trace examples/demo/trace-no-progress.json --side expected \
  --out "$OUT/tr-noprog.json" >/dev/null 2>&1
check_exit "trace-run 无进展中止" 1 "$?"

echo
echo "自检结果: $SELF_PASS 通过 / $SELF_FAIL 失败"
echo "产物: docs/*.png  中间数据: $OUT/"
[ "$SELF_FAIL" -eq 0 ] || { echo "!!! 自检未通过：检测器可能把空结果当成了无差异"; exit 1; }
