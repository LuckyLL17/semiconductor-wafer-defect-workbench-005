import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import './styles.css';

type ReviewState='unreviewed'|'confirmed'|'false_positive';
type Defect={
  id:string;x:number;y:number;size:number;
  kind:string;severity:string;score:number;
  step:string;tool:string;lot:string;
  review:ReviewState;note:string;
};

class ApiError extends Error{
  constructor(public status:number,message:string){super(message)}
}

async function api<T=any>(url:string,init?:RequestInit):Promise<T>{
  const res=await fetch(url,init);
  let body:any=null;
  try{body=await res.json();}catch{/* 非 JSON 响应 */}
  if(!res.ok)throw new ApiError(res.status,body?.error||`请求失败（${res.status}）`);
  return body as T;
}

const KIND_LABELS:Record<string,string>={
  particle:'颗粒',scratch:'划痕',void:'空洞',edge:'边缘',cluster:'聚类',
};
const SEVERITY_LABELS:Record<string,string>={low:'低',medium:'中',high:'高'};
const REVIEW_LABELS:Record<ReviewState,string>={
  unreviewed:'待复核',confirmed:'已确认',false_positive:'误报',
};
// 详情必须具备的字段；缺失则视为服务端记录不完整
const REQUIRED_FIELDS:Array<keyof Defect>=['id','x','y','size','kind','severity','score','step','tool','lot','review','note'];

function isDefect(v:any):v is Defect{
  return !!v&&typeof v==='object'&&REQUIRED_FIELDS.every(k=>v[k]!==null&&v[k]!==undefined&&v[k]!=='');
}

export default function App(){
  const [tab,setTab]=useState('map');
  const [summary,setSummary]=useState<any>();
  const [spatial,setSpatial]=useState<any>();
  const [window,setWindow]=useState<any>();

  // 地图与复核队列共用同一份缺陷接口记录
  const [defects,setDefects]=useState<Defect[]>([]);
  const [defectsLoading,setDefectsLoading]=useState(true);
  const [defectsError,setDefectsError]=useState('');

  // 筛选结果只来自服务端
  const [severityFilter,setSeverityFilter]=useState('all');
  const [queue,setQueue]=useState<Defect[]>([]);
  const [queueLoading,setQueueLoading]=useState(false);
  const [queueError,setQueueError]=useState('');

  const [selected,setSelected]=useState<Defect>();
  const [note,setNote]=useState('');
  const [detailError,setDetailError]=useState('');
  const [actionError,setActionError]=useState('');
  const [actionInfo,setActionInfo]=useState('');
  const [saving,setSaving]=useState(false);
  const selectSeq=useRef(0);

  const loadSummary=useCallback(()=>api('/api/wafer/current').then(setSummary),[]);
  const loadDefects=useCallback(async()=>{
    setDefectsLoading(true);setDefectsError('');
    try{
      const list=await api<Defect[]>('/api/defects');
      setDefects(Array.isArray(list)?list:[]);
    }catch{
      setDefectsError('缺陷记录加载失败，地图暂不可用，请重试');
    }finally{setDefectsLoading(false)}
  },[]);
  const loadQueue=useCallback(async(severity:string)=>{
    setQueueLoading(true);setQueueError('');
    try{
      const qs=severity==='all'?'':`?severity=${encodeURIComponent(severity)}`;
      const list=await api<Defect[]>(`/api/defects${qs}`);
      // 筛选只显示服务端匹配结果，不再做本地兜底
      setQueue(Array.isArray(list)?list:[]);
    }catch{
      setQueue([]);
      setQueueError('服务端筛选失败，未返回匹配缺陷，请重试');
    }finally{setQueueLoading(false)}
  },[]);

  useEffect(()=>{
    loadSummary();
    api('/api/analysis/spatial').then(setSpatial);
    api('/api/analysis/process-window').then(setWindow);
    loadDefects();
  },[loadSummary,loadDefects]);

  useEffect(()=>{loadQueue(severityFilter)},[severityFilter,loadQueue]);

  // 切回复核页时重新拉取当前筛选，保证队列与服务端一致
  useEffect(()=>{if(tab==='review')loadQueue(severityFilter)},[tab,severityFilter,loadQueue]);

  const mergeDefect=useCallback((d:Defect)=>{
    setDefects(prev=>{
      const i=prev.findIndex(x=>x.id===d.id);
      if(i<0)return [d,...prev];
      const next=prev.slice();next[i]=d;return next;
    });
    setQueue(prev=>prev.map(x=>x.id===d.id?d:x));
  },[]);

  // 选中缺陷：先用共用记录定位，再以服务端详情为准；任何失败都保留当前选择
  const pickDefect=useCallback(async(id:string)=>{
    const local=defects.find(d=>d.id===id)??queue.find(d=>d.id===id);
    const seq=++selectSeq.current;
    if(local&&(!selected||selected.id!==id)){
      setSelected(local);setNote(local.note??'');setDetailError('');
    }
    setActionError('');setActionInfo('');
    try{
      const fresh=await api<Defect>(`/api/defects/${encodeURIComponent(id)}`);
      if(seq!==selectSeq.current)return;
      if(isDefect(fresh)){
        setSelected(fresh);setNote(fresh.note??'');setDetailError('');
        mergeDefect(fresh);
      }else{
        setDetailError('该缺陷详情不完整，以下为已获取的信息，仍可继续处理');
      }
    }catch(e){
      if(seq!==selectSeq.current)return;
      if(e instanceof ApiError&&e.status===404){
        setDetailError(`缺陷 ${id} 在服务端不存在，当前选择已保留，可继续选择其他缺陷`);
      }else{
        setDetailError('缺陷详情加载失败，当前选择已保留，可重试或继续处理其他缺陷');
      }
    }
  },[defects,queue,selected,mergeDefect]);

  const submitReview=useCallback(async(decision:ReviewState)=>{
    if(!selected||saving)return;
    setSaving(true);setActionError('');setActionInfo('');
    try{
      const updated=await api<Defect>(`/api/defects/${encodeURIComponent(selected.id)}/review`,{
        method:'POST',
        headers:{'content-type':'application/json'},
        body:JSON.stringify({review:decision,note}),
      });
      // 成功后同步：当前选择、地图、队列、顶部统计
      if(isDefect(updated)){
        setSelected(updated);setNote(updated.note??'');mergeDefect(updated);
      }else{
        setSelected({...selected,review:decision,note});
      }
      setActionInfo(decision==='confirmed'?'已确认为真实缺陷':'已标记为误报');
      await Promise.all([loadQueue(severityFilter),loadSummary()]);
    }catch(e){
      // 提交失败保留当前选择与备注，允许重试或继续处理
      if(e instanceof ApiError&&e.status===404){
        setActionError(`缺陷 ${selected.id} 已不存在，提交未生效，当前选择已保留`);
      }else{
        setActionError('复核提交失败，当前选择与备注已保留，请重试');
      }
    }finally{setSaving(false)}
  },[selected,saving,note,mergeDefect,loadQueue,severityFilter,loadSummary]);

  const detailIncomplete=useMemo(()=>selected?!REQUIRED_FIELDS.every(k=>selected[k]!==null&&selected[k]!==undefined&&selected[k]!==''):false,[selected]);

  return <main>
    <header>
      <div>
        <span className="eyebrow">FAB PROCESS INTELLIGENCE / LOT REVIEW</span>
        <h1>晶圆缺陷空间分布与工艺窗口分析工作台</h1>
        <p>晶圆 {summary?.wafer?.id??'加载中'} · {summary?.wafer?.product} · {summary?.wafer?.layer}</p>
      </div>
      <div className="status">在线 · 数据质量 98.4%</div>
    </header>
    <nav>{[['map','空间缺陷地图'],['window','工艺窗口'],['review','缺陷复核']].map(([id,label])=>
      <button key={id} className={tab===id?'active':''} onClick={()=>setTab(id)}>{label}</button>
    )}</nav>
    {summary&&<section className="metrics">
      <Metric label="缺陷总数" value={summary.summary.defectCount}/>
      <Metric label="高风险" value={summary.summary.highRisk}/>
      <Metric label="聚类" value={summary.summary.clusterCount}/>
      <Metric label="已确认" value={summary.summary.confirmed}/>
    </section>}

    {tab==='map'&&<section className="grid2">
      <div className="panel waferPanel">
        <div className="panelHead"><h2>300mm 晶圆缺陷分布</h2><span>自动检测 + 空间聚类</span></div>
        {defectsError&&<div className="alert error">{defectsError} <button onClick={loadDefects}>重试</button></div>}
        {defectsLoading&&!defects.length&&<div className="empty">缺陷坐标加载中…</div>}
        {!defectsError&&!!defects.length&&<svg viewBox="0 0 100 100" className="wafer">
          <circle cx="50" cy="50" r="47"/>
          <circle cx="50" cy="50" r="42" className="notch"/>
          {defects.map(d=><circle
            key={d.id}
            cx={d.x} cy={d.y}
            r={.7+Math.max(0,d.size)*.9}
            className={`${d.severity==='high'?'high':d.severity==='medium'?'medium':'low'} ${d.review==='false_positive'?'fp':''} ${selected?.id===d.id?'selected':''}`}
            onClick={()=>pickDefect(d.id)}
          />)}
        </svg>}
        <div className="legend">
          <span className="dot high"/>高风险 <span className="dot medium"/>中风险 <span className="dot low"/>低风险
        </div>
        {selected&&<div className="mapHint">已选中 {selected.id}（{KIND_LABELS[selected.kind]??selected.kind}），可前往「缺陷复核」处理</div>}
      </div>
      <div className="panel">
        <div className="panelHead"><h2>空间热点聚类</h2><span>按网格与线性缺陷聚类</span></div>
        {(spatial?.clusters??[]).slice(0,8).map((c:any)=><div className="cluster" key={c.id}>
          <div><b>{c.id}</b><small>{c.kind} · {c.tool}</small></div>
          <strong>{c.count} <small>点</small></strong>
          <i className={c.maxSeverity}>{c.maxSeverity}</i>
        </div>)}
      </div>
    </section>}

    {tab==='window'&&<section className="grid2">
      <div className="panel">
        <div className="panelHead"><h2>工艺窗口与设备关联</h2><span>按设备统计实际批次</span></div>
        {window?.window.map((x:any)=><div className="windowRow" key={x.tool}>
          <b>{x.tool}</b>
          <span>平均良率 {x.meanYield}%</span>
          <span>温度 {x.temperature.min}—{x.temperature.max}°C</span>
          <span>压力 {x.pressure.min}—{x.pressure.max} Torr</span>
          <em>{x.recommended.length?'推荐窗口':'无稳定窗口'}</em>
        </div>)}
      </div>
      <div className="panel">
        <div className="panelHead"><h2>因子相关性</h2><span>跨批次分析</span></div>
        {window?.correlations.map((x:any)=><div className="corr" key={x.factor}>
          <div><b>{x.factor} → {x.metric}</b><small>{x.interpretation}</small></div>
          <strong className={x.coefficient<0?'negative':''}>{x.coefficient}</strong>
        </div>)}
      </div>
    </section>}

    {tab==='review'&&<section className="grid2">
      <div className="panel">
        <div className="panelHead">
          <h2>缺陷复核队列</h2>
          <select value={severityFilter} onChange={e=>setSeverityFilter(e.target.value)}>
            <option value="all">全部</option>
            <option value="high">高风险</option>
            <option value="medium">中风险</option>
          </select>
        </div>
        {queueLoading&&<div className="empty">服务端筛选中…</div>}
        {!queueLoading&&queueError&&<div className="alert error">{queueError} <button onClick={()=>loadQueue(severityFilter)}>重试</button></div>}
        {!queueLoading&&!queueError&&!queue.length&&<div className="empty">当前筛选没有服务端匹配的缺陷</div>}
        {!queueError&&queue.map(d=><div
          key={d.id}
          className={`defectRow ${selected?.id===d.id?'active':''}`}
          onClick={()=>pickDefect(d.id)}
        >
          <b>{d.id}</b>
          <span>{KIND_LABELS[d.kind]??d.kind}</span>
          <span className={`sev ${d.severity}`}>{SEVERITY_LABELS[d.severity]??d.severity}</span>
          <span>置信度 {Number(d.score).toFixed(2)}</span>
          <em className={`review ${d.review}`}>{REVIEW_LABELS[d.review as ReviewState]??d.review}</em>
        </div>)}
      </div>
      <div className="panel detail">
        {selected?<>
          <span className="eyebrow">DEFECT DETAIL / {selected.id}</span>
          <h2 className="detailTitle">
            {KIND_LABELS[selected.kind]??selected.kind} 缺陷候选
            <em className={`review ${selected.review}`}>{REVIEW_LABELS[selected.review as ReviewState]??selected.review}</em>
          </h2>
          {detailError&&<div className="alert error">{detailError}</div>}
          {!detailError&&detailIncomplete&&<div className="alert warn">缺陷详情不完整，缺失字段以下划线占位，仍可继续处理</div>}
          {actionError&&<div className="alert error">{actionError}</div>}
          {actionInfo&&<div className="alert ok">{actionInfo}</div>}
          <p>检测置信度 {Number(selected.score).toFixed(2)}，当前等级 {SEVERITY_LABELS[selected.severity]??selected.severity}</p>
          <div className="infoGrid">
            <Info label="坐标 X" value={selected.x}/>
            <Info label="坐标 Y" value={selected.y}/>
            <Info label="类型" value={KIND_LABELS[selected.kind]??selected.kind}/>
            <Info label="工艺步骤" value={selected.step}/>
            <Info label="检测设备" value={selected.tool}/>
            <Info label="批次" value={selected.lot}/>
            <Info label="严重度" value={SEVERITY_LABELS[selected.severity]??selected.severity}/>
            <Info label="置信度" value={Number(selected.score).toFixed(2)}/>
          </div>
          <label className="noteLabel">备注（随确认/误报一并提交）</label>
          <textarea value={note} onChange={e=>setNote(e.target.value)} placeholder="输入复核备注…"/>
          <div className="actions">
            <button disabled={saving} onClick={()=>submitReview('confirmed')}>{saving?'提交中…':'确认缺陷'}</button>
            <button className="ghost" disabled={saving} onClick={()=>submitReview('false_positive')}>标记误报</button>
          </div>
        </>:<div className="empty">选择一个缺陷查看检测证据与复核操作</div>}
      </div>
    </section>}
  </main>;
}

function Info({label,value}:{label:string;value:unknown}){
  const missing=value===null||value===undefined||value==='';
  return <div className="infoItem"><small>{label}</small><strong className={missing?'missing':''}>{missing?'—':String(value)}</strong></div>;
}

function Metric({label,value}:{label:string;value:any}){
  return <div className="metric"><small>{label}</small><strong>{value}</strong></div>;
}
