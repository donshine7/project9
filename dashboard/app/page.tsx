'use client';

import { ArrowRight, BriefcaseBusiness, FolderKanban, Mail, RefreshCw, Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import { workflowStages } from './workflow';

const launcherPath = String.raw`C:\Users\donsh\OneDrive\Documents\project9_workflow_automation\dashboard\대시보드 실행.cmd`;

type ProjectSummary = {
  id: string;
  name: string;
  currentStage: number;
  blocked: boolean;
  ptCaseNumbers: string[];
};

export default function StartPage() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);

  async function loadProjects() {
    try {
      const response = await fetch('/api/projects', { cache: 'no-store' });
      const payload = await response.json();
      setProjects(payload.projects ?? []);
    } catch {
      setProjects([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadProjects();
  }, []);

  return (
    <div className="workspace-shell">
      <header className="workspace-header">
        <a className="brand-lockup" href="/">
          <div className="brand-mark" aria-hidden="true"><Sparkles size={18} /></div>
          <div><strong>상상특허</strong><span>Workflow workspace</span></div>
        </a>
        <div className="workspace-header-meta"><span className="live-dot" /> 로컬 전용 · 127.0.0.1:4173</div>
      </header>

      <main className="workspace-main">
        <section className="workspace-launcher panel" aria-labelledby="launcher-title">
          <div className="workspace-launcher-copy">
            <span className="panel-label">LOCAL SERVER CHECK</span>
            <h2 id="launcher-title">대시보드 접속 전 확인</h2>
            <p>PC를 켰거나 대시보드 서버가 종료된 경우 아래 파일을 먼저 실행하세요. 서버가 이미 실행 중이면 생략할 수 있습니다.</p>
          </div>
          <div className="workspace-launcher-details">
            <div><span>실행 파일</span><code>{launcherPath}</code></div>
            <div><span>실행 후 접속 주소</span><code>http://127.0.0.1:4173/</code></div>
            <strong>파일 탐색기에서 위 CMD 파일을 더블클릭하세요.</strong>
            <small>웹 브라우저에서는 보안상 CMD 파일을 직접 실행할 수 없습니다.</small>
          </div>
        </section>

        <section className="workspace-hero">
          <div>
            <span className="kicker">WORKSPACE HOME</span>
            <h1>오늘의 업무를<br />안전하게 시작합니다.</h1>
            <p>메일 자동분류와 한국특허 가출원 작성을 한 화면에서 선택하고, 각 작업의 현재 단계를 확인하세요.</p>
          </div>
          <div className="workspace-hero-mark" aria-hidden="true"><BriefcaseBusiness size={54} strokeWidth={1.4} /></div>
        </section>

        <section className="workspace-grid" aria-label="업무 선택">
          <a className="workspace-card workspace-card-mail" href="/mail">
            <div className="workspace-card-icon"><Mail size={22} /></div>
            <span className="workspace-card-eyebrow">MAIL OPERATIONS</span>
            <h2>Hiworks · Outlook (classic)</h2>
            <p>현재 적용 중인 Hiworks 메일 자동분류 정책, 폴더 체계, 실행 위치와 변경 이력을 확인합니다.</p>
            <span className="workspace-card-link">운영 대시보드 열기 <ArrowRight size={16} /></span>
          </a>
          <a className="workspace-card workspace-card-patent" href="/provisional">
            <div className="workspace-card-icon"><FolderKanban size={22} /></div>
            <span className="workspace-card-eyebrow">PATENT WORKFLOW</span>
            <h2>한국특허 가출원 작성</h2>
            <p>프로젝트 초기화부터 원본 투입, HWPX 생성, 독립 검사와 시각 검수까지 진행 상태를 관리합니다.</p>
            <span className="workspace-card-link">작업 페이지 열기 <ArrowRight size={16} /></span>
          </a>
        </section>

        <section className="workspace-projects panel">
          <div className="workspace-section-heading">
            <div><span className="panel-label">ACTIVE PROJECTS</span><h2>한국특허 가출원 프로젝트</h2><p>고정 루트에서 읽은 프로젝트만 표시합니다.</p></div>
            <button type="button" className="icon-button" onClick={() => { setLoading(true); void loadProjects(); }} aria-label="프로젝트 새로고침"><RefreshCw size={15} /></button>
          </div>
          {loading ? <div className="workspace-empty">프로젝트 목록을 읽는 중입니다…</div> : projects.length === 0 ? (
            <div className="workspace-empty"><FolderKanban size={20} /><strong>아직 초기화된 프로젝트가 없습니다.</strong><span>한국특허 가출원 작업 페이지에서 첫 프로젝트를 만드세요.</span></div>
          ) : (
            <div className="workspace-project-list">{projects.slice(0, 6).map((project) => {
              const stage = workflowStages.find((item) => item.id === project.currentStage);
              return <a href={`/provisional?project=${encodeURIComponent(project.id)}`} className="workspace-project-row" key={project.id}><div><strong>{project.name}</strong><span>{project.ptCaseNumbers.join(', ') || 'PT 사건번호 없음'}</span></div><span className={project.blocked ? 'project-status blocked' : 'project-status'}>{project.blocked ? '차단' : `${project.currentStage}/13 · ${stage?.title ?? '진행 중'}`}<ArrowRight size={14} /></span></a>;
            })}</div>
          )}
        </section>

        <div className="workspace-note"><Sparkles size={16} /><span>초기화는 고정된 로컬 PowerShell 스크립트만 호출하며, 경로 입력이나 기존 폴더 덮어쓰기는 허용하지 않습니다.</span></div>
      </main>
    </div>
  );
}
