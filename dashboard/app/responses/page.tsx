'use client';

import { ArrowLeft, Check, CheckCircle2, CircleAlert, ClipboardCheck, FileCheck2, FolderKanban, LoaderCircle, RefreshCw, ShieldCheck, Workflow } from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { readApiObject } from '../../lib/api-response';

type Stage = { number: number; key: string; title: string; detail: string; userAction: boolean; artifactKind?: string; status: '완료' | '현재' | '대기' | '차단' | '사용자 작업 필요' };
type ResponseProject = {
  noticeId: string; projectId: string | null; rowVersion: number; matterReference: string; kind: 'opinion_submission' | 'rejection_decision'; kindLabel: string;
  sequence: number | null; sequenceLabel: string; noticeDate: string; dueDate: string | null;
  package: { id: string; fileName: string; sha256: string; itemCount: number; publishedAt: string };
  project: null | { id: string; name: string; relativePath: string; clientLabel: string; creationStatus: string };
  workflow: { currentStage: number; totalStages: number; completed: boolean; blocked: boolean; blockedReason: string | null; userActionCode: string | null; actionSummary: string | null; lastReconciledAt: string | null; stages: Stage[] };
  updatedAt: string;
};
type Summary = { total: number; userAction: number; active: number; held: number; completed: number };
type Detail = {
  response: ResponseProject;
  artifacts: Array<{ id: string; stageNumber: number; artifactKind: string; relativePath: string; version: string | null; sha256: string; state: string; updatedAt: string }>;
  approvals: Array<{ id: string; approvalKind: string; decision: string; targetRelativePath: string | null; targetVersion: string | null; targetSha256: string | null; actor: string; createdAt: string }>;
  taskLinks: Array<{ id: string; taskKind: string; taskTitle: string; externalTaskId: string | null; status: string }>;
  events: Array<{ id: string; eventType: string; actor: string; createdAt: string; after: Record<string, unknown> }>;
};
type ProjectPreview = { previewToken: string; destination: string; projectName: string; existingProject: boolean; sourcePackage: { fileName: string; itemCount: number }; codex: { taskTitle: string; sharedDirectory: string } };

function formatDate(value: string | null, includeTime = false) {
  if (!value) return '미확인';
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return value;
  return new Intl.DateTimeFormat('ko-KR', includeTime ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' }).format(parsed);
}

function daysUntil(value: string | null) {
  if (!value) return null;
  const due = new Date(`${value.slice(0, 10)}T00:00:00+09:00`).getTime(), now = Date.now();
  if (!Number.isFinite(due)) return null;
  return Math.ceil((due - now) / 86_400_000);
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: 'no-store', ...options, headers: options?.body ? { 'Content-Type': 'application/json', ...options.headers } : options?.headers });
  return await readApiObject(response) as T;
}

function stageClass(status: Stage['status']) {
  if (status === '완료') return 'done';
  if (status === '현재') return 'current';
  if (status === '사용자 작업 필요') return 'user';
  if (status === '차단') return 'blocked';
  return 'pending';
}

export default function ResponsesPage() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [projects, setProjects] = useState<ResponseProject[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [detail, setDetail] = useState<Detail | null>(null);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('');
  const [userOnly, setUserOnly] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [clientLabel, setClientLabel] = useState('');
  const [projectName, setProjectName] = useState('');
  const [preview, setPreview] = useState<ProjectPreview | null>(null);
  const [artifactPath, setArtifactPath] = useState('');
  const [artifactVersion, setArtifactVersion] = useState('');
  const [selection, setSelection] = useState('');
  const [submittedAt, setSubmittedAt] = useState('');
  const [taskTitle, setTaskTitle] = useState('');
  const [externalTaskId, setExternalTaskId] = useState('');

  const selected = detail?.response ?? projects.find((item) => item.noticeId === selectedId) ?? null;
  const projectReady = Boolean(selected?.project && ['created', 'linked_existing'].includes(selected.project.creationStatus));
  const currentStage = selected?.workflow.stages.find((stage) => stage.number === selected.workflow.currentStage) ?? null;
  const dueDays = daysUntil(selected?.dueDate ?? null);

  const load = useCallback(async (preferredId?: string) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ q: query, kind, userAction: userOnly ? 'true' : '', limit: '100' });
      const [nextSummary, list] = await Promise.all([
        request<Summary>('/api/responses/summary'),
        request<{ projects: ResponseProject[] }>(`/api/responses/projects?${params}`),
      ]);
      setSummary(nextSummary); setProjects(list.projects);
      const queryNotice = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('notice') : null;
      const candidate = preferredId ?? queryNotice ?? selectedId;
      const nextId = candidate && list.projects.some((item) => item.noticeId === candidate) ? candidate : list.projects[0]?.noticeId ?? '';
      setSelectedId(nextId);
      if (nextId) {
        const nextDetail = await request<Detail>(`/api/responses/projects/${encodeURIComponent(nextId)}`);
        setDetail(nextDetail);
        setTaskTitle(`[CASE] ${nextDetail.response.matterReference} - 접수`);
      } else setDetail(null);
    } catch (error) {
      setMessage({ type: 'error', text: error instanceof Error ? error.message : '대응 프로젝트 현황을 읽지 못했습니다.' });
    } finally { setLoading(false); }
  }, [kind, query, selectedId, userOnly]);

  useEffect(() => { void load(); }, [kind, userOnly]); // 검색어는 조회 버튼에서 적용한다.

  async function choose(noticeId: string) {
    setSelectedId(noticeId); setPreview(null); setMessage(null); setArtifactPath(''); setSelection('');
    try {
      const next = await request<Detail>(`/api/responses/projects/${encodeURIComponent(noticeId)}`);
      setDetail(next); setTaskTitle(`[CASE] ${next.response.matterReference} - 접수`);
    } catch (error) { setMessage({ type: 'error', text: error instanceof Error ? error.message : '프로젝트 상세를 읽지 못했습니다.' }); }
  }

  async function previewProject(event: FormEvent) {
    event.preventDefault(); if (!selected) return;
    setBusy(true); setMessage(null);
    try {
      const result = await request<ProjectPreview>(`/api/downloads/notices/${encodeURIComponent(selected.noticeId)}/project-previews`, { method: 'POST', body: JSON.stringify({ clientLabel, projectName }) });
      setPreview(result);
    } catch (error) { setMessage({ type: 'error', text: error instanceof Error ? error.message : '프로젝트 경로를 검증하지 못했습니다.' }); }
    finally { setBusy(false); }
  }

  async function completeProject() {
    if (!selected || !preview) return;
    setBusy(true); setMessage(null);
    try {
      const endpoint = preview.existingProject ? 'project-links' : 'projects';
      await request(`/api/downloads/notices/${encodeURIComponent(selected.noticeId)}/${endpoint}`, { method: 'POST', body: JSON.stringify({ previewToken: preview.previewToken }) });
      setPreview(null); setMessage({ type: 'success', text: preview.existingProject ? '기존 프로젝트를 연결했습니다.' : '프로젝트를 안전하게 초기화했습니다.' });
      await load(selected.noticeId);
    } catch (error) { setMessage({ type: 'error', text: error instanceof Error ? error.message : '프로젝트를 연결하지 못했습니다.' }); }
    finally { setBusy(false); }
  }

  async function mutate(url: string, body: Record<string, unknown>, success: string) {
    if (!selected) return;
    setBusy(true); setMessage(null);
    try {
      await request(url, { method: 'POST', body: JSON.stringify({ ...body, expectedVersion: selected.rowVersion }) });
      setMessage({ type: 'success', text: success }); setArtifactPath(''); setArtifactVersion(''); setSelection(''); setSubmittedAt('');
      await load(selected.noticeId);
    } catch (error) { setMessage({ type: 'error', text: error instanceof Error ? error.message : '요청을 처리하지 못했습니다.' }); }
    finally { setBusy(false); }
  }

  async function reconcile() {
    if (!selected) return;
    await mutate(`/api/responses/projects/${encodeURIComponent(selected.noticeId)}/reconcile`, {}, '프로젝트 상태 파일과 승인 대상을 다시 확인했습니다.');
  }

  async function submitTask(event: FormEvent) {
    event.preventDefault(); if (!selected) return;
    await mutate(`/api/responses/projects/${encodeURIComponent(selected.noticeId)}/task-links`, { taskTitle, externalTaskId }, '접수 작업 연결을 기록하고 원본 접수 단계로 이동했습니다.');
  }

  async function completeStage(event: FormEvent) {
    event.preventDefault(); if (!selected || !currentStage) return;
    await mutate(`/api/responses/projects/${encodeURIComponent(selected.noticeId)}/stages/${currentStage.number}/complete`, { artifactPath, version: artifactVersion, submittedAt: submittedAt || null }, currentStage.number === 13 ? '접수증과 제출 결과를 기록해 대응을 완료했습니다.' : `${currentStage.number}단계를 완료했습니다.`);
  }

  async function approve(event: FormEvent) {
    event.preventDefault(); if (!selected || !currentStage) return;
    const approvalKind = currentStage.number === 7 ? 'strategy_selection' : currentStage.number === 11 ? 'submission_copy' : 'external_dispatch';
    await mutate(`/api/responses/projects/${encodeURIComponent(selected.noticeId)}/approvals`, { approvalKind, targetPath: artifactPath, version: artifactVersion, selection, submittedAt: submittedAt || null }, currentStage.number === 11 ? '제출본을 승인하고 같은 해시의 파일을 90_final로 승격했습니다.' : '사용자 승인을 기록했습니다.');
  }

  const actionPanel = useMemo(() => {
    if (!projectReady || !selected || selected.workflow.completed || selected.workflow.blocked || !currentStage) return null;
    if (currentStage.number === 3) return (
      <form className="response-action-form" onSubmit={submitTask}>
        <label>접수 작업 제목<input value={taskTitle} onChange={(event) => setTaskTitle(event.target.value)} /></label>
        <label>Codex 작업 ID 또는 메모 <small>선택</small><input value={externalTaskId} onChange={(event) => setExternalTaskId(event.target.value)} placeholder="연결한 작업 식별자" /></label>
        <button disabled={busy || !taskTitle.trim()}>{busy ? <LoaderCircle className="spin" size={14} /> : <ClipboardCheck size={14} />} 접수 작업 연결 완료</button>
      </form>
    );
    if ([4, 5, 6, 8, 9, 10, 13].includes(currentStage.number)) return (
      <form className="response-action-form" onSubmit={completeStage}>
        <label>완료 근거 파일 상대경로<input value={artifactPath} onChange={(event) => setArtifactPath(event.target.value)} placeholder={currentStage.number === 13 ? '90_final/접수증.pdf' : `${currentStage.number < 7 ? '30_analysis' : '60_review'}/산출물.md`} /></label>
        <label>버전 <small>선택</small><input value={artifactVersion} onChange={(event) => setArtifactVersion(event.target.value)} placeholder="예: v1" /></label>
        {currentStage.number === 13 && <label>실제 제출 시각 <small>선택</small><input type="datetime-local" value={submittedAt} onChange={(event) => setSubmittedAt(event.target.value)} /></label>}
        <button disabled={busy || !artifactPath.trim()}>{busy ? <LoaderCircle className="spin" size={14} /> : <FileCheck2 size={14} />} {currentStage.number === 13 ? '접수 결과 기록·완료' : '현재 단계 완료 기록'}</button>
      </form>
    );
    if ([7, 11, 12].includes(currentStage.number)) return (
      <form className="response-action-form" onSubmit={approve}>
        <label>승인 대상 상대경로<input value={artifactPath} onChange={(event) => setArtifactPath(event.target.value)} placeholder={currentStage.number === 7 ? '40_strategy/대응안.md' : currentStage.number === 11 ? '50_drafts/의견서_v3.hwpx' : '90_final/의견서_v3.hwpx'} /></label>
        <label>버전 <small>선택</small><input value={artifactVersion} onChange={(event) => setArtifactVersion(event.target.value)} placeholder="예: v3" /></label>
        {currentStage.number === 7 && <label>선택한 전략·경로<textarea rows={2} value={selection} onChange={(event) => setSelection(event.target.value)} placeholder="예: A안과 보정 문언 2를 선택" /></label>}
        {currentStage.number === 12 && <label>실제 제출 시각<input type="datetime-local" value={submittedAt} onChange={(event) => setSubmittedAt(event.target.value)} /></label>}
        <button disabled={busy || !artifactPath.trim() || (currentStage.number === 7 && !selection.trim()) || (currentStage.number === 12 && !submittedAt)}>{busy ? <LoaderCircle className="spin" size={14} /> : <ShieldCheck size={14} />} {currentStage.number === 7 ? '전략 선택 기록' : currentStage.number === 11 ? '제출본 승인·승격' : '외부 제출 결과 기록'}</button>
      </form>
    );
    return null;
  }, [artifactPath, artifactVersion, busy, currentStage, externalTaskId, projectReady, selected, selection, submittedAt, taskTitle]);

  return <div className="provisional-shell response-shell">
    <header className="provisional-header response-header">
      <a className="provisional-back" href="/"><ArrowLeft size={15} /> 업무 홈</a>
      <div className="provisional-brand"><Workflow size={18} /><span>한국특허 중간사건 대응</span></div>
      <a className="provisional-mail-link" href="/downloads">자동수집 <ArrowLeft size={14} /></a>
    </header>

    <main className="provisional-main response-main">
      <section className="provisional-intro response-intro">
        <div><span className="kicker">OFFICE ACTION RESPONSE / 13 STEPS</span><h1>통지 접수부터 제출 결과까지<br />한 단계씩 추적합니다.</h1><p>의견제출통지서와 거절결정서의 프로젝트 초기화, 분석, 전략, 초안, 검수와 사용자 승인을 분리해 기록합니다.</p></div>
        <div className="provisional-intro-badge"><ShieldCheck size={18} /><span>승인 파일 보호<br /><strong>경로·버전·SHA-256</strong></span></div>
      </section>

      <section className="response-metrics">
        <article><FolderKanban size={18} /><span>전체 대상</span><strong>{summary?.total ?? 0}</strong></article>
        <article><ClipboardCheck size={18} /><span>사용자 작업</span><strong>{summary?.userAction ?? 0}</strong></article>
        <article><Workflow size={18} /><span>진행 중</span><strong>{summary?.active ?? 0}</strong></article>
        <article><CircleAlert size={18} /><span>확인 필요</span><strong>{summary?.held ?? 0}</strong></article>
        <article><CheckCircle2 size={18} /><span>대응 완료</span><strong>{summary?.completed ?? 0}</strong></article>
      </section>

      {message && <div className={`download-message ${message.type}`}>{message.type === 'success' ? <CheckCircle2 size={16} /> : <CircleAlert size={16} />}<span>{message.text}</span></div>}

      <section className="response-filters panel">
        <form onSubmit={(event) => { event.preventDefault(); void load(); }}>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="사건번호 또는 프로젝트명" aria-label="검색" />
          <select value={kind} onChange={(event) => setKind(event.target.value)}><option value="">전체 종류</option><option value="opinion_submission">의견제출통지서</option><option value="rejection_decision">거절결정서</option></select>
          <label className="response-user-filter"><input type="checkbox" checked={userOnly} onChange={(event) => setUserOnly(event.target.checked)} /> 사용자 작업만</label>
          <button>조회</button><button type="button" className="secondary" onClick={() => void load()}><RefreshCw size={14} /> 새로고침</button>
        </form>
      </section>

      <div className="response-layout">
        <section className="response-project-list panel" aria-label="중간사건 대응 프로젝트 목록">
          <div className="panel-heading"><div><span className="panel-label">PROJECT SELECTOR</span><h2>대응 프로젝트</h2></div></div>
          {loading && !projects.length ? <div className="download-empty"><LoaderCircle className="spin" /> 불러오는 중</div> : projects.length === 0 ? <div className="download-empty">표시할 게시 완료 통지가 없습니다.</div> : projects.map((project) => <button key={project.noticeId} className={project.noticeId === selectedId ? 'selected' : ''} onClick={() => void choose(project.noticeId)}>
            <div><strong>{project.matterReference}</strong><span className={`response-kind kind-${project.kind}`}>{project.sequenceLabel}</span></div>
            <p>{project.project?.name ?? '프로젝트 초기화 전'}</p>
            <small>{String(project.workflow.currentStage).padStart(2, '0')}/13 · {project.workflow.stages[project.workflow.currentStage - 1]?.title}</small>
            <span className={`response-list-status ${project.workflow.blocked ? 'blocked' : project.workflow.completed ? 'done' : project.workflow.userActionCode ? 'user' : 'active'}`}>{project.workflow.blocked ? '확인 필요' : project.workflow.completed ? '완료' : project.workflow.userActionCode ? '사용자 작업' : '진행 중'}</span>
          </button>)}
        </section>

        <section className="response-detail panel">
          {!selected || !detail ? <div className="download-empty">왼쪽에서 대응 프로젝트를 선택하세요.</div> : <>
            <div className="response-detail-heading"><div><span className="panel-label">{selected.kindLabel}</span><h2>{selected.matterReference} · {selected.sequenceLabel}</h2><p>{selected.project?.name ?? '프로젝트 초기화 전'}</p></div><div className={`response-stage-chip ${selected.workflow.blocked ? 'blocked' : selected.workflow.completed ? 'done' : selected.workflow.userActionCode ? 'user' : ''}`}><strong>{String(selected.workflow.currentStage).padStart(2, '0')}/13</strong><span>{currentStage?.title}</span></div></div>
            <div className="response-facts">
              <div><span>통지일</span><strong>{selected.noticeDate}</strong></div>
              <div><span>마감기일</span><strong>{selected.dueDate ?? '확인 필요'}</strong><small>{dueDays === null ? '일수 계산 안 함' : dueDays < 0 ? `${Math.abs(dueDays)}일 경과` : `${dueDays}일 남음`}</small></div>
              <div><span>원본 ZIP</span><strong>{selected.package.itemCount}개 검증</strong><small>SHA-256 {selected.package.sha256.slice(0, 12)}…</small></div>
              <div><span>최근 확인</span><strong>{formatDate(selected.workflow.lastReconciledAt, true)}</strong></div>
            </div>

            {selected.workflow.actionSummary && <div className={`response-current-action ${selected.workflow.blocked ? 'blocked' : ''}`}><CircleAlert size={18} /><div><strong>{selected.workflow.blocked ? '확인 필요' : '사용자 작업'}</strong><p>{selected.workflow.actionSummary}</p></div>{selected.project && <button onClick={() => void reconcile()} disabled={busy}><RefreshCw size={13} /> 상태 다시 확인</button>}</div>}

            {!projectReady && <form className="response-init" onSubmit={previewProject}>
              <div><FolderKanban size={18} /><strong>새 프로젝트 초기화 또는 기존 프로젝트 연결</strong><span>{selected.package.fileName}</span></div>
              <label>의뢰인식별명<input value={clientLabel} onChange={(event) => { setClientLabel(event.target.value); setPreview(null); }} placeholder="예: 이문원바이오" /></label>
              <label>프로젝트명 <small>비우면 자동 생성</small><input value={projectName} onChange={(event) => { setProjectName(event.target.value); setPreview(null); }} placeholder={`${selected.matterReference}_의뢰인_${selected.sequenceLabel}`} /></label>
              <button disabled={busy || !clientLabel.trim()}>{busy ? <LoaderCircle className="spin" size={14} /> : <ShieldCheck size={14} />} 경로·원본 검증</button>
              {preview && <div className="response-preview"><strong>{preview.destination}</strong><span>{preview.existingProject ? '기존 프로젝트의 사건번호·통지일·구조 확인 완료' : `원본 ${preview.sourcePackage.itemCount}개 · 새 프로젝트 생성 가능`}</span><button type="button" disabled={busy} onClick={() => void completeProject()}>{preview.existingProject ? '기존 프로젝트 연결' : '검증 결과로 프로젝트 생성'}</button></div>}
            </form>}

            {actionPanel}

            <div className="response-toolbar">{projectReady && <><button onClick={() => void reconcile()} disabled={busy}><RefreshCw size={14} /> 프로젝트 상태 재확인</button><a href={`/downloads?notice=${encodeURIComponent(selected.noticeId)}`}>다운로드 근거 보기</a></>}</div>
          </>}
        </section>
      </div>

      {selected && <section className="panel tracker-panel response-tracker">
        <div className="panel-heading"><div><span className="panel-label">RESPONSE WORKFLOW</span><h2>13단계 진행 순서</h2><p>{selected.matterReference}의 현재 단계와 사용자 승인이 필요한 지점을 표시합니다.</p></div><span className="tracker-legend"><i className="legend-dot done" /> 완료 <i className="legend-dot current" /> 현재 <i className="legend-dot user" /> 사용자 작업</span></div>
        <div className="stage-list">{selected.workflow.stages.map((stage) => <article className={`stage-card status-${stageClass(stage.status)}`} key={stage.number}><div className="stage-number">{stage.status === '완료' ? <Check size={15} /> : String(stage.number).padStart(2, '0')}</div><div className="stage-copy"><div className="stage-title-row"><strong>{stage.title}</strong><span className="stage-status">{stage.status === '사용자 작업 필요' ? '사용자 작업' : stage.status}</span></div><p>{stage.detail}</p></div>{stage.status === '사용자 작업 필요' && <span className="user-action-badge">사용자 확인</span>}</article>)}</div>
      </section>}

      {detail && projectReady && <section className="response-evidence-grid">
        <article className="panel"><div className="panel-heading"><div><span className="panel-label">ARTIFACTS</span><h2>단계 산출물</h2></div></div>{detail.artifacts.length ? <div className="response-record-list">{detail.artifacts.map((item) => <div key={item.id}><span className={`record-state ${item.state}`}>{item.state}</span><div><strong>{item.relativePath}</strong><small>{String(item.stageNumber).padStart(2, '0')}단계 · {item.artifactKind} · SHA-256 {item.sha256.slice(0, 12)}…</small></div></div>)}</div> : <div className="download-empty">기록된 단계 산출물이 없습니다.</div>}</article>
        <article className="panel"><div className="panel-heading"><div><span className="panel-label">APPROVALS</span><h2>사용자 승인</h2></div></div>{detail.approvals.length ? <div className="response-record-list">{detail.approvals.map((item) => <div key={item.id}><span className={`record-state ${item.decision}`}>{item.decision}</span><div><strong>{item.approvalKind}</strong><small>{item.targetRelativePath ?? '대상 없음'} · {formatDate(item.createdAt, true)}</small></div></div>)}</div> : <div className="download-empty">전략 또는 제출본 승인 기록이 없습니다.</div>}</article>
        <article className="panel"><div className="panel-heading"><div><span className="panel-label">HISTORY</span><h2>최근 진행 이력</h2></div></div>{detail.events.length ? <div className="response-record-list">{detail.events.slice(0, 10).map((item) => <div key={item.id}><span className="record-state event">event</span><div><strong>{item.eventType}</strong><small>{item.actor} · {formatDate(item.createdAt, true)}</small></div></div>)}</div> : <div className="download-empty">프로젝트 진행 이력이 없습니다.</div>}</article>
      </section>}
    </main>
  </div>;
}
