'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';
type Row = Record<string, any>;
const names: Record<string,string> = { matter: '사건', organization: '회사', person: '자연인', group: '그룹' };
async function request(url: string, options?: RequestInit) {
  const res = await fetch(url, options); const data = await res.json() as Row;
  if (!res.ok) throw new Error(data.error || '요청을 처리하지 못했습니다.'); return data;
}
function post(url: string, body: unknown) { return request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
function viewUrl(type: string, id: string) { return `/wiki?type=${encodeURIComponent(type)}&id=${encodeURIComponent(id)}`; }

export default function WikiPage() {
  const [entities,setEntities] = useState<Row[]>([]), [type,setType] = useState('matter'), [selected,setSelected] = useState(''), [detail,setDetail] = useState<Row|null>(null);
  const [query,setQuery] = useState(''), [notice,setNotice] = useState(''), [busy,setBusy] = useState(false), [version,setVersion] = useState(0), [evidence,setEvidence] = useState<Row|null>(null);
  const [editing,setEditing] = useState<Row|null>(null), [content,setContent] = useState(''), [entryDate,setEntryDate] = useState(() => new Date(Date.now()+9*3600_000).toISOString().slice(0,10));
  const [note,setNote] = useState('');
  const loadList = useCallback(async (q = '') => { const data = await request(`/api/wiki?q=${encodeURIComponent(q)}`); setEntities(data.entities); return data.entities as Row[]; }, []);
  const loadDetail = useCallback(async (t: string, id: string) => {
    const data = await request(`/api/wiki/${t}/${id}`); setDetail(data); setNote(data.entity.note || ''); setEvidence(null); return data;
  }, []);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const initialType = params.get('type') || 'matter';
    setType(names[initialType] ? initialType : 'matter');
    const initialQuery = params.get('q') || '';
    setQuery(initialQuery);
    loadList(initialQuery).then(list => setSelected(params.get('id') || list.find(e => e.type === initialType)?.id || '')).catch(e => setNotice(e.message));
  }, [loadList]);
  useEffect(() => { let cancelled = false; setDetail(null); if (selected) request(`/api/wiki/${type}/${selected}`).then(data => { if (!cancelled) { setDetail(data); setNote(data.entity.note || ''); setVersion(0); setEvidence(null); } }).catch(e => { if (!cancelled) setNotice(e.message); }); return () => { cancelled = true; }; }, [selected,type]);
  async function perform(action: () => Promise<unknown>) {
    setBusy(true); setNotice('');
    try { await action(); await loadList(query); if (selected) await loadDetail(type,selected); setNotice('저장했습니다. 기존 Wiki는 보존되며 새 기록은 다음 개정에 반영됩니다.'); }
    catch(e) { setNotice(e instanceof Error ? e.message : '저장 실패'); } finally { setBusy(false); }
  }
  function choose(t: string, id: string) { if (busy || (t === type && id === selected)) return; setDetail(null); setType(t); setSelected(id); setEditing(null); setContent(''); setNotice(''); window.history.replaceState(null,'',viewUrl(t,id)); }
  const revision = detail?.revisions.find((r: Row) => r.version === version) || detail?.revisions[0];
  const previous = detail?.revisions.find((r: Row) => r.version === (revision?.version || 0)-1);
  async function saveEntry(event: FormEvent) {
    event.preventDefault(); await perform(async () => { await post(`/api/wiki/${type}/${selected}/entries`, { content, entryDate, expectedVersion: detail?.entity.row_version, supersedesId: editing?.id }); setContent(''); setEditing(null); });
  }
  return <div className="matter-shell"><header className="matter-header"><a href="/matters" className="provisional-brand">← 사건 업무관리</a><div className="matter-header-actions"><a href="/analysis" className="ghost-button">판단 검토</a><button className="ghost-button" disabled={busy} onClick={() => perform(async () => {})}>새로고침</button></div></header>
    <main className="matter-main wiki-main"><h1>업무 Wiki</h1><p>현재 정보와 날짜별 기록을 근거와 함께 관리합니다.</p>
      {notice && <p role="status" className="form-notice">{notice}</p>}
      <div className="wiki-layout"><aside className="panel wiki-selector"><div className="wiki-tabs" role="group" aria-label="Wiki 유형">{Object.entries(names).map(([key,label]) => <button key={key} aria-pressed={type===key} onClick={() => choose(key,entities.find(e=>e.type===key)?.id || '')}>{label}</button>)}</div>
        <form className="matter-search" onSubmit={e => { e.preventDefault(); loadList(query).catch(e=>setNotice(e.message)); }}><input aria-label="Wiki 검색" placeholder="관리번호·이름 검색" value={query} onChange={e=>setQuery(e.target.value)} /><button type="submit">검색</button></form>
        <div className="matter-list">{entities.filter(e=>e.type===type).map(e=><button className={`matter-list-item ${e.id===selected?'selected':''}`} key={e.id} onClick={()=>choose(type,e.id)}><strong>{e.label}</strong><span>날짜 기록 {e.entryCount} · {e.version ? `Wiki v${e.version}` : '개정 전'}</span></button>)}</div>
        {!entities.some(e=>e.type===type) && <p className="selector-empty">등록된 {names[type]}가 없습니다. 사건 화면에서 연결하면 여기에 표시됩니다.</p>}
      </aside><section className="wiki-body">
        {!detail && <section className="panel analysis-panel">{selected?'내용을 불러오는 중입니다.':'목록에서 대상을 선택하세요.'}</section>}
        {detail && <><section className="panel analysis-panel"><div className="panel-heading"><h2>{detail.entity.our_ref || detail.entity.name || detail.entity.group_ref}</h2><span>{names[type]}</span></div>
          <p>{detail.entity.office || detail.entity.email || ''} {detail.entity.user_confirmed===0 && '· 기본 정보는 메일 추정값'}</p>
          {type === 'organization' && <p>회사 구분: {detail.entity.business_type || '미정'} · 개인사업자·법인·미정 중 하나로 관리합니다.</p>}
          {type === 'group' && <><p>그룹 종류: {detail.entity.group_type || '미분류'} · 종류 변경은 사건 화면에서 가능합니다.</p><p>대표 사건: {detail.entity.representative_our_ref || '미지정'} · 구성원 {detail.entity.member_refs?.length || 0}건</p></>}
          <div className="wiki-relations">{detail.related.map((r:Row,i:number)=><a key={`${r.type}-${r.id}-${i}`} href={viewUrl(r.type,r.id)}>{names[r.type]} · {r.label}</a>)}</div>
          <label>사용자 비고<textarea className="text-input" rows={3} value={note} onChange={e=>setNote(e.target.value)} /></label><button className="ghost-button" disabled={busy} onClick={()=>perform(()=>request(`/api/${({matter:'matters',organization:'organizations',person:'people',group:'groups'} as Row)[type]}/${selected}/note`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({note,expectedVersion:detail.entity.row_version})}))}>비고 저장</button>
          {detail.works.length>0 && <><h3>현재 업무 · DB 최신값</h3>{detail.works.map((w:Row)=><p key={w.id}>{w.work_type} / {w.service_type || '서비스 미지정'} · {w.stage} · {w.current_status}{w.user_confirmed?'':' (추정)'}</p>)}</>}
          {detail.actions.length>0 && <><h3>본인·팀원 Action</h3>{detail.actions.map((a:Row)=><p key={a.id}>{a.assignee} · {a.title} · {a.status} {a.due_date || ''}</p>)}<a href="/matters">사건 화면에서 상태 변경</a></>}
        </section>
        <section className="panel analysis-panel"><div className="panel-heading"><h2>Wiki와 개정 이력</h2><select aria-label="Wiki 버전" value={revision?.version || 0} onChange={e=>setVersion(Number(e.target.value))}>{!detail.revisions.length && <option value={0}>아직 없음</option>}{detail.revisions.map((r:Row)=><option key={r.id} value={r.version}>v{r.version} · {new Date(r.created_at).toLocaleDateString('ko-KR')}</option>)}</select></div>
          {detail.stale && <p className="form-notice">Wiki 작성 후 기록 또는 업무 정보가 변경되었습니다. 아래 현재 기록을 우선 확인하고 새 개정을 요청하세요.</p>}
          {detail.sourceIssues.length>0 && <p className="form-notice">메일 근거의 검증·사용자 판단이 변경되었습니다. 해당 날짜 기록을 먼저 정정해야 새 Wiki를 게시할 수 있습니다.</p>}
          {revision ? <><p className="analysis-meta">{revision.model} / {revision.reasoning_effort} · {revision.change_summary}</p><Sections sections={revision.sections} onEvidence={id=>request(`/api/wiki/evidence/${id}`).then(setEvidence).catch(e=>setNotice(e.message))} />{previous && <details><summary>이전 버전과 비교</summary><div className="wiki-compare"><div><h3>v{previous.version}</h3><Sections sections={previous.sections} /></div><div><h3>v{revision.version}</h3><Sections sections={revision.sections} /></div></div></details>}</> : <p>게시된 Wiki가 없습니다. 날짜별 근거를 준비한 뒤 이 프로젝트에서 “Wiki 갱신”을 요청하세요.</p>}
          {detail.drafts.filter((d:Row)=>d.review_status==='pending').map((d:Row)=><details key={d.run_id}><summary>게시 대기 개정안 · {d.change_summary}</summary><Sections sections={d.sections} onEvidence={id=>request(`/api/wiki/evidence/${id}`).then(setEvidence).catch(e=>setNotice(e.message))}/><div className="analysis-buttons"><button className="primary-button" disabled={busy} onClick={()=>perform(()=>post(`/api/wiki/drafts/${d.run_id}/review`,{action:'publish',expectedVersion:d.row_version}))}>확인 후 게시</button><button className="ghost-button" disabled={busy} onClick={()=>perform(()=>post(`/api/wiki/drafts/${d.run_id}/review`,{action:'reject',expectedVersion:d.row_version}))}>반려</button></div></details>)}
          {detail.legacy.length>0 && <details><summary>이전 형식 Wiki 보존본</summary>{detail.legacy.map((r:Row)=><pre key={r.id}>{r.content}</pre>)}</details>}
        </section>
        {evidence && <section className="panel analysis-panel" aria-label="근거 상세"><div className="panel-heading"><h2>근거 기록</h2><button className="ghost-button" onClick={()=>setEvidence(null)}>닫기</button></div><p>{evidence.entry.entry_date} · {evidence.entry.provenance==='user_input'?'사용자 기록':'검증된 메일 기재 내용'}</p><p>{evidence.entry.content}</p>{evidence.mails.map((m:Row)=><div key={m.id}><h3>{m.subject}</h3><p>{m.sender_name} · {m.mail_at} · {m.direction==='sent'?'보낸 메일':'받은 메일'}</p>{m.excerpts.map((e:Row,i:number)=><blockquote key={i}>{e.quote}</blockquote>)}</div>)}</section>}
        <section className="panel analysis-panel"><h2>날짜별 중요내용 · 현재 기록</h2>{detail.entries.map((e:Row)=><article className="analysis-field" key={e.id}><strong>{e.entry_date}</strong><span className="analysis-meta"> · {e.provenance==='user_input'?'사용자 기록':'메일 기재·독립 검증'}</span><p>{e.content}</p><div className="analysis-buttons"><button className="ghost-button" onClick={()=>request(`/api/wiki/evidence/${e.event_id}`).then(setEvidence).catch(e=>setNotice(e.message))}>근거 보기</button><button className="ghost-button" disabled={busy} onClick={()=>{setEditing(e);setContent(e.content);setEntryDate(e.entry_date);}}>정정 기록</button></div></article>)}{!detail.entries.length && <p>아직 확정된 날짜 기록이 없습니다. 검토 대기인 메일 판단은 자동 복사하지 않습니다.</p>}
          <form onSubmit={saveEntry} className="wiki-entry-form"><h3>{editing?'이전 내용을 보존하고 정정':'날짜별 기록 추가'}</h3><label>발생일<input aria-label="기록 발생일" className="text-input" type="date" value={entryDate} onChange={e=>setEntryDate(e.target.value)} required /></label><label>내용<textarea aria-label="기록 내용" className="text-input" rows={4} value={content} onChange={e=>setContent(e.target.value)} maxLength={4000} required /></label><button className="primary-button" type="submit" disabled={busy}>기록 저장</button>{editing && <button className="ghost-button" type="button" onClick={()=>{setEditing(null);setContent('');}}>정정 취소</button>}</form>
        </section></>}
      </section></div></main></div>;
}
function Sections({sections,onEvidence}:{sections:Row[];onEvidence?:(id:string)=>void}) {
  return <>{sections.map(s=><section key={s.key}><h3>{s.title}</h3>{s.sentences.map((line:Row,i:number)=><div key={i} className="wiki-sentence">{line.entryDate && <strong>{line.entryDate}</strong>}<p>{line.text}</p>{onEvidence && line.eventIds.map((id:string,n:number)=><button className="ghost-button" key={id} onClick={()=>onEvidence(id)}>근거 {n+1}</button>)}</div>)}</section>)}</>;
}
