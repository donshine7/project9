'use client';

import {
  Archive,
  Check,
  ChevronRight,
  CircleAlert,
  Database,
  FileClock,
  ListChecks,
  LoaderCircle,
  MessageSquareText,
  Plus,
  RefreshCw,
  Save,
  Search,
  ShieldCheck,
  Trash2,
  UserRound,
} from 'lucide-react';
import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { readApiObject } from '../../lib/api-response';

type MatterSummary = {
  id: string;
  ourRef: string;
  office: string;
  matterKind: string;
  countryCode: string | null;
  sourceType: string;
  confidence: number;
  userConfirmed: boolean;
  rowVersion: number;
  note: string | null;
  updatedAt: string;
  workCount: number;
  openActionCount: number;
};

type WorkItem = {
  id: string;
  workType: string;
  serviceType: string | null;
  stage: string;
  currentStatus: string;
  costMethod: string | null;
  fundingSource: string | null;
  baseDate: string | null;
  commencementDate: string | null;
  sourceType: string;
  confidence: number;
  rowVersion: number;
};

type MatterNote = { id: string; content: string; author: string; noteType: string; rowVersion: number; updatedAt: string };
type Organization = { id: string; name: string; businessType: '개인사업자' | '법인' | '미정'; role: string; note: string | null; rowVersion: number; updatedAt: string };
type Person = { id: string; name: string; role: string; email: string | null; organizationId: string | null; note: string | null; rowVersion: number; updatedAt: string };
type MatterGroup = {
  id: string;
  groupRef: string;
  groupType: string;
  representativeMatterId: string | null;
  representativeOurRef: string | null;
  memberRefs: string[];
  note: string | null;
  rowVersion: number;
  updatedAt: string;
};
type MailSummary = { id: string; summaryDate: string; content: string; summaryType: string; model: string | null; sourceMailIds: string[]; updatedAt: string };
type ActionItem = {
  id: string;
  workItemId: string | null;
  title: string;
  assignee: string;
  manager: string;
  status: string;
  dueDate: string | null;
  priority: string;
  evidence: string | null;
  rowVersion: number;
};
type MatterDetail = { matter: MatterSummary; works: WorkItem[]; notes: MatterNote[]; actions: ActionItem[]; organizations: Organization[]; people: Person[]; groups: MatterGroup[]; mailSummaries: MailSummary[]; events: Array<{ id: string; eventType: string; actor: string; createdAt: string }> };

const workTypes = ['출원', '중간사건', '등록', '기타'];
const serviceTypes = ['', '일반출원', '우선심사출원', '메이킹', '기획', '가출원'];
const actionStatuses = ['대기', '진행중', '완료', '보류'];
const priorities = ['낮음', '보통', '높음', '긴급'];
const teamMembers = ['장진태', '박준호', '황현우'];

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: options?.body ? { 'Content-Type': 'application/json', ...options.headers } : options?.headers,
  });
  const payload = await readApiObject(response);
  return payload as T;
}

export default function MattersPage() {
  const [matters, setMatters] = useState<MatterSummary[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [detail, setDetail] = useState<MatterDetail | null>(null);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [dbStatus, setDbStatus] = useState<{ integrity: string; migrations: Array<{ version: string }>; path: string } | null>(null);
  const [syncMode, setSyncMode] = useState('day');
  const [rangeFrom, setRangeFrom] = useState('');
  const [rangeTo, setRangeTo] = useState('');

  const loadList = useCallback(async (search = '') => {
    const data = await request<{ matters: MatterSummary[] }>(`/api/matters?q=${encodeURIComponent(search)}`);
    setMatters(data.matters);
    setSelectedId((current) => current || data.matters[0]?.id || '');
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    if (!id) return setDetail(null);
    setDetail(await request<MatterDetail>(`/api/matters/${id}`));
  }, []);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      await loadList(query);
      if (selectedId) await loadDetail(selectedId);
    } catch (error) {
      setNotice({ type: 'error', text: error instanceof Error ? error.message : '새로고침에 실패했습니다.' });
    } finally {
      setBusy(false);
    }
  }, [loadDetail, loadList, query, selectedId]);

  useEffect(() => {
    Promise.all([loadList(''), request<{ integrity: string; migrations: Array<{ version: string }>; path: string }>('/api/work-db/status')])
      .then(([, status]) => setDbStatus(status))
      .catch((error) => setNotice({ type: 'error', text: error.message }));
  }, [loadList]);

  useEffect(() => {
    loadDetail(selectedId).catch((error) => setNotice({ type: 'error', text: error.message }));
  }, [loadDetail, selectedId]);

  const applyDetail = async (next: Promise<MatterDetail>, success: string) => {
    setBusy(true);
    try {
      const value = await next;
      setDetail(value);
      await loadList(query);
      setNotice({ type: 'success', text: success });
    } catch (error) {
      setNotice({ type: 'error', text: error instanceof Error ? error.message : '변경하지 못했습니다.' });
    } finally {
      setBusy(false);
    }
  };

  const createMatter = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setBusy(true);
    try {
      const created = await request<MatterDetail>('/api/matters', {
        method: 'POST',
        body: JSON.stringify({
          ourRef: form.get('ourRef'),
          workType: form.get('workType'),
          serviceType: form.get('serviceType') || null,
          stage: form.get('stage'),
          currentStatus: form.get('currentStatus'),
        }),
      });
      setSelectedId(String(created.matter.id));
      setDetail(created);
      setQuery('');
      await loadList('');
      formElement.reset();
      setNotice({ type: 'success', text: `${created.matter.ourRef} 사건을 등록했습니다.` });
    } catch (error) {
      setNotice({ type: 'error', text: error instanceof Error ? error.message : '사건을 등록하지 못했습니다.' });
    } finally {
      setBusy(false);
    }
  };

  const backup = async () => {
    setBusy(true);
    try {
      const result = await request<{ file: string }>('/api/work-db/backup', { method: 'POST', body: '{}' });
      setNotice({ type: 'success', text: `백업 완료: ${result.file}` });
    } catch (error) {
      setNotice({ type: 'error', text: error instanceof Error ? error.message : '백업하지 못했습니다.' });
    } finally {
      setBusy(false);
    }
  };

  const syncMail = async () => {
    setBusy(true);
    try {
      const result = await request<{ imported: number; skipped: number; linked: number; affectedSummaries: number }>('/api/mail-sync', { method: 'POST', body: JSON.stringify({ mode: syncMode, from: rangeFrom, to: rangeTo }) });
      await loadList(query);
      if (selectedId) await loadDetail(selectedId);
      setNotice({ type: 'success', text: `메일 ${result.imported}건 신규 수집, ${result.skipped}건 중복 제외, 사건 연결 ${result.linked}건, 날짜별 요약 ${result.affectedSummaries}건을 반영했습니다.` });
    } catch (error) {
      setNotice({ type: 'error', text: error instanceof Error ? error.message : '메일을 수집하지 못했습니다.' });
    } finally {
      setBusy(false);
    }
  };

  const archiveSelected = async () => {
    if (!detail || !window.confirm(`${detail.matter.ourRef} 사건을 보관 처리할까요? 원장 기록은 유지됩니다.`)) return;
    setBusy(true);
    try {
      await request(`/api/matters/${detail.matter.id}`, { method: 'DELETE', body: JSON.stringify({ expectedVersion: detail.matter.rowVersion }) });
      setSelectedId('');
      setDetail(null);
      await loadList(query);
      setNotice({ type: 'success', text: '사건을 보관 처리했습니다.' });
    } catch (error) {
      setNotice({ type: 'error', text: error instanceof Error ? error.message : '보관 처리하지 못했습니다.' });
    } finally {
      setBusy(false);
    }
  };

  const selectedSummary = useMemo(() => matters.find((matter) => matter.id === selectedId), [matters, selectedId]);

  return (
    <div className="matter-shell">
      <header className="matter-header">
        <a className="provisional-brand" href="/"><Database size={18} /><span>상상특허 업무관리</span></a>
        <div className="matter-header-actions">
          <a className="ghost-button" href="/analysis">분석·검토</a>
          <a className="ghost-button" href="/wiki">업무 Wiki</a>
          <span className="db-health"><ShieldCheck size={14} /> DB {dbStatus?.integrity === 'ok' ? '정상' : '확인 중'} · migration {dbStatus?.migrations.length ?? 0}</span>
          <button className="ghost-button" type="button" onClick={backup} disabled={busy}><Archive size={14} /> DB 백업</button>
          <button className="ghost-button" type="button" onClick={refresh} disabled={busy}><RefreshCw size={14} /> 새로고침</button>
        </div>
      </header>

      <main className="matter-main">
        <section className="matter-intro">
          <div><span className="kicker">MATTER-CENTRIC WORKSPACE</span><h1>당소관리번호 중심 업무관리</h1><p>사건, 업무 상태, 메모와 본인·팀원 Action을 로컬 데이터베이스에서 관리합니다.</p></div>
          <div className="matter-db-location"><Database size={18} /><div><strong>운영 DB 주소</strong><span>{dbStatus?.path || '초기화 중'}</span></div></div>
        </section>

        <section className="mail-sync-panel panel">
          <div><span className="panel-label">READ-ONLY OUTLOOK SYNC</span><h2>이메일 중요내용 갱신</h2><p>허용된 받은편지함과 보낸편지함을 읽고, 명시된 관리번호별로 날짜 요약을 만듭니다. 메일 상태와 위치는 변경하지 않습니다.</p></div>
          <div className="mail-sync-controls"><select value={syncMode} onChange={(event) => setSyncMode(event.target.value)}><option value="day">최근 1일</option><option value="week">최근 1주일</option><option value="range">기간 설정</option></select>{syncMode === 'range' && <><input aria-label="수집 시작일" type="date" value={rangeFrom} onChange={(event) => setRangeFrom(event.target.value)} /><input aria-label="수집 종료일" type="date" value={rangeTo} onChange={(event) => setRangeTo(event.target.value)} /></>}<button className="primary-button" type="button" onClick={syncMail} disabled={busy || (syncMode === 'range' && (!rangeFrom || !rangeTo))}>{busy ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />} 이메일 읽기</button></div>
        </section>

        {notice && <div className={`form-notice ${notice.type}`}>{notice.type === 'success' ? <Check size={15} /> : <CircleAlert size={15} />}<span>{notice.text}</span></div>}

        <div className="matter-layout">
          <aside className="matter-selector panel">
            <div className="panel-heading"><div><span className="panel-label">PROJECT SELECTOR</span><h2>사건 선택</h2></div><span className="result-count">{matters.length}</span></div>
            <form className="matter-search" onSubmit={(event) => { event.preventDefault(); loadList(query); }}>
              <Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="당소관리번호 검색" /><button type="submit">검색</button>
            </form>
            <div className="matter-list">
              {matters.map((matter) => (
                <button type="button" className={matter.id === selectedId ? 'matter-list-item selected' : 'matter-list-item'} onClick={() => setSelectedId(String(matter.id))} key={matter.id}>
                  <span><strong>{matter.ourRef}</strong><small>{matter.office} · {matter.countryCode || '기타'}</small></span>
                  <span className="matter-counts">업무 {matter.workCount} · Action {matter.openActionCount}<ChevronRight size={14} /></span>
                </button>
              ))}
              {!matters.length && <div className="selector-empty"><Search size={17} />등록된 사건이 없습니다.</div>}
            </div>

            <form className="matter-create-form" onSubmit={createMatter}>
              <div className="subheading"><Plus size={16} /><strong>사건 직접 등록</strong></div>
              <label>당소관리번호<input name="ourRef" className="text-input" placeholder="예: P251556-US" required /></label>
              <div className="compact-fields"><label>업무종류<select name="workType" className="project-select" defaultValue="출원">{workTypes.map((value) => <option key={value}>{value}</option>)}</select></label><label>서비스<select name="serviceType" className="project-select" defaultValue="일반출원">{serviceTypes.map((value) => <option key={value} value={value}>{value || '해당 없음'}</option>)}</select></label></div>
              <div className="compact-fields"><label>업무단계<input name="stage" className="text-input" defaultValue="출원" required /></label><label>현재상태<input name="currentStatus" className="text-input" defaultValue="사건 등록" required /></label></div>
              <button className="primary-button" type="submit" disabled={busy}>{busy ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />} 등록</button>
            </form>
          </aside>

          <section className="matter-detail-area">
            {detail ? (
              <>
                <article className="matter-summary panel">
                  <div className="matter-summary-title"><div><span className="panel-label">SELECTED MATTER</span><h2>{detail.matter.ourRef}</h2><p>{detail.matter.office} · {detail.matter.matterKind === 'design' ? '디자인' : detail.matter.matterKind} · {detail.matter.countryCode || '국가 없음'}</p></div><button className="danger-text-button" type="button" onClick={archiveSelected}><Trash2 size={14} /> 보관</button></div>
                  <div className="provenance-strip"><ShieldCheck size={15} /><span>{detail.matter.userConfirmed ? '사용자 확정' : '자동 추정·검토 필요'}</span><span>출처 {detail.matter.sourceType}</span><span>신뢰도 {Math.round(Number(detail.matter.confidence) * 100)}%</span><span>버전 {detail.matter.rowVersion}</span></div>
                  <EntityNoteEditor label="사건 비고" value={detail.matter.note} busy={busy} onSave={(note) => applyDetail(request(`/api/matters/${detail.matter.id}/note`, { method: 'PATCH', body: JSON.stringify({ note, expectedVersion: detail.matter.rowVersion }) }), '사건 비고를 변경했습니다.')} />
                </article>

                <section className="matter-section panel">
                  <div className="panel-heading"><div><span className="panel-label">DAILY MAIL SUMMARY</span><h2>날짜별 이메일 중요내용</h2></div><MailSummaryCount count={detail.mailSummaries.length} /></div>
                  <div className="mail-summary-list">{detail.mailSummaries.map((summary) => <article key={summary.id}><div><strong>{summary.summaryDate}</strong><span>{summary.summaryType === 'llm' ? `LLM · ${summary.model || '모델 기록 없음'}` : '규칙 기반 1차 요약'} · 근거 메일 {summary.sourceMailIds.length}건</span></div><p>{summary.content}</p></article>)}{!detail.mailSummaries.length && <div className="selector-empty">연결된 이메일 요약이 없습니다.</div>}</div>
                </section>

                <RelatedEntities detail={detail} busy={busy} applyDetail={applyDetail} />

                <section className="matter-section panel">
                  <div className="panel-heading"><div><span className="panel-label">WORK ITEMS</span><h2>업무와 현재 상태</h2></div><ListChecks size={19} /></div>
                  <div className="editor-stack">{detail.works.map((work) => <WorkEditor key={work.id} work={work} busy={busy} onSave={(payload) => applyDetail(request(`/api/work-items/${work.id}`, { method: 'PATCH', body: JSON.stringify(payload) }), '업무 상태를 변경했습니다.')} />)}</div>
                  <NewWorkForm matterId={String(detail.matter.id)} busy={busy} onCreated={(promise) => applyDetail(promise, '업무를 추가했습니다.')} />
                </section>

                <div className="matter-two-column">
                  <section className="matter-section panel">
                    <div className="panel-heading"><div><span className="panel-label">ACTIONS</span><h2>본인·팀원 Action</h2></div><UserRound size={19} /></div>
                    <div className="editor-stack">{detail.actions.map((action) => <ActionEditor key={action.id} action={action} busy={busy} onSave={(payload) => applyDetail(request(`/api/actions/${action.id}`, { method: 'PATCH', body: JSON.stringify(payload) }), 'Action을 변경했습니다.')} onArchive={() => applyDetail(request(`/api/actions/${action.id}`, { method: 'DELETE', body: JSON.stringify({ expectedVersion: action.rowVersion }) }), 'Action을 보관했습니다.')} />)}</div>
                    <NewActionForm matterId={String(detail.matter.id)} works={detail.works} busy={busy} onCreated={(promise) => applyDetail(promise, 'Action을 추가했습니다.')} />
                  </section>

                  <section className="matter-section panel">
                    <div className="panel-heading"><div><span className="panel-label">NOTES</span><h2>사용자 메모</h2></div><MessageSquareText size={19} /></div>
                    <div className="editor-stack">{detail.notes.map((note) => <NoteEditor key={note.id} note={note} busy={busy} onSave={(content) => applyDetail(request(`/api/notes/${note.id}`, { method: 'PATCH', body: JSON.stringify({ content, expectedVersion: note.rowVersion }) }), '메모를 변경했습니다.')} onArchive={() => applyDetail(request(`/api/notes/${note.id}`, { method: 'DELETE', body: JSON.stringify({ expectedVersion: note.rowVersion }) }), '메모를 보관했습니다.')} />)}</div>
                    <NewNoteForm matterId={String(detail.matter.id)} busy={busy} onCreated={(promise) => applyDetail(promise, '메모를 추가했습니다.')} />
                  </section>
                </div>

                <section className="matter-section panel event-panel">
                  <div className="panel-heading"><div><span className="panel-label">AUDIT TRAIL</span><h2>최근 변경 이력</h2></div><FileClock size={19} /></div>
                  <div className="event-list">{detail.events.map((item) => <div key={item.id}><span>{item.eventType}</span><small>{item.actor} · {new Date(item.createdAt).toLocaleString('ko-KR')}</small></div>)}</div>
                </section>
              </>
            ) : <div className="matter-empty panel"><Database size={30} /><strong>{selectedSummary ? '사건을 불러오는 중입니다.' : '사건을 등록하거나 선택하세요.'}</strong><span>사용자 입력은 확정값과 변경 이벤트로 함께 기록됩니다.</span></div>}
          </section>
        </div>
      </main>
    </div>
  );
}

function MailSummaryCount({ count }: { count: number }) {
  return <span className="result-count">{count}</span>;
}

function EntityNoteEditor({ label, value, busy, onSave }: { label: string; value: string | null; busy: boolean; onSave: (note: string) => void }) {
  const [note, setNote] = useState(value || '');
  useEffect(() => setNote(value || ''), [value]);
  return <div className="entity-note-editor"><label>{label}<textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder={`${label}를 입력하세요.`} /></label><button className="small-save-button" type="button" disabled={busy} onClick={() => onSave(note)}><Save size={13} /> 비고 저장</button></div>;
}

function RelatedEntities({ detail, busy, applyDetail }: { detail: MatterDetail; busy: boolean; applyDetail: (next: Promise<MatterDetail>, success: string) => Promise<void> }) {
  const refreshAfter = (operation: Promise<unknown>) => operation.then(() => request<MatterDetail>(`/api/matters/${detail.matter.id}`));
  const submitOrganization = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    applyDetail(request(`/api/matters/${detail.matter.id}/organizations`, { method: 'POST', body: JSON.stringify({ name: form.get('name'), businessType: form.get('businessType'), note: form.get('note') }) }), '회사를 연결했습니다.');
    formElement.reset();
  };
  const submitPerson = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    applyDetail(request(`/api/matters/${detail.matter.id}/people`, { method: 'POST', body: JSON.stringify({ name: form.get('name'), email: form.get('email'), note: form.get('note'), organizationId: form.get('organizationId') || null }) }), '자연인을 연결했습니다.');
    formElement.reset();
  };
  const submitGroup = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    applyDetail(request(`/api/matters/${detail.matter.id}/groups`, { method: 'POST', body: JSON.stringify({ groupRef: form.get('groupRef'), groupType: form.get('groupType') || undefined, note: form.get('note') }) }), '그룹을 연결했습니다.');
    formElement.reset();
  };
  return <section className="matter-section panel">
    <div className="panel-heading"><div><span className="panel-label">RELATED RECORDS</span><h2>회사·자연인·그룹 비고</h2></div><UserRound size={19} /></div>
    <div className="related-grid">
      <div className="related-column"><h3>회사</h3>{detail.organizations.map((item) => <div className="related-card" key={`${item.id}-${item.role}-${item.rowVersion}`}><strong>{item.name}</strong><small>관계: {item.role} · 회사 구분: {item.businessType}</small><form className="related-add-form" onSubmit={e => { e.preventDefault(); const form = new FormData(e.currentTarget); applyDetail(refreshAfter(request(`/api/organizations/${item.id}/business-type`, { method: 'PATCH', body: JSON.stringify({ businessType: form.get('businessType'), expectedVersion: item.rowVersion }) })), '회사 구분을 변경했습니다.'); }}><label>회사 구분<select name="businessType" defaultValue={item.businessType}><option>개인사업자</option><option>법인</option><option>미정</option></select></label><button className="small-save-button" disabled={busy}>구분 저장</button></form><EntityNoteEditor label="회사 비고" value={item.note} busy={busy} onSave={(note) => applyDetail(refreshAfter(request(`/api/organizations/${item.id}/note`, { method: 'PATCH', body: JSON.stringify({ note, expectedVersion: item.rowVersion }) })), '회사 비고를 변경했습니다.')} /></div>)}<form className="related-add-form" onSubmit={submitOrganization}><input name="name" placeholder="회사명" required /><select name="businessType" defaultValue="미정" aria-label="새 회사 구분"><option>개인사업자</option><option>법인</option><option>미정</option></select><textarea name="note" placeholder="회사 비고" /><button className="small-save-button" disabled={busy}><Plus size={13} /> 회사 연결</button></form></div>
      <div className="related-column"><h3>자연인</h3>{detail.people.map((item) => <div className="related-card" key={`${item.id}-${item.role}`}><strong>{item.name}</strong><small>관계: {item.role} · {item.email || '이메일 없음'}</small><EntityNoteEditor label="자연인 비고" value={item.note} busy={busy} onSave={(note) => applyDetail(refreshAfter(request(`/api/people/${item.id}/note`, { method: 'PATCH', body: JSON.stringify({ note, expectedVersion: item.rowVersion }) })), '자연인 비고를 변경했습니다.')} /></div>)}<form className="related-add-form" onSubmit={submitPerson}><input name="name" placeholder="이름" required /><input name="email" type="email" placeholder="이메일" /><select name="organizationId"><option value="">회사 연결 없음</option>{detail.organizations.filter((item, i, items) => items.findIndex(o => o.id === item.id) === i).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><textarea name="note" placeholder="자연인 비고" /><button className="small-save-button" disabled={busy}><Plus size={13} /> 자연인 연결</button></form></div>
      <div className="related-column"><h3>그룹</h3><datalist id="group-type-options"><option value="포트폴리오" /><option value="시리즈" /><option value="정부지원사업" /><option value="미분류" /></datalist><p>사건은 여러 그룹에 연결할 수 있습니다. 같은 대표 사건의 다른 그룹은 별도 식별번호를 입력하세요.</p>{detail.groups.map((item) => <div className="related-card" key={item.id}><strong>{item.groupRef}</strong><p className="analysis-meta">대표 사건 · {item.representativeOurRef || '미지정'}</p><p className="analysis-meta">구성원 · {item.memberRefs.length ? item.memberRefs.join(', ') : '미지정'}</p><form key={`${item.id}-${item.rowVersion}`} className="related-add-form" onSubmit={e => { e.preventDefault(); const form = new FormData(e.currentTarget); applyDetail(refreshAfter(request(`/api/groups/${item.id}/type`, { method: 'PATCH', body: JSON.stringify({ groupType: form.get('groupType'), expectedVersion: item.rowVersion }) })), '그룹 종류를 변경했습니다.'); }}><label>그룹 종류<input name="groupType" list="group-type-options" defaultValue={item.groupType} maxLength={100} required /></label><button className="small-save-button" disabled={busy}>종류 저장</button></form><EntityNoteEditor label="그룹 비고" value={item.note} busy={busy} onSave={(note) => applyDetail(refreshAfter(request(`/api/groups/${item.id}/note`, { method: 'PATCH', body: JSON.stringify({ note, expectedVersion: item.rowVersion }) })), '그룹 비고를 변경했습니다.')} /></div>)}<form className="related-add-form" onSubmit={submitGroup}><input name="groupRef" placeholder="예: GP251556 또는 GP251556-2" required /><input name="groupType" aria-label="새 그룹 종류" list="group-type-options" maxLength={100} placeholder="포트폴리오·시리즈·정부지원사업 등" /><small>비워두면 기존 종류 유지 / 새 그룹은 미분류</small><textarea name="note" placeholder="그룹 비고" /><button className="small-save-button" disabled={busy}><Plus size={13} /> 그룹 연결</button></form></div>
    </div>
  </section>;
}

function WorkEditor({ work, busy, onSave }: { work: WorkItem; busy: boolean; onSave: (payload: unknown) => void }) {
  const [value, setValue] = useState(work);
  useEffect(() => setValue(work), [work]);
  return <div className="record-editor"><div className="record-editor-grid"><label>업무종류<select value={value.workType} onChange={(e) => setValue({ ...value, workType: e.target.value })}>{workTypes.map((item) => <option key={item}>{item}</option>)}</select></label><label>서비스<select value={value.serviceType || ''} onChange={(e) => setValue({ ...value, serviceType: e.target.value || null })}>{serviceTypes.map((item) => <option key={item} value={item}>{item || '해당 없음'}</option>)}</select></label><label>업무단계<input value={value.stage} onChange={(e) => setValue({ ...value, stage: e.target.value })} /></label><label>현재상태<input value={value.currentStatus} onChange={(e) => setValue({ ...value, currentStatus: e.target.value })} /></label><label>비용 처리<input value={value.costMethod || ''} onChange={(e) => setValue({ ...value, costMethod: e.target.value || null })} placeholder="선입금·착수금·단계별·후청구" /></label><label>자금 출처<input value={value.fundingSource || ''} onChange={(e) => setValue({ ...value, fundingSource: e.target.value || null })} placeholder="고객·정부지원금" /></label><label>기산일<input type="date" value={value.baseDate || ''} onChange={(e) => setValue({ ...value, baseDate: e.target.value || null })} /></label><label>착수일<input type="date" value={value.commencementDate || ''} onChange={(e) => setValue({ ...value, commencementDate: e.target.value || null })} /></label></div><button className="small-save-button" type="button" disabled={busy} onClick={() => onSave({ ...value, expectedVersion: work.rowVersion })}><Save size={13} /> 업무 저장</button></div>;
}

function NewWorkForm({ matterId, busy, onCreated }: { matterId: string; busy: boolean; onCreated: (promise: Promise<MatterDetail>) => void }) {
  const submit = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const form = new FormData(event.currentTarget); onCreated(request(`/api/matters/${matterId}/work-items`, { method: 'POST', body: JSON.stringify({ workType: form.get('workType'), serviceType: form.get('serviceType') || null, stage: form.get('stage'), currentStatus: form.get('currentStatus') }) })); event.currentTarget.reset(); };
  return <details className="add-record"><summary><Plus size={13} /> 다른 업무 추가</summary><form onSubmit={submit}><div className="record-editor-grid"><label>업무종류<select name="workType">{workTypes.map((item) => <option key={item}>{item}</option>)}</select></label><label>서비스<select name="serviceType">{serviceTypes.map((item) => <option key={item} value={item}>{item || '해당 없음'}</option>)}</select></label><label>업무단계<input name="stage" defaultValue="출원" required /></label><label>현재상태<input name="currentStatus" defaultValue="사건 등록" required /></label></div><button className="small-save-button" disabled={busy}><Plus size={13} /> 추가</button></form></details>;
}

function ActionEditor({ action, busy, onSave, onArchive }: { action: ActionItem; busy: boolean; onSave: (payload: unknown) => void; onArchive: () => void }) {
  const [value, setValue] = useState(action);
  useEffect(() => setValue(action), [action]);
  return <div className="record-editor"><input className="record-title-input" value={value.title} onChange={(e) => setValue({ ...value, title: e.target.value })} /><div className="record-editor-grid"><label>수행자<select value={value.assignee} onChange={(e) => setValue({ ...value, assignee: e.target.value })}>{teamMembers.map((item) => <option key={item}>{item}</option>)}</select></label><label>상태<select value={value.status} onChange={(e) => setValue({ ...value, status: e.target.value })}>{actionStatuses.map((item) => <option key={item}>{item}</option>)}</select></label><label>기한<input type="date" value={value.dueDate || ''} onChange={(e) => setValue({ ...value, dueDate: e.target.value || null })} /></label><label>중요도<select value={value.priority} onChange={(e) => setValue({ ...value, priority: e.target.value })}>{priorities.map((item) => <option key={item}>{item}</option>)}</select></label></div><div className="record-actions"><button className="small-save-button" disabled={busy} onClick={() => onSave({ ...value, expectedVersion: action.rowVersion })}><Save size={13} /> 저장</button><button className="icon-button" title="보관" disabled={busy} onClick={onArchive}><Trash2 size={13} /></button></div></div>;
}

function NewActionForm({ matterId, works, busy, onCreated }: { matterId: string; works: WorkItem[]; busy: boolean; onCreated: (promise: Promise<MatterDetail>) => void }) {
  const submit = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const form = new FormData(event.currentTarget); onCreated(request(`/api/matters/${matterId}/actions`, { method: 'POST', body: JSON.stringify({ title: form.get('title'), assignee: form.get('assignee'), workItemId: form.get('workItemId') || null, dueDate: form.get('dueDate') || null, priority: form.get('priority') }) })); event.currentTarget.reset(); };
  return <details className="add-record"><summary><Plus size={13} /> Action 추가</summary><form onSubmit={submit}><label>내용<input name="title" required /></label><div className="record-editor-grid"><label>수행자<select name="assignee">{teamMembers.map((item) => <option key={item}>{item}</option>)}</select></label><label>연결 업무<select name="workItemId"><option value="">없음</option>{works.map((work) => <option key={work.id} value={work.id}>{work.workType} · {work.currentStatus}</option>)}</select></label><label>기한<input name="dueDate" type="date" /></label><label>중요도<select name="priority">{priorities.map((item) => <option key={item}>{item}</option>)}</select></label></div><button className="small-save-button" disabled={busy}><Plus size={13} /> 추가</button></form></details>;
}

function NoteEditor({ note, busy, onSave, onArchive }: { note: MatterNote; busy: boolean; onSave: (content: string) => void; onArchive: () => void }) {
  const [content, setContent] = useState(note.content);
  useEffect(() => setContent(note.content), [note]);
  return <div className="record-editor"><textarea value={content} onChange={(e) => setContent(e.target.value)} /><div className="record-actions"><small>{note.author} · {new Date(note.updatedAt).toLocaleString('ko-KR')}</small><button className="small-save-button" disabled={busy} onClick={() => onSave(content)}><Save size={13} /> 저장</button><button className="icon-button" title="보관" disabled={busy} onClick={onArchive}><Trash2 size={13} /></button></div></div>;
}

function NewNoteForm({ matterId, busy, onCreated }: { matterId: string; busy: boolean; onCreated: (promise: Promise<MatterDetail>) => void }) {
  const [content, setContent] = useState('');
  const submit = (event: FormEvent) => { event.preventDefault(); if (!content.trim()) return; onCreated(request(`/api/matters/${matterId}/notes`, { method: 'POST', body: JSON.stringify({ content }) })); setContent(''); };
  return <form className="new-note-form" onSubmit={submit}><textarea value={content} onChange={(e) => setContent(e.target.value)} placeholder="사용자 메모 입력" /><button className="small-save-button" disabled={busy || !content.trim()}><Plus size={13} /> 메모 추가</button></form>;
}
