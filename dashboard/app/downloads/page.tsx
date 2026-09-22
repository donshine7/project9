'use client';

import { ArrowLeft, CheckCircle2, CircleAlert, Clock3, Download, FileArchive, FolderPlus, LoaderCircle, Mail, RefreshCw, ShieldCheck, Workflow } from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { readApiObject } from '../../lib/api-response';

type AutomationFeature = { detectionEnabled: boolean; automaticPublishEnabled: boolean; projectCreationEnabled: boolean };
type Summary = {
  automation: { schedulerEnabled: boolean; outlookDetectionEnabled: boolean; timezone: string; dailyRunTime: string; nextScheduledAt: string; features: Record<string, AutomationFeature> };
  lastRun: DetectionRun | null;
  recoveryFrom: string | null;
  counts: { total: number; pending: number; active: number; held: number; failed: number; publishedToday: number };
};
type DetectionRun = { id: string; scheduledFor: string; startedAt: string | null; completedAt: string | null; recoveryFrom: string | null; scanTo: string | null; status: string; detectedMailCount: number; candidateCount: number; publishedCount: number; heldCount: number; failedCount: number; errorCode: string | null };
type Notice = {
  id: string; rowVersion: number; matterReference: string; kind: string; kindLabel: string; sequence: number | null;
  noticeDate: string; dueDate: string | null; noticeStatus: string; stage: { key: string; label: string };
  mailCount: number; attachmentTotal: number; attachmentVerified: number; progress: { processed: number; total: number } | null;
  job: null | { id: string; status: string; expectedFileName: string; errorCode: string | null };
  package: null | { id: string; fileName: string; sha256: string; itemCount: number; publishedAt: string };
  project: { id: string | null; name: string | null; relativePath: string | null; creationStatus: string | null; key: string; label: string; userActionCode: string | null; actionSummary: string | null };
  updatedAt: string;
};
type NoticeDetail = { notice: Notice; attachments: Array<{ id: string; fileName: string; state: string; fileSizeBytes: number }>; mails: Array<{ id: string; subject: string; mailAt: string; role: string }>; jobs: Array<{ id: string; status: string; errorCode: string | null }>; events: Array<{ id: string; stageKey: string; status: string; occurredAt: string; errorCode: string | null }> };
type ProjectPreview = { previewToken: string; destination: string; projectName: string; existingProject: boolean; sourcePackage: { fileName: string; itemCount: number }; codex: { taskTitle: string; sharedDirectory: string } };

const kindOptions = [
  ['', '전체 통지'],
  ['opinion_submission', '의견제출통지서'],
  ['rejection_decision', '거절결정서'],
  ['priority_exam_supplement_request', '우선심사 보완'],
];
const statusOptions = [['', '전체 상태'], ['candidate', '메일 감지'], ['ready', '원본 확인'], ['downloading', '다운로드'], ['published', '게시 완료'], ['held', '확인 필요'], ['failed', '실패']];

function formatDate(value: string | null) {
  if (!value) return '미확인';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: value.length > 10 ? 'short' : undefined }).format(date) : value;
}

function sequenceLabel(notice: Notice) {
  if (!notice.sequence) return '차수 미확정';
  return notice.kind === 'opinion_submission' ? `${notice.sequence}OA` : `${notice.sequence}차`;
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: 'no-store', ...options, headers: options?.body ? { 'Content-Type': 'application/json', ...options.headers } : options?.headers });
  return await readApiObject(response) as T;
}

export default function DownloadsPage() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [runs, setRuns] = useState<DetectionRun[]>([]);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [detail, setDetail] = useState<NoticeDetail | null>(null);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('');
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [clientLabel, setClientLabel] = useState('');
  const [projectName, setProjectName] = useState('');
  const [preview, setPreview] = useState<ProjectPreview | null>(null);

  const active = useMemo(() => notices.some((notice) => ['queued', 'downloading', 'staged', 'verified'].includes(notice.stage.key)), [notices]);
  const selected = detail?.notice ?? notices.find((notice) => notice.id === selectedId) ?? null;
  const projectEnabled = selected ? Boolean(summary?.automation.features[selected.kind]?.projectCreationEnabled) : false;

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const params = new URLSearchParams({ q: query, kind, status, limit: '100' });
      const [nextSummary, list, runList] = await Promise.all([
        request<Summary>('/api/downloads/summary'),
        request<{ notices: Notice[] }>(`/api/downloads/notices?${params}`),
        request<{ runs: DetectionRun[] }>('/api/downloads/runs?limit=10'),
      ]);
      setSummary(nextSummary); setNotices(list.notices); setRuns(runList.runs);
      const requestedId = selectedId || (typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('notice') ?? '' : '');
      const nextId = requestedId && list.notices.some((item) => item.id === requestedId) ? requestedId : list.notices[0]?.id ?? '';
      setSelectedId(nextId);
      if (nextId) setDetail(await request<NoticeDetail>(`/api/downloads/notices/${encodeURIComponent(nextId)}`)); else setDetail(null);
    } catch (error) {
      setMessage({ type: 'error', text: error instanceof Error ? error.message : '다운로드 현황을 읽지 못했습니다.' });
    } finally { setLoading(false); }
  }, [kind, query, selectedId, status]);

  useEffect(() => { void load(); }, [kind, status]); // 검색어는 조회 버튼에서 적용한다.
  useEffect(() => {
    const timer = window.setInterval(() => void load(true), active ? 5000 : 60000);
    return () => window.clearInterval(timer);
  }, [active, load]);

  async function selectNotice(id: string) {
    setSelectedId(id); setPreview(null); setProjectName(''); setMessage(null);
    try { setDetail(await request<NoticeDetail>(`/api/downloads/notices/${encodeURIComponent(id)}`)); }
    catch (error) { setMessage({ type: 'error', text: error instanceof Error ? error.message : '상세 정보를 읽지 못했습니다.' }); }
  }

  async function requestRecovery(mode: 'recheck' | 'resume') {
    if (!selected) return;
    setBusy(true); setMessage(null);
    try {
      const url = mode === 'recheck' ? `/api/downloads/notices/${encodeURIComponent(selected.id)}/recheck-requests` : `/api/downloads/jobs/${encodeURIComponent(selected.job?.id ?? '')}/resume-requests`;
      await request(url, { method: 'POST', body: JSON.stringify({ expectedVersion: selected.rowVersion }) });
      setMessage({ type: 'success', text: mode === 'recheck' ? '다시 검증 요청을 등록했습니다.' : '실패 지점부터 재개 요청을 등록했습니다.' });
      await load(true);
    } catch (error) { setMessage({ type: 'error', text: error instanceof Error ? error.message : '요청을 등록하지 못했습니다.' }); }
    finally { setBusy(false); }
  }

  async function previewProject(event: FormEvent) {
    event.preventDefault(); if (!selected) return;
    setBusy(true); setMessage(null);
    try {
      const result = await request<ProjectPreview>(`/api/downloads/notices/${encodeURIComponent(selected.id)}/project-previews`, { method: 'POST', body: JSON.stringify({ clientLabel, projectName }) });
      setPreview(result); setProjectName(result.projectName);
      setMessage({ type: 'success', text: '경로, 템플릿과 원본 ZIP 검증이 끝났습니다. 아래 생성 경로를 확인하세요.' });
    } catch (error) { setPreview(null); setMessage({ type: 'error', text: error instanceof Error ? error.message : '프로젝트 미리보기에 실패했습니다.' }); }
    finally { setBusy(false); }
  }

  async function completeProject() {
    if (!selected || !preview) return;
    setBusy(true); setMessage(null);
    try {
      const endpoint = preview.existingProject ? 'project-links' : 'projects';
      const result = await request<{ path: string; taskTitle?: string; actionSummary: string }>(`/api/downloads/notices/${encodeURIComponent(selected.id)}/${endpoint}`, { method: 'POST', body: JSON.stringify({ previewToken: preview.previewToken }) });
      setPreview(null); setMessage({ type: 'success', text: `${preview.existingProject ? '기존 프로젝트 연결' : '프로젝트 생성'} 완료: ${result.path} · 다음 동작: ${result.actionSummary ?? '없음'}` });
      await load(true);
    } catch (error) { setMessage({ type: 'error', text: error instanceof Error ? error.message : '프로젝트 생성에 실패했습니다.' }); }
    finally { setBusy(false); }
  }

  return <div className="download-page">
    <header className="download-header">
      <a href="/" className="download-back"><ArrowLeft size={16} /> 업무 홈</a>
      <div><span>AUTOMATED INTAKE</span><h1>통지서 자동 다운로드</h1></div>
      <button className="download-refresh" onClick={() => void load()} disabled={loading}><RefreshCw className={loading ? 'spin' : ''} size={15} /> 새로고침</button>
    </header>

    <main className="download-main">
      <section className="download-hero">
        <div><span className="panel-label">DAILY NOTICE PIPELINE</span><h2>메일 감지부터 대응 프로젝트까지</h2><p>수신인이 장진태인 Outlook 메일을 사건 단위로 합치고, 검증된 EasyPAT 첨부를 하나의 ZIP과 대응 프로젝트로 연결합니다.</p></div>
        <div className={`automation-state ${summary?.automation.schedulerEnabled ? 'enabled' : 'disabled'}`}><ShieldCheck size={22} /><div><strong>{summary?.automation.schedulerEnabled ? '일일 자동 실행 활성' : '자동 실행 검증 대기'}</strong><span>매일 {summary?.automation.dailyRunTime ?? '09:00'} · {summary?.automation.timezone ?? 'Asia/Seoul'}</span></div></div>
      </section>

      <section className="download-metrics">
        <article><Download size={18} /><span>오늘 게시</span><strong>{summary?.counts.publishedToday ?? 0}</strong></article>
        <article><Clock3 size={18} /><span>처리 대기</span><strong>{summary?.counts.pending ?? 0}</strong></article>
        <article><Workflow size={18} /><span>진행 중</span><strong>{summary?.counts.active ?? 0}</strong></article>
        <article><CircleAlert size={18} /><span>확인·실패</span><strong>{(summary?.counts.held ?? 0) + (summary?.counts.failed ?? 0)}</strong></article>
      </section>

      <section className="download-schedule panel">
        <div><span>다음 예정</span><strong>{summary?.automation.schedulerEnabled ? formatDate(summary.automation.nextScheduledAt) : '스케줄러 비활성'}</strong></div>
        <div><span>재감지 시작점</span><strong>{formatDate(summary?.recoveryFrom ?? null)}</strong></div>
        <div><span>최근 실행</span><strong>{summary?.lastRun ? `${summary.lastRun.status} · ${formatDate(summary.lastRun.startedAt)}` : '실행 기록 없음'}</strong></div>
        <p>미완료 통지의 가장 오래된 연결 메일부터 다시 확인합니다. 동일 사건의 업무요청·담당자지정 메일은 한 통지로 묶습니다.</p>
      </section>

      {message && <div className={`download-message ${message.type}`}>{message.type === 'success' ? <CheckCircle2 size={16} /> : <CircleAlert size={16} />}<span>{message.text}</span></div>}

      <section className="download-filters panel">
        <form onSubmit={(event) => { event.preventDefault(); void load(); }}>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="사건번호 검색" aria-label="사건번호 검색" />
          <select value={kind} onChange={(event) => setKind(event.target.value)} aria-label="통지 종류">{kindOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
          <select value={status} onChange={(event) => setStatus(event.target.value)} aria-label="처리 상태">{statusOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
          <button>조회</button>
        </form>
      </section>

      <div className="download-layout">
        <section className="download-list panel" aria-label="통지 작업 목록">
          {loading && !notices.length ? <div className="download-empty"><LoaderCircle className="spin" /> 불러오는 중</div> : notices.length === 0 ? <div className="download-empty">조건에 맞는 통지가 없습니다.</div> : notices.map((notice) => <button key={notice.id} className={notice.id === selectedId ? 'selected' : ''} onClick={() => void selectNotice(notice.id)}>
            <div className="notice-title"><strong>{notice.matterReference}</strong><span className={`notice-status status-${notice.stage.key}`}>{notice.stage.label}</span></div>
            <p>{notice.kindLabel} · {sequenceLabel(notice)}</p>
            <small>통지 {notice.noticeDate} · 마감 {notice.dueDate ?? '미확인'} · 메일 {notice.mailCount}건</small>
            <div className="notice-progress"><span style={{ width: `${notice.attachmentTotal ? Math.round(notice.attachmentVerified / notice.attachmentTotal * 100) : 0}%` }} /></div>
          </button>)}
        </section>

        <section className="download-detail panel">
          {!selected || !detail ? <div className="download-empty">왼쪽에서 통지 작업을 선택하세요.</div> : <>
            <div className="detail-heading"><div><span className="panel-label">{selected.kindLabel}</span><h2>{selected.matterReference} · {sequenceLabel(selected)}</h2></div><span className={`notice-status status-${selected.stage.key}`}>{selected.stage.label}</span></div>
            <div className="detail-facts">
              <div><span>통지일</span><strong>{selected.noticeDate}</strong></div><div><span>마감기일</span><strong>{selected.dueDate ?? '확인 필요'}</strong></div><div><span>연결 메일</span><strong>{selected.mailCount}건</strong></div><div><span>검증 첨부</span><strong>{selected.attachmentVerified}/{selected.attachmentTotal}</strong></div>
            </div>
            <div className="pipeline-flow">
              {['메일 감지', '사건·통지 병합', 'EasyPAT 조회', 'ZIP 검증·게시', '프로젝트 생성'].map((label, index) => <div key={label}><span>{index + 1}</span><strong>{label}</strong></div>)}
            </div>
            {selected.project.actionSummary && <div className="user-action"><CircleAlert size={17} /><div><strong>사용자 동작 필요</strong><p>{selected.project.actionSummary}</p></div></div>}

            <div className="detail-grid">
              <section><h3><Mail size={15} /> 중복 병합 근거</h3>{detail.mails.length ? detail.mails.map((mail) => <article key={mail.id}><strong>{mail.subject}</strong><small>{mail.role} · {formatDate(mail.mailAt)}</small></article>) : <p>연결 메일 없음</p>}</section>
              <section><h3><FileArchive size={15} /> ZIP 및 첨부</h3>{selected.package && <article><strong>{selected.package.fileName}</strong><small>{selected.package.itemCount}개 · SHA-256 {selected.package.sha256.slice(0, 12)}…</small></article>}{detail.attachments.map((item) => <article key={item.id}><strong>{item.fileName}</strong><small>{item.state} · {item.fileSizeBytes.toLocaleString()} bytes</small></article>)}</section>
            </div>

            {(selected.noticeStatus === 'held' || selected.job?.status === 'failed' || selected.job?.status === 'held') && <div className="recovery-actions">
              {selected.noticeStatus === 'held' && <button disabled={busy} onClick={() => void requestRecovery('recheck')}>근거 다시 검증</button>}
              {selected.job && ['failed', 'held'].includes(selected.job.status) && <button disabled={busy} onClick={() => void requestRecovery('resume')}>실패 지점부터 재개</button>}
            </div>}

            {selected.package && !selected.project.id && <form className="project-create" onSubmit={previewProject}>
              <div className="project-create-heading"><FolderPlus size={18} /><div><strong>대응 프로젝트 만들기 또는 연결</strong><span>{projectEnabled ? '먼저 dry-run 미리보기를 실행합니다.' : '새 폴더 생성은 검증 대기이며, 동일 사건의 기존 폴더 연결은 확인할 수 있습니다.'}</span></div></div>
              <label>의뢰인식별명<input value={clientLabel} onChange={(event) => { setClientLabel(event.target.value); setPreview(null); }} placeholder="예: 이문원바이오" /></label>
              <label>프로젝트명 <small>비우면 자동 생성</small><input value={projectName} onChange={(event) => { setProjectName(event.target.value); setPreview(null); }} placeholder={`${selected.matterReference}_의뢰인_${selected.kind === 'opinion_submission' ? sequenceLabel(selected) : '통지'}`} /></label>
              <button disabled={busy || !clientLabel.trim()}>{busy ? <LoaderCircle className="spin" size={14} /> : <ShieldCheck size={14} />} 경로·원본 검증</button>
              {preview && <div className="project-preview"><strong>{preview.destination}</strong><span>{preview.existingProject ? '기존 폴더의 사건번호·통지일·구조 확인 완료' : `원본 ${preview.sourcePackage.fileName} · ${preview.sourcePackage.itemCount}개`}</span><span>{preview.existingProject ? '기존 작업 상태를 읽어 원장에 연결합니다.' : `생성 후 Codex 작업: ${preview.codex.taskTitle}`}</span><button type="button" disabled={busy} onClick={() => void completeProject()}>{preview.existingProject ? '기존 프로젝트 연결' : '검증 결과로 프로젝트 생성'}</button></div>}
            </form>}

            {selected.project.id && <div className="project-linked"><CheckCircle2 size={18} /><div><strong>{selected.project.name}</strong><span>{selected.project.label} · {selected.project.relativePath}</span></div><a href={`/responses?notice=${encodeURIComponent(selected.id)}`}>대응 화면 열기</a></div>}
          </>}
        </section>
      </div>

      <section className="download-runs panel"><h2>최근 일일 감지 실행</h2>{runs.length ? runs.map((run) => <article key={run.id}><span className={`notice-status status-${run.status}`}>{run.status}</span><strong>{formatDate(run.startedAt ?? run.scheduledFor)}</strong><small>메일 {run.detectedMailCount} · 후보 {run.candidateCount} · 게시 {run.publishedCount} · 확인 {run.heldCount} · 실패 {run.failedCount}</small></article>) : <div className="download-empty">실행 기록이 없습니다. 스케줄러 활성화 전 검증 상태입니다.</div>}</section>
    </main>
  </div>;
}
