import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import './styles.css';

type ReviewState = 'unreviewed' | 'confirmed' | 'false_positive';
type Defect = {
  id: string;
  x: number;
  y: number;
  size: number;
  kind: string;
  severity: string;
  score: number;
  step: string;
  tool: string;
  lot: string;
  review: ReviewState | string;
  note: string;
};

type SeverityFilter = 'all' | 'high' | 'medium' | 'low';
type ReviewFilter = 'all' | ReviewState;

type ApiError = {error?: string; id?: string; message?: string};

const KIND_LABELS: Record<string, string> = {
  particle: '颗粒',
  scratch: '划痕',
  void: '空洞',
  edge: '边缘',
  cluster: '簇缺陷',
};
const SEVERITY_LABELS: Record<string, string> = {high: '高', medium: '中', low: '低'};
const REVIEW_LABELS: Record<string, string> = {
  unreviewed: '待复核',
  confirmed: '已确认',
  false_positive: '误报',
};

const kindLabel = (kind: string) => KIND_LABELS[kind] ?? kind;
const severityLabel = (severity: string) => SEVERITY_LABELS[severity] ?? severity;
const reviewLabel = (review: string) => REVIEW_LABELS[review] ?? review;

/** 详情必须对应真实缺陷；缺少任一关键字段即视为详情不完整，只能继续处理而不伪造数据。 */
const REQUIRED_FIELDS: Array<keyof Defect> = [
  'id', 'x', 'y', 'kind', 'severity', 'score', 'step', 'tool', 'lot', 'review', 'note',
];
function isCompleteDefect(d: any): d is Defect {
  if (!d || typeof d !== 'object') return false;
  return REQUIRED_FIELDS.every((f) => {
    const v = d[f];
    if (f === 'note') return typeof v === 'string';
    return v !== undefined && v !== null && v !== '';
  });
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error((body as ApiError).error || `HTTP ${res.status}`), {body});
  return body as T;
}

function buildDefectQuery(severity: SeverityFilter, review: ReviewFilter) {
  const params = new URLSearchParams();
  if (severity !== 'all') params.set('severity', severity);
  if (review !== 'all') params.set('review', review);
  const qs = params.toString();
  return qs ? `/api/defects?${qs}` : '/api/defects';
}

export default function App() {
  const [tab, setTab] = useState('map');
  const [wafer, setWafer] = useState<any>();
  const [spatial, setSpatial] = useState<any>();
  const [processWindow, setProcessWindow] = useState<any>();

  // 地图与复核队列共用同一份来自 /api/defects 的记录
  const [defects, setDefects] = useState<Defect[]>([]);
  const [defectsLoading, setDefectsLoading] = useState(true);
  const [defectsError, setDefectsError] = useState<string>();

  // 筛选全部由服务端完成，前端不做本地兜底匹配
  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>('all');
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>('all');

  const [selected, setSelected] = useState<Defect>();
  const [noteDraft, setNoteDraft] = useState('');
  const [detailError, setDetailError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  const loadSeq = useRef(0);

  const loadDefects = useCallback(async () => {
    const seq = ++loadSeq.current;
    setDefectsLoading(true);
    setDefectsError(undefined);
    try {
      const list = await request<Defect[]>(buildDefectQuery(severityFilter, reviewFilter));
      if (seq !== loadSeq.current) return; // 被更新的筛选请求取代
      setDefects(Array.isArray(list) ? list : []);
      if (selected) {
        const refreshed = (Array.isArray(list) ? list : []).find((d) => d.id === selected.id);
        if (refreshed) setSelected(refreshed);
      }
    } catch (e: any) {
      if (seq !== loadSeq.current) return;
      // 拉取失败时保留当前已加载记录与当前选择，允许继续处理
      setDefectsError(e?.body?.error || '缺陷列表加载失败，保留当前结果');
    } finally {
      if (seq === loadSeq.current) setDefectsLoading(false);
    }
  }, [severityFilter, reviewFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  const refreshSummary = useCallback(async () => {
    try {
      setWafer(await request('/api/wafer/current'));
    } catch {
      /* 统计刷新失败不阻断复核流程 */
    }
  }, []);

  useEffect(() => {
    request('/api/wafer/current').then(setWafer).catch(() => {});
    request('/api/analysis/spatial').then(setSpatial).catch(() => {});
    request('/api/analysis/process-window').then(setProcessWindow).catch(() => {});
  }, []);

  useEffect(() => {
    loadDefects();
  }, [loadDefects]);

  const selectDefect = useCallback((d: Defect) => {
    setDetailError(undefined);
    if (!isCompleteDefect(d)) {
      // 缺陷不存在 / 详情不完整：保留选择并提示，仍允许继续处理
      setDetailError('该缺陷记录详情不完整，请核对后再确认或标记误报。');
    }
    setSelected(d);
    setNoteDraft(typeof d.note === 'string' ? d.note : '');
  }, []);

  const submitReview = useCallback(
    async (review: 'confirmed' | 'false_positive') => {
      if (!selected || submitting) return;
      setSubmitting(true);
      setDetailError(undefined);
      try {
        const updated = await request<Defect>(`/api/defects/${encodeURIComponent(selected.id)}/review`, {
          method: 'POST',
          headers: {'content-type': 'application/json'},
          body: JSON.stringify({review, note: noteDraft}),
        });
        // 成功后地图、队列、顶部统计同步更新
        setDefects((prev) => prev.map((d) => (d.id === updated.id ? updated : d)));
        setSelected(updated);
        setNoteDraft(updated.note ?? '');
        await Promise.all([loadDefects(), refreshSummary()]);
      } catch (e: any) {
        // 缺陷不存在 / 提交失败：保留当前选择与已输入备注，允许继续处理
        const code = e?.body?.error;
        setDetailError(
          code === 'defect_not_found'
            ? '该缺陷在服务端不存在，复核未提交，当前选择已保留。'
            : code === 'invalid_review'
              ? '复核动作无效，提交未完成。'
              : '复核提交失败，当前选择已保留，可重试或继续处理其他缺陷。',
        );
      } finally {
        setSubmitting(false);
      }
    },
    [selected, noteDraft, submitting, loadDefects, refreshSummary],
  );

  const summary = wafer?.summary;

  return (
    <main>
      <header>
        <div>
          <span className="eyebrow">FAB PROCESS INTELLIGENCE / LOT REVIEW</span>
          <h1>晶圆缺陷空间分布与工艺窗口分析工作台</h1>
          <p>
            晶圆 {wafer?.wafer?.id ?? '加载中'} · {wafer?.wafer?.product} · {wafer?.wafer?.layer}
          </p>
        </div>
        <div className="status">在线 · 数据质量 98.4%</div>
      </header>
      <nav>
        {[['map', '空间缺陷地图'], ['window', '工艺窗口'], ['review', '缺陷复核']].map(([id, label]) => (
          <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </nav>

      {summary && (
        <section className="metrics">
          <Metric label="缺陷总数" value={summary.defectCount} />
          <Metric label="高风险" value={summary.highRisk} />
          <Metric label="聚类" value={summary.clusterCount} />
          <Metric label="已确认" value={summary.confirmed} />
        </section>
      )}

      {defectsError && <div className="banner warning">{defectsError}</div>}

      {tab === 'map' && (
        <section className="grid2">
          <div className="panel waferPanel">
            <div className="panelHead">
              <h2>300mm 晶圆缺陷分布</h2>
              <span>
                {defectsLoading
                  ? '服务端筛选中…'
                  : `服务端匹配 ${defects.length} 个缺陷 · 点击圆点查看真实详情`}
              </span>
            </div>
            <svg viewBox="0 0 100 100" className="wafer">
              <circle cx="50" cy="50" r="47" />
              <circle cx="50" cy="50" r="42" className="notch" />
              {defects.map((d) => {
                const complete = isCompleteDefect(d);
                return (
                  <circle
                    key={d.id}
                    cx={d.x}
                    cy={d.y}
                    r={Math.max(0.7, Math.min(2, d.size))}
                    className={[
                      complete ? d.severity : 'incomplete',
                      `r-${complete ? d.review : 'unreviewed'}`,
                      selected?.id === d.id ? 'selected' : '',
                    ].join(' ')}
                    onClick={() => selectDefect(d)}
                  >
                    <title>
                      {`${d.id} · ${kindLabel(d.kind)} · ${severityLabel(d.severity)}风险 · 置信度 ${d.score ?? '-'}`}
                    </title>
                  </circle>
                );
              })}
            </svg>
            <div className="legend">
              <span className="dot high" />高风险 <span className="dot medium" />中风险 <span className="dot low" />低风险
              <span className="dot review-confirmed" />已确认 <span className="dot review-false" />误报
            </div>
          </div>
          <div className="panel">
            {selected ? (
              <DefectDetail
                defect={selected}
                note={noteDraft}
                onNoteChange={setNoteDraft}
                error={detailError}
                submitting={submitting}
                onConfirm={() => submitReview('confirmed')}
                onFalsePositive={() => submitReview('false_positive')}
                onBack={() => setSelected(undefined)}
              />
            ) : (
              <>
                <div className="panelHead">
                  <h2>空间热点聚类</h2>
                  <span>按网格与线性缺陷聚类</span>
                </div>
                {spatial?.clusters?.slice(0, 8).map((c: any) => (
                  <div className="cluster" key={c.id}>
                    <div>
                      <b>{c.id}</b>
                      <small>{kindLabel(c.kind)} · {c.tool}</small>
                    </div>
                    <strong>{c.count} <small>点</small></strong>
                    <i className={c.maxSeverity}>{severityLabel(c.maxSeverity)}</i>
                  </div>
                ))}
              </>
            )}
          </div>
        </section>
      )}

      {tab === 'window' && (
        <section className="grid2">
          <div className="panel">
            <div className="panelHead">
              <h2>工艺窗口与设备关联</h2>
              <span>按设备统计实际批次</span>
            </div>
            {processWindow?.window?.map((x: any) => (
              <div className="windowRow" key={x.tool}>
                <b>{x.tool}</b>
                <span>平均良率 {x.meanYield}%</span>
                <span>温度 {x.temperature.min}—{x.temperature.max}°C</span>
                <span>压力 {x.pressure.min}—{x.pressure.max} Torr</span>
                <em>{x.recommended.length ? '推荐窗口' : '无稳定窗口'}</em>
              </div>
            ))}
          </div>
          <div className="panel">
            <div className="panelHead">
              <h2>因子相关性</h2>
              <span>跨批次分析</span>
            </div>
            {processWindow?.correlations?.map((x: any) => (
              <div className="corr" key={x.factor}>
                <div>
                  <b>{x.factor} → {x.metric}</b>
                  <small>{x.interpretation}</small>
                </div>
                <strong className={x.coefficient < 0 ? 'negative' : ''}>{x.coefficient}</strong>
              </div>
            ))}
          </div>
        </section>
      )}

      {tab === 'review' && (
        <section className="grid2">
          <div className="panel">
            <div className="panelHead filters">
              <h2>缺陷复核队列</h2>
              <div className="filterBar">
                <select value={severityFilter} onChange={(e) => setSeverityFilter(e.target.value as SeverityFilter)}>
                  <option value="all">全部严重度</option>
                  <option value="high">高风险</option>
                  <option value="medium">中风险</option>
                  <option value="low">低风险</option>
                </select>
                <select value={reviewFilter} onChange={(e) => setReviewFilter(e.target.value as ReviewFilter)}>
                  <option value="all">全部状态</option>
                  <option value="unreviewed">待复核</option>
                  <option value="confirmed">已确认</option>
                  <option value="false_positive">误报</option>
                </select>
              </div>
            </div>
            <div className="panelSub">
              {defectsLoading ? '正在加载服务端匹配结果…' : `仅显示服务端匹配的 ${defects.length} 条记录`}
            </div>
            {defects.map((d) => (
              <div
                key={d.id}
                className={`defectRow ${selected?.id === d.id ? 'active' : ''}`}
                onClick={() => selectDefect(d)}
              >
                <b>{d.id}</b>
                <span>{kindLabel(d.kind)}</span>
                <span className={`tag sev ${d.severity}`}>{severityLabel(d.severity)}</span>
                <span className="confidence">
                  置信度 {typeof d.score === 'number' ? d.score.toFixed(2) : '-'}
                  <small>
                    {d.step} · {d.tool} · {reviewLabel(String(d.review))}
                  </small>
                </span>
              </div>
            ))}
            {!defectsLoading && defects.length === 0 && (
              <div className="empty">服务端没有匹配当前筛选条件的缺陷</div>
            )}
          </div>
          <div className="panel detail">
            {selected ? (
              <DefectDetail
                defect={selected}
                note={noteDraft}
                onNoteChange={setNoteDraft}
                error={detailError}
                submitting={submitting}
                onConfirm={() => submitReview('confirmed')}
                onFalsePositive={() => submitReview('false_positive')}
              />
            ) : (
              <div className="empty">选择一个缺陷查看检测证据与复核操作</div>
            )}
          </div>
        </section>
      )}
    </main>
  );
}

function DefectDetail({
  defect,
  note,
  onNoteChange,
  error,
  submitting,
  onConfirm,
  onFalsePositive,
  onBack,
}: {
  defect: Defect;
  note: string;
  onNoteChange: (v: string) => void;
  error?: string;
  submitting: boolean;
  onConfirm: () => void;
  onFalsePositive: () => void;
  onBack?: () => void;
}) {
  const complete = isCompleteDefect(defect);
  const d = defect as any;
  return (
    <>
      <div className="detailHead">
        <span className="eyebrow">DEFECT DETAIL / {d.id}</span>
        {onBack && (
          <button className="linkBtn" onClick={onBack}>
            返回聚类列表
          </button>
        )}
      </div>
      <h2>{kindLabel(d.kind)} 缺陷候选</h2>
      <p>检测置信度 {typeof d.score === 'number' ? d.score.toFixed(2) : '-'}，当前等级 {severityLabel(d.severity)}</p>
      <div className="detailGrid">
        <div><small>坐标</small><strong>{d.x ?? '-'} , {d.y ?? '-'}</strong></div>
        <div><small>类型</small><strong>{kindLabel(d.kind)}</strong></div>
        <div><small>工艺步骤</small><strong>{d.step || '-'}</strong></div>
        <div><small>检测设备</small><strong>{d.tool || '-'}</strong></div>
        <div><small>批次</small><strong>{d.lot || '-'}</strong></div>
        <div><small>严重度</small><strong>{severityLabel(d.severity)}</strong></div>
        <div><small>置信度</small><strong>{typeof d.score === 'number' ? d.score.toFixed(2) : '-'}</strong></div>
        <div>
          <small>复核状态</small>
          <strong className={`tag review ${String(d.review)}`}>{reviewLabel(String(d.review))}</strong>
        </div>
      </div>
      {!complete && (
        <div className="banner warning">服务端返回的缺陷详情不完整，缺少部分字段；不会展示临时默认数据，可核对后继续处理。</div>
      )}
      {error && <div className="banner error">{error}</div>}
      <label className="noteLabel" htmlFor={`note-${d.id}`}>复核备注（随确认 / 误报一并提交）</label>
      <textarea
        id={`note-${d.id}`}
        value={note}
        onChange={(e) => onNoteChange(e.target.value)}
        disabled={submitting}
        placeholder="填写复核备注，将随确认或误报操作一起提交到服务端"
      />
      <div className="actions">
        <button onClick={onConfirm} disabled={submitting}>
          {submitting ? '提交中…' : '确认缺陷'}
        </button>
        <button className="ghost" onClick={onFalsePositive} disabled={submitting}>
          标记误报
        </button>
      </div>
    </>
  );
}

function Metric({label, value}: {label: string; value: any}) {
  return (
    <div className="metric">
      <small>{label}</small>
      <strong>{value}</strong>
    </div>
  );
}
