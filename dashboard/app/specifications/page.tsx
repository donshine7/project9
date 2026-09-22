'use client';

import { ArrowLeft, Check, CheckCircle2, CircleAlert, Clipboard, FileCheck2, FilePenLine, FolderPlus, LoaderCircle, RefreshCw, Search, ShieldCheck, UserRound, Workflow } from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { readApiObject } from '../../lib/api-response';

type Summary = { total: number; active: number; onboarding: number; userAction: number; held: number; completed: number };
type Project = { id: string; name: string; caseId: string | null; serviceType: string | null; inventionType: string | null; stage: string | null; stageNumber: number; status: string; linked: boolean; compatibilityLabel: string; held: boolean; completed: boolean; userAction: boolean; nextAction: string | null; updatedAt: string | null; setupStatus: string | null };
type Step = { key: string; status: string; actor: string; confirmedAt: string | null; evidenceRef: string | null };
type Setup = { id: string; caseId: string; clientLabel: string; projectName: string; projectRelativePath: string | null; serviceType: string; inventionType: string; creationDirection: string | null; owner: string; status: string; rowVersion: number; previewToken: string | null; lastError: string | null; updatedAt: string };
type SetupDetail = { setup: Setup; steps: Step[]; events: Array<{ id: string; eventType: string; actor: string; detail: Record<string, unknown>; createdAt: string }>; preview?: { previewToken: string; destination: string; files: string[]; sampleHash: string } };
type ProjectDetail = {
  project: Project; path: string; sharedPath: string; case: Record<string, any> | null; caseError: string | null;
  workflow: Array<{ key: string; number: number; title: string; detail: string; humanAction: boolean; status: string }>;
  onboarding: { setup: Setup; steps: Step[] } | null; firstTaskPrompt: string;
  operations: Record<string, unknown> | null; evidence: Record<string, unknown> | null; claims: Record<string, unknown> | null;
  decisions: string | null; statusText: string | null; latestOutputs: Array<Record<string, unknown>>; review: Record<string, unknown>;
  approvals: Array<Record<string, unknown>>; checks: Array<{ id: string; stage: string; status: string; result: Record<string, unknown>; createdAt: string }>;
};

const setupDefinitions = [
  ['case_info', '사건 정보 입력', '사용자'], ['copy_preview', '복사 계획 검증', '시스템'], ['folder_creation', '사건 폴더 생성', '시스템'],
  ['codex_setup', 'Codex 프로젝트 설정', '사용자'], ['source_materials', '발명 자료 배치', '사용자'], ['intake_start', '첫 작업 시작', '사용자'],
] as const;

async function request<T>(url: string, options?: RequestInit) {
  const response = await fetch(url, { cache: 'no-store', ...options, headers: options?.body ? { 'Content-Type': 'application/json', ...options.headers } : options?.headers });
  return await readApiObject(response) as T;
}
function date(value: string | null | undefined) {
  if (!value) return '미확인';
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short' }).format(parsed) : value;
}

function statusClass(value: string) {
  if (value === 'confirmed' || value === '완료' || value === 'passed') return 'done';
  if (value === '사용자 작업 필요' || value === 'user_action' || value === 'needs_input' || value === 'needs_review') return 'user';
  if (value === '현재' || value === 'creating' || value === 'previewed') return 'current';
  if (value === 'failed' || value === 'error' || value === 'invalid') return 'blocked';
  return 'pending';
}

export default function SpecificationsPage() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [setups, setSetups] = useState<Setup[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [setupDetail, setSetupDetail] = useState<SetupDetail | null>(null);
  const [query, setQuery] = useState('');
  const [service, setService] = useState('');
  const [stage, setStage] = useState('');
  const [userOnly, setUserOnly] = useState(false);
  const [busy, setBusy] = useState('');
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('progress');
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [form, setForm] = useState({ caseId: '', clientLabel: '', projectName: '', serviceType: '메이킹', inventionType: '방법', creationDirection: '', owner: '장진태' });
  const [codexEvidence, setCodexEvidence] = useState('사건 폴더를 기본 폴더로, _shared를 추가 폴더로 설정함');
  const [sourceEvidence, setSourceEvidence] = useState('발명 자료를 지정 폴더에 배치함');
  const [taskTitle, setTaskTitle] = useState('');
  const [externalTaskId, setExternalTaskId] = useState('');

  const load = useCallback(async (preferred?: string) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ q: query, serviceType: service, stage, userAction: userOnly ? 'true' : '' });
      const [nextSummary, list, setupList] = await Promise.all([
        request<Summary>('/api/specifications/summary'),
        request<{ projects: Project[] }>(`/api/specifications/projects?${params}`),
        request<{ setups: Setup[] }>('/api/specifications/setups?limit=30'),
      ]);
      setSummary(nextSummary); setProjects(list.projects); setSetups(setupList.setups);
      const candidate = preferred || selectedId;
      const nextId = candidate && list.projects.some((item) => item.id === candidate) ? candidate : list.projects[0]?.id || '';
      setSelectedId(nextId);
      setDetail(nextId ? await request<ProjectDetail>(`/api/specifications/projects/${encodeURIComponent(nextId)}`) : null);
    } catch (error) { setMessage({ type: 'error', text: error instanceof Error ? error.message : '명세서 프로젝트 현황을 읽지 못했습니다.' }); }
    finally { setLoading(false); }
  }, [query, selectedId, service, stage, userOnly]);

  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function selectProject(id: string) {
    setSelectedId(id); setBusy('detail'); setMessage(null);
    try { setDetail(await request<ProjectDetail>(`/api/specifications/projects/${encodeURIComponent(id)}`)); setTab('progress'); }
    catch (error) { setMessage({ type: 'error', text: error instanceof Error ? error.message : '프로젝트 상세를 읽지 못했습니다.' }); }
    finally { setBusy(''); }
  }

  async function createSetup(event: FormEvent) {
    event.preventDefault(); setBusy('create'); setMessage(null);
    try {
      const result = await request<SetupDetail>('/api/specifications/setups', { method: 'POST', body: JSON.stringify(form) });
      setSetupDetail(result); setTaskTitle(`[CASE] ${result.setup.caseId} - 발명 자료 접수`);
      setMessage({ type: 'success', text: '1단계 사건 정보를 기록했습니다. 이제 복사 계획을 검증하세요.' }); await load();
    } catch (error) { setMessage({ type: 'error', text: error instanceof Error ? error.message : '신규 사건 준비를 시작하지 못했습니다.' }); }
    finally { setBusy(''); }
  }

  async function openSetup(id: string) {
    setBusy('setup');
    try { const result = await request<SetupDetail>(`/api/specifications/setups/${encodeURIComponent(id)}`); setSetupDetail(result); setTaskTitle(`[CASE] ${result.setup.caseId} - 발명 자료 접수`); }
    catch (error) { setMessage({ type: 'error', text: error instanceof Error ? error.message : '준비 기록을 읽지 못했습니다.' }); }
    finally { setBusy(''); }
  }

  async function setupAction(action: 'preview' | 'initialize' | 'confirm' | 'verify', body: Record<string, unknown> = {}) {
    if (!setupDetail) return;
    setBusy(action); setMessage(null);
    try {
      const result = await request<SetupDetail>(`/api/specifications/setups/${encodeURIComponent(setupDetail.setup.id)}/${action}`, { method: 'POST', body: JSON.stringify(body) });
      setSetupDetail(result);
      const labels = { preview: '복사 계획을 검증했습니다.', initialize: '사건 폴더를 새로 만들었습니다.', confirm: '사용자 확인을 기록했습니다.', verify: '첫 작업 연결을 기록했습니다.' };
      setMessage({ type: 'success', text: labels[action] });
      await load(action === 'initialize' ? (result as any).project?.project?.id : undefined);
    } catch (error) { setMessage({ type: 'error', text: error instanceof Error ? error.message : '요청을 처리하지 못했습니다.' }); }
    finally { setBusy(''); }
  }

  async function runCheck() {
    if (!selectedId) return; setBusy('check'); setMessage(null);
    try {
      const result = await request<{ status: string }>(`/api/specifications/projects/${encodeURIComponent(selectedId)}/checks`, { method: 'POST' });
      setMessage({ type: result.status === 'passed' ? 'success' : 'error', text: result.status === 'passed' ? '하네스 검사를 통과했습니다.' : '검사에서 보완 항목을 찾았습니다.' });
      await selectProject(selectedId);
    } catch (error) { setMessage({ type: 'error', text: error instanceof Error ? error.message : '검사를 실행하지 못했습니다.' }); }
    finally { setBusy(''); }
  }

  async function copyText(value: string, label: string) {
    try { await navigator.clipboard.writeText(value); setMessage({ type: 'success', text: `${label}을(를) 클립보드에 복사했습니다.` }); }
    catch { setMessage({ type: 'error', text: '클립보드 권한이 없어 복사하지 못했습니다.' }); }
  }

  const selected = detail?.project || projects.find((item) => item.id === selectedId) || null;
  const nextSetupStep = useMemo(() => setupDefinitions.find(([key]) => setupDetail?.steps.find((step) => step.key === key)?.status !== 'confirmed'), [setupDetail]);

  return (
    <div className="spec-page">
      <header className="spec-header">
        <a href="/"><ArrowLeft size={15} /> 업무 홈</a>
        <div><span>SPECIFICATION MAKING</span><h1>한국특허 명세서 작성</h1></div>
        <button onClick={() => void load()} disabled={loading}><RefreshCw className={loading ? 'spin' : ''} size={15} /> 새로고침</button>
      </header>
      <main className="spec-main">
        <section className="spec-hero">
          <div><span className="kicker">CREATIVE DRAFTING HARNESS</span><h2>발명 자료에서 특허 포인트와<br />검증 가능한 명세서까지</h2><p>사람의 확인과 시스템 검증을 구분하고, 기존 사건은 손대지 않은 채 새 사건만 안전하게 초기화합니다.</p></div>
          <FilePenLine size={64} strokeWidth={1.2} />
        </section>
        <section className="spec-metrics" aria-label="명세서 프로젝트 요약">
          {[['전체 사건', summary?.total ?? 0], ['진행 중', summary?.active ?? 0], ['신규 준비', summary?.onboarding ?? 0], ['사람 확인 필요', summary?.userAction ?? 0], ['검토 필요', summary?.held ?? 0], ['완료', summary?.completed ?? 0]].map(([label, value]) => <article key={label}><span>{label}</span><strong>{value}</strong></article>)}
        </section>
        {message && <div className={`spec-message ${message.type}`}>{message.type === 'success' ? <CheckCircle2 size={16} /> : <CircleAlert size={16} />}<span>{message.text}</span></div>}

        <section className="spec-onboarding panel">
          <div className="spec-section-heading"><div><span>NEW CASE ONBOARDING</span><h2>새 사건 프로젝트 시작</h2><p>정보 입력 → dry-run → 폴더 생성 → Codex 설정 → 자료 배치 → 첫 작업의 순서입니다.</p></div><FolderPlus size={27} /></div>
          <form className="spec-form-grid" onSubmit={createSetup}>
            <label>당소관리번호<input value={form.caseId} onChange={(event) => setForm({ ...form, caseId: event.target.value })} placeholder="예: P262100" required /></label>
            <label>의뢰인 식별명<input value={form.clientLabel} onChange={(event) => setForm({ ...form, clientLabel: event.target.value })} placeholder="회사명 또는 발명자명" required /></label>
            <label>프로젝트 폴더명 <small>비우면 자동</small><input value={form.projectName} onChange={(event) => setForm({ ...form, projectName: event.target.value })} placeholder="P262100_의뢰인" /></label>
            <label>서비스 종류<select value={form.serviceType} onChange={(event) => setForm({ ...form, serviceType: event.target.value })}>{['메이킹', '기획', '일반출원', '우선심사출원', '가출원'].map((value) => <option key={value}>{value}</option>)}</select></label>
            <label>발명 유형<select value={form.inventionType} onChange={(event) => setForm({ ...form, inventionType: event.target.value })}>{['방법', '장치', '조성물', '혼합', '기타'].map((value) => <option key={value}>{value}</option>)}</select></label>
            <label>담당자<input value={form.owner} onChange={(event) => setForm({ ...form, owner: event.target.value })} required /></label>
            <label className="wide">창작 방향 {form.serviceType === '메이킹' && <small>필수</small>}<textarea value={form.creationDirection} onChange={(event) => setForm({ ...form, creationDirection: event.target.value })} placeholder="자료를 바탕으로 구체화할 기술적 방향" required={form.serviceType === '메이킹'} /></label>
            <button disabled={Boolean(busy)}>{busy === 'create' ? <LoaderCircle className="spin" size={15} /> : <FolderPlus size={15} />} 1단계 시작</button>
          </form>

          {setups.length > 0 && <div className="spec-setup-list"><strong>최근 준비 기록</strong><div>{setups.map((item) => <button key={item.id} className={setupDetail?.setup.id === item.id ? 'selected' : ''} onClick={() => void openSetup(item.id)}><span>{item.caseId} · {item.projectName}</span><small>{item.status} · {date(item.updatedAt)}</small></button>)}</div></div>}

          {setupDetail && <div className="spec-setup-board">
            <div className="spec-setup-heading"><div><strong>{setupDetail.setup.caseId} · {setupDetail.setup.projectName}</strong><span>현재 준비 상태: {setupDetail.setup.status}</span></div>{nextSetupStep && <em>다음: {nextSetupStep[1]}</em>}</div>
            <div className="spec-setup-steps">{setupDefinitions.map(([key, title, actor], index) => { const state = setupDetail.steps.find((step) => step.key === key); return <article className={statusClass(state?.status || 'pending')} key={key}><span>{index + 1}</span><div><strong>{title}</strong><small><UserRound size={11} /> {actor} · {state?.status || 'pending'}</small></div>{state?.status === 'confirmed' && <Check size={16} />}</article>; })}</div>
            <div className="spec-step-action">
              {setupDetail.setup.status === 'preparing' || setupDetail.setup.status === 'failed' ? <button onClick={() => void setupAction('preview')} disabled={Boolean(busy)}><ShieldCheck size={15} /> 2단계 dry-run 검증</button> : null}
              {setupDetail.setup.status === 'previewed' && <><div><strong>복사 목적지</strong><code>{setupDetail.preview?.destination || setupDetail.setup.projectName}</code><small>검증한 샘플과 입력이 바뀌면 생성이 중단됩니다.</small></div><button onClick={() => void setupAction('initialize', { previewToken: setupDetail.setup.previewToken || setupDetail.preview?.previewToken })} disabled={Boolean(busy)}><FolderPlus size={15} /> 3단계 폴더 생성</button></>}
              {['created', 'ready'].includes(setupDetail.setup.status) && setupDetail.steps.find((step) => step.key === 'codex_setup')?.status !== 'confirmed' && <div className="spec-human-form"><p><strong>4단계 사람의 행위</strong> Codex에서 사건 폴더를 기본 폴더로 설정하고 <code>_shared</code>를 추가 폴더로 설정하세요.</p><input value={codexEvidence} onChange={(event) => setCodexEvidence(event.target.value)} /><button onClick={() => void setupAction('confirm', { stepKey: 'codex_setup', evidence: codexEvidence })}>설정 완료 확인</button></div>}
              {['created', 'ready'].includes(setupDetail.setup.status) && setupDetail.steps.find((step) => step.key === 'codex_setup')?.status === 'confirmed' && setupDetail.steps.find((step) => step.key === 'source_materials')?.status !== 'confirmed' && <div className="spec-human-form"><p><strong>5단계 사람의 행위</strong> 원본을 <code>10_source_original</code>, 선행 자료를 <code>20_prior_art</code>에 넣으세요. 시스템이 실제 파일을 확인합니다.</p><input value={sourceEvidence} onChange={(event) => setSourceEvidence(event.target.value)} /><button onClick={() => void setupAction('confirm', { stepKey: 'source_materials', evidence: sourceEvidence })}>자료 배치 확인</button></div>}
              {['created', 'ready'].includes(setupDetail.setup.status) && setupDetail.steps.find((step) => step.key === 'source_materials')?.status === 'confirmed' && setupDetail.steps.find((step) => step.key === 'intake_start')?.status !== 'confirmed' && <div className="spec-human-form"><p><strong>6단계 사람의 행위</strong> 사건 상세의 첫 작업 프롬프트로 Codex 작업을 시작한 뒤 아래에 기록하세요.</p><input value={taskTitle} onChange={(event) => setTaskTitle(event.target.value)} placeholder="첫 작업 제목" /><input value={externalTaskId} onChange={(event) => setExternalTaskId(event.target.value)} placeholder="Codex 작업 ID 또는 메모 (선택)" /><button onClick={() => void setupAction('verify', { taskTitle, externalTaskId })}>첫 작업 시작 기록</button></div>}
              {setupDetail.setup.status === 'ready' && <div className="spec-ready"><CheckCircle2 size={18} /><div><strong>신규 사건 준비 완료</strong><span>이제 사건 상세의 8단계 작성 흐름으로 관리합니다.</span></div></div>}
            </div>
          </div>}
        </section>

        <section className="spec-filters panel"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="사건번호 또는 폴더명" /><select value={service} onChange={(event) => setService(event.target.value)}><option value="">모든 서비스</option>{['메이킹', '기획', '일반출원', '우선심사출원', '가출원'].map((value) => <option key={value}>{value}</option>)}</select><select value={stage} onChange={(event) => setStage(event.target.value)}><option value="">모든 단계</option>{['intake', 'analysis', 'concretization', 'points', 'claims', 'drafting', 'review', 'final'].map((value) => <option key={value}>{value}</option>)}</select><label><input type="checkbox" checked={userOnly} onChange={(event) => setUserOnly(event.target.checked)} /> 사람 확인 필요</label><button onClick={() => void load()} disabled={loading}>조회</button></section>

        <section className="spec-layout">
          <aside className="spec-project-list panel">{projects.length ? projects.map((project) => <button key={project.id} className={selectedId === project.id ? 'selected' : ''} onClick={() => void selectProject(project.id)}><div><strong>{project.caseId || project.name}</strong><span className={`spec-chip ${project.held ? 'held' : project.completed ? 'done' : 'active'}`}>{project.compatibilityLabel}</span></div><p>{project.name}</p><small>{project.serviceType || '서비스 미연결'} · {project.stage || '단계 미연결'} · {project.status}</small></button>) : <div className="spec-empty">표시할 사건이 없습니다.</div>}</aside>
          <article className="spec-detail panel">{selected && detail ? <>
            <div className="spec-detail-heading"><div><span>{selected.caseId || '미연결 사건'}</span><h2>{selected.name}</h2><p>{selected.nextAction || '다음 작업이 기록되지 않았습니다.'}</p></div><button onClick={() => void runCheck()} disabled={!selected.linked || busy === 'check'} title={!selected.linked ? '하네스 연결 사건만 검사할 수 있습니다.' : undefined}>{busy === 'check' ? <LoaderCircle className="spin" size={14} /> : <ShieldCheck size={14} />} 읽기 전용 검사</button></div>
            {!selected.linked && <div className="spec-legacy"><CircleAlert size={17} /><div><strong>{selected.compatibilityLabel}</strong><p>이 기존 사건은 표시만 하며 파일을 자동 변환하거나 수정하지 않습니다.</p></div></div>}
            <div className="spec-paths"><div><span>사건 기본 폴더</span><code>{detail.path}</code><button onClick={() => void copyText(detail.path, '사건 폴더 경로')}><Clipboard size={13} /></button></div><div><span>추가 폴더</span><code>{detail.sharedPath}</code><button onClick={() => void copyText(detail.sharedPath, '공통 폴더 경로')}><Clipboard size={13} /></button></div></div>
            <nav className="spec-tabs">{[['progress', '작성 8단계'], ['flow', '동작·데이터'], ['claims', '포인트·청구항'], ['review', '산출물·검수'], ['history', '결정·검사']].map(([key, label]) => <button key={key} aria-pressed={tab === key} onClick={() => setTab(key)}>{label}</button>)}</nav>
            {tab === 'progress' && <div className="spec-stage-list">{detail.workflow.map((item) => <article key={item.key} className={statusClass(item.status)}><span>{item.number}</span><div><div><strong>{item.title}</strong><em>{item.status}</em>{item.humanAction && <small><UserRound size={11} /> 사람 확인</small>}</div><p>{item.detail}</p></div></article>)}</div>}
            {tab === 'flow' && <div className="spec-data-view"><h3><Workflow size={16} /> 동작·데이터 흐름</h3><p>각 동작의 입력은 3개 이하, 출력은 2개 이하이며 이전 출력과 다음 입력이 연결되어야 합니다.</p><pre>{detail.operations ? JSON.stringify(detail.operations, null, 2) : '동작 흐름이 아직 작성되지 않았습니다.'}</pre><h3>구성·근거 이력</h3><pre>{detail.evidence ? JSON.stringify(detail.evidence, null, 2) : '근거 이력이 아직 작성되지 않았습니다.'}</pre></div>}
            {tab === 'claims' && <div className="spec-data-view"><h3><FilePenLine size={16} /> 특허 포인트·청구항</h3><p>독립항에서 종속항으로 구체화하며 종속항에는 수학식을 사용하지 않습니다.</p><pre>{detail.claims ? JSON.stringify(detail.claims, null, 2) : '청구항이 아직 작성되지 않았습니다.'}</pre></div>}
            {tab === 'review' && <div className="spec-review-grid"><section><h3>검수 상태</h3>{Object.entries(detail.review).map(([key, value]) => <div key={key}><span>{key}</span><strong>{String(value)}</strong></div>)}</section><section><h3>최신 산출물</h3>{detail.latestOutputs.length ? detail.latestOutputs.map((item, index) => <pre key={index}>{JSON.stringify(item, null, 2)}</pre>) : <p>등록된 산출물이 없습니다.</p>}</section><section><h3>승인 기록</h3>{detail.approvals.length ? detail.approvals.map((item, index) => <pre key={index}>{JSON.stringify(item, null, 2)}</pre>) : <p>등록된 승인이 없습니다.</p>}</section><section className="wide"><h3>첫 작업 프롬프트</h3><pre>{detail.firstTaskPrompt}</pre><button onClick={() => void copyText(detail.firstTaskPrompt, '첫 작업 프롬프트')}><Clipboard size={14} /> 프롬프트 복사</button></section></div>}
            {tab === 'history' && <div className="spec-history"><section><h3>검사 이력</h3>{detail.checks.length ? detail.checks.map((item) => <article key={item.id}><span className={`spec-chip ${item.status}`}>{item.status}</span><strong>{item.stage}</strong><small>{date(item.createdAt)}</small><pre>{JSON.stringify(item.result, null, 2)}</pre></article>) : <p>검사 이력이 없습니다.</p>}</section><section><h3>DECISIONS.md</h3><pre>{detail.decisions || '결정 기록이 없습니다.'}</pre></section></div>}
          </> : <div className="spec-empty">{busy === 'detail' || loading ? <LoaderCircle className="spin" size={20} /> : <FileCheck2 size={20} />} 사건을 선택하세요.</div>}</article>
        </section>
      </main>
    </div>
  );
}
