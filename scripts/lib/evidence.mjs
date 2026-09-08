/**
 * 判据层 · 证据等级(Evidence Grading)
 *
 * P1-5:报告里的每一条结论都必须带「它是靠什么知道的」。
 * 没有证据等级的结论是危险的 —— 用像素比对得出的"有差异"和用计算样式得出的
 * "左边距差 4px",看起来都是"检出差异",可行动性差着一个量级。
 *
 * 档位从强到弱(对应 AGENTS.md §1.1 驱动层档位):
 *   computed-style  运行时计算样式 + 精确几何  —— 能归因、能定位到 1px
 *   ax-tree         无障碍树语义身份          —— 能归因,但拿不到精确几何
 *   text-skeleton   文案 + 网格位置推断        —— 能对齐,但没有语义身份
 *   network/console 行为事实                   —— 证明"做了什么",不证明"长什么样"
 *   pixel           像素                       —— 只知道有差异,无法归因
 *   none            没有证据                   —— 不配叫结论
 *
 * 规则:**一次比对的可信度 = 所有 item 里最低的那一档**(木桶效应)。
 * 分层约束:本文件不得 import scripts/lib/cdp.mjs。
 */

const EVIDENCE_RANK = {
    'computed-style': 5,
    'ax-tree': 4,
    'text-skeleton': 3,
    'network': 3,
    'console': 2,
    'pixel': 1,
    'none': 0,
};

const CONFIDENCE_RANK = { high: 3, medium: 2, low: 1 };

/**
 * 从若干份采集报告里汇总证据档位。
 * @param {Array<{items?: any[], evidence?: object, degradation?: object|null}>} docs
 * @returns {{ evidences: string[], minEvidence: string, minConfidence: string, degraded: Array<object>, line: string }}
 */
export function summarizeEvidence(docs) {
    const evidences = new Set();
    let minEvRank = Infinity, minConfRank = Infinity;
    const degraded = [];

    for (const d of docs) {
        // 报告级降级留痕(采集侧已经判定过)
        if (d?.degradation) degraded.push(d.degradation);

        // 报告级 evidence 摘要优先
        if (d?.evidence?.primary) evidences.add(d.evidence.primary);
        if (d?.evidence?.confidence) {
            minConfRank = Math.min(minConfRank, CONFIDENCE_RANK[d.evidence.confidence] ?? 1);
        }

        // item 级:逐条取最低档
        for (const it of d?.items ?? []) {
            if (it?.evidence) {
                evidences.add(it.evidence);
                minEvRank = Math.min(minEvRank, EVIDENCE_RANK[it.evidence] ?? 0);
            }
            if (it?.confidence) {
                minConfRank = Math.min(minConfRank, CONFIDENCE_RANK[it.confidence] ?? 1);
            }
        }
    }

    const minEvidence = minEvRank === Infinity
        ? 'none'
        : (Object.entries(EVIDENCE_RANK).find(([, r]) => r === minEvRank)?.[0] ?? 'none');
    const minConfidence = minConfRank === Infinity
        ? 'low'
        : (Object.entries(CONFIDENCE_RANK).find(([, r]) => r === minConfRank)?.[0] ?? 'low');

    return {
        evidences: [...evidences].filter(e => e !== 'none'),
        minEvidence,
        minConfidence,
        degraded,
        line: formatLine(minEvidence, minConfidence, degraded),
    };
}

function formatLine(minEvidence, minConfidence, degraded) {
    const ev = minEvidence === 'none' ? 'none(无证据)' : minEvidence;
    const downgraded = minConfidence !== 'high';
    let s = `证据档位: ${ev} · 可信度 ${minConfidence}${downgraded ? ' (降级)' : ''}`;
    if (degraded.length) {
        s += `\n  降级记录: ${degraded.map(d => `${d.from} → ${d.to}`).join(' | ')}`;
        for (const d of degraded) {
            if (d.reason) s += `\n    · ${d.reason}`;
        }
    }
    return s;
}
