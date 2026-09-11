'use client';

import { ArrowLeft, Check, CircleAlert, FolderKanban, LoaderCircle, RefreshCw, ShieldCheck } from 'lucide-react';
import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { stageStatus, type WorkflowStatus, workflowStages } from '../workflow';

type Stage = (typeof workflowStages)[number] & { status: WorkflowStatus };

type Project = {
  id: string;
  name: string;
  currentStage: number;
  blocked: boolean;
  statusUpdatedAt: string | null;
  ptCaseNumbers: string[];
  artifacts: { original: boolean; contract: boolean; draft: boolean; audit: boolean; render: boolean; output: boolean };
  stages: Stage[];
};

const fixedRoot = 'C:\\ChatGPT\\AI-Work\\10_특허\\한국특허가출원';

function statusLabel(status: WorkflowStatus) {
  return status === '사용자 작업 필요' ? '사용자 작업' : status;
}

export default function ProvisionalPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [projectName, setProjectName] = useState('');
  const [ptCaseNumbers, setPtCaseNumbers] = useState('PT261225');
  const [dryRun, setDryRun] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  const selectedProject = useMemo(() => projects.find((project) => project.id === selectedId) ?? null, [projects, selectedId]);

  async function loadProjects(preferredId?: string) {
    setLoading(true);
    try {
      const response = await fetch('/api/projects', { cache: 'no-store' });
      const payload = await response.json();
      const nextProjects = Array.isArray(payload.projects) ? payload.projects : [];
      setProjects(nextProjects);
      const queryProject = new URLSearchParams(window.location.search).get('project');
      const nextSelected = preferredId ?? queryProject ?? selectedId;
      if (nextSelected && nextProjects.some((project: Project) => project.id === nextSelected)) setSelectedId(nextSelected);
      else if (!selectedId && nextProjects[0]) setSelectedId(nextProjects[0].id);
    } catch {
      setNotice({ kind: 'error', text: '프로젝트 목록을 읽지 못했습니다. 로컬 개발 서버 상태를 확인하세요.' });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadProjects();
    // The initial load intentionally runs once; subsequent refreshes are explicit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const parsedCases = useMemo(() => ptCaseNumbers.split(/[\s,;]+/).map((value) => value.trim().toUpperCase()).filter(Boolean), [ptCaseNumbers]);

  async function initializeProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNotice(null);
    const normalizedName = projectName.trim();
    const validName = /^[A-Za-z0-9가-힣][A-Za-z0-9가-힣 _-]{1,79}$/.test(normalizedName) && !normalizedName.includes('..');
    const validCases = parsedCases.length > 0 && parsedCases.every((value) => /^PT\d{6}(?:-[A-Z0-9]+)*$/.test(value));
    if (!validName) {
      setNotice({ kind: 'error', text: '프로젝트명은 2~80자의 한글·영문·숫자·공백·하이픈만 사용할 수 있습니다.' });
      return;
    }
    if (!validCases) {
      setNotice({ kind: 'error', text: 'PT 사건번호는 PT + 숫자 6자리 형식이어야 합니다. 예: PT261225' });
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch('/api/projects/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectName: normalizedName, ptCaseNumbers: parsedCases, dryRun }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? '초기화에 실패했습니다.');
      if (dryRun) {
        setNotice({ kind: 'success', text: `검증 완료: ${payload.destination}에 생성할 수 있습니다. 실제 폴더는 만들지 않았습니다.` });
      } else {
        setNotice({ kind: 'success', text: '프로젝트가 초기화되었습니다. 3단계 원본 자료 투입이 현재 단계로 선택되었습니다.' });
        setProjectName('');
        await loadProjects(normalizedName);
      }
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : '초기화에 실패했습니다.' });
    } finally {
      setSubmitting(false);
    }
  }

  const trackerStages: Stage[] = selectedProject?.stages ?? workflowStages.map((stage) => ({ ...stage, status: stageStatus(stage.id, 1) }));

  return (
    <div className="provisional-shell">
      <header className="provisional-header">
        <a className="provisional-back" href="/"><ArrowLeft size={15} /> 업무 시작</a>
        <div className="provisional-brand"><FolderKanban size={18} /><span>한국특허 가출원 작성</span></div>
        <a className="provisional-mail-link" href="/mail">메일 운영판 <ArrowLeft size={14} /></a>
      </header>

      <main className="provisional-main">
        <section className="provisional-intro">
          <div><span className="kicker">PATENT WORKFLOW / 13 STEPS</span><h1>한국특허 가출원<br />작업을 추적합니다.</h1><p>프로젝트를 초기화한 뒤 원본 투입부터 HWPX 승격까지, 사람의 확인이 필요한 지점을 분명하게 표시합니다.</p></div>
          <div className="provisional-intro-badge"><ShieldCheck size={18} /><span>로컬 전용<br /><strong>고정 경로 보호</strong></span></div>
        </section>

        <section className="provisional-control-grid">
          <article className="panel project-selector-panel">
            <div className="panel-heading"><div><span className="panel-label">PROJECT SELECTOR</span><h2>작업 프로젝트</h2><p>고정된 한국특허 가출원 루트 아래 항목만 읽습니다.</p></div><button type="button" className="icon-button" onClick={() => void loadProjects()} aria-label="프로젝트 새로고침"><RefreshCw size={15} /></button></div>
            <label className="field-label" htmlFor="project-select">현재 프로젝트</label>
            <select id="project-select" className="project-select" value={selectedId} disabled={loading} onChange={(event) => setSelectedId(event.target.value)}>
              <option value="">{loading ? '프로젝트 목록을 불러오는 중입니다' : '프로젝트를 선택하세요'}</option>
              {projects.map((project) => <option value={project.id} key={project.id}>{project.name} · {project.currentStage}/13단계</option>)}
            </select>
            {selectedProject ? <div className="selected-project-summary"><div><strong>{selectedProject.name}</strong><span>{selectedProject.ptCaseNumbers.join(', ')}</span></div><span className={selectedProject.blocked ? 'project-status blocked' : 'project-status'}>{selectedProject.blocked ? '차단' : `현재 ${selectedProject.currentStage}단계`}</span></div> : <div className="selector-empty"><FolderKanban size={18} /><span>초기화된 프로젝트가 없거나 선택되지 않았습니다.</span></div>}
          </article>

          <article className="panel init-panel">
            <div className="panel-heading"><div><span className="panel-label">SAFE INITIALIZATION</span><h2>새 프로젝트 초기화</h2><p>기존 폴더가 있으면 실패하며 덮어쓰지 않습니다.</p></div></div>
            <form id="project-init-form" onSubmit={initializeProject}>
              <label className="field-label" htmlFor="project-name">프로젝트명</label>
              <input id="project-name" className="text-input" value={projectName} onChange={(event) => setProjectName(event.target.value)} placeholder="예: 2026_가출원_신규플랫폼" maxLength={80} />
              <label className="field-label" htmlFor="pt-numbers">PT 사건번호 목록</label>
              <textarea id="pt-numbers" className="text-input text-area" value={ptCaseNumbers} onChange={(event) => setPtCaseNumbers(event.target.value)} placeholder="PT261225, PT261226-S1" rows={3} />
              <div className="path-preview"><span>생성 예정 경로</span><code>{fixedRoot}\\{projectName.trim() || '프로젝트명'}</code></div>
              <label className="dry-run-toggle"><input type="checkbox" checked={dryRun} onChange={(event) => setDryRun(event.target.checked)} /><span>검증만 실행(dry-run) · 실제 폴더를 만들지 않음</span></label>
              <button className="primary-button" type="submit" disabled={submitting}>{submitting ? <LoaderCircle size={16} className="spin" /> : <FolderKanban size={16} />}{dryRun ? '초기화 검증' : '프로젝트 초기화 실행'}</button>
            </form>
            {notice && <div className={`form-notice ${notice.kind}`}><CircleAlert size={15} /><span>{notice.text}</span></div>}
          </article>
        </section>

        <section className="panel tracker-panel">
          <div className="panel-heading"><div><span className="panel-label">WORKFLOW TRACKER</span><h2>13단계 진행 순서</h2><p>{selectedProject ? `${selectedProject.name}의 현재 단계가 강조되어 있습니다.` : '프로젝트를 선택하면 현재 단계와 산출물 상태가 표시됩니다.'}</p></div><span className="tracker-legend"><i className="legend-dot done" /> 완료 <i className="legend-dot current" /> 현재 <i className="legend-dot user" /> 사용자 작업</span></div>
          <div className="stage-list">{trackerStages.map((stage) => <article className={`stage-card status-${stage.status === '사용자 작업 필요' ? 'user' : stage.status === '현재' ? 'current' : stage.status === '완료' ? 'done' : stage.status === '차단' ? 'blocked' : 'pending'}`} key={stage.id}><div className="stage-number">{stage.status === '완료' ? <Check size={15} /> : String(stage.id).padStart(2, '0')}</div><div className="stage-copy"><div className="stage-title-row"><strong>{stage.title}</strong><span className="stage-status">{statusLabel(stage.status)}</span></div><p>{stage.detail}</p></div>{stage.userAction && <span className="user-action-badge">사용자 확인</span>}{stage.id === 2 && <button className="stage-action-button" type="submit" form="project-init-form" disabled={submitting}>{submitting ? <LoaderCircle size={13} className="spin" /> : <FolderKanban size={13} />}{dryRun ? '초기화 검증' : '프로젝트 초기화 실행'}</button>}</article>)}</div>
        </section>

        <section className="artifact-panel panel"><div className="panel-heading"><div><span className="panel-label">PROJECT ARTIFACTS</span><h2>산출물 확인</h2><p>프로젝트를 선택하면 구조적인 존재 여부만 안전하게 표시합니다.</p></div></div><div className="artifact-grid">{[['original', '10_source_original', '원본 자료'], ['contract', 'patent.project.json', 'JSON 계약'], ['draft', '40_draft/*.hwpx', '초안 HWPX'], ['audit', '*audit* / 감사 보고서', '독립 검사'], ['render', '*render*.pdf', '렌더 PDF'], ['output', 'outputs/*.hwpx', '승격 HWPX']].map(([key, label, title]) => { const present = selectedProject?.artifacts[key as keyof Project['artifacts']] ?? false; return <div className={`artifact-item ${present ? 'present' : ''}`} key={key}><span className="artifact-state">{present ? <Check size={13} /> : '—'}</span><div><strong>{title}</strong><span>{label}</span></div></div>; })}</div></section>

        <div className="provisional-footnote"><ShieldCheck size={15} /><span>초기화 API는 localhost 요청만 허용하고, 고정 PowerShell 스크립트를 shell 없이 호출합니다. 실제 생성 버튼은 이 페이지에서만 실행됩니다.</span></div>
      </main>
    </div>
  );
}
