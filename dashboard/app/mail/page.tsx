'use client';

import {
  Activity,
  Archive,
  ArrowRight,
  Check,
  ChevronRight,
  CircleAlert,
  FileCode2,
  Folder,
  GitBranch,
  Inbox,
  Mail,
  Search,
  ShieldCheck,
  SlidersHorizontal,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  changeLog,
  dashboardMeta,
  executionMap,
  folderGroups,
  overseasSignals,
  roadmap,
  rules,
  runtimeObservation,
  type RuleCategory,
} from '../data';

const categories: Array<'전체' | RuleCategory> = [
  '전체',
  '고정',
  '국내',
  '해외',
  '기타',
];

const navigation = [
  { href: '#overview', label: '운영 현황', icon: Activity },
  { href: '#rules', label: '분류 규칙', icon: SlidersHorizontal },
  { href: '#folders', label: '폴더 체계', icon: Folder },
  { href: '#architecture', label: '전체 구조', icon: GitBranch },
  { href: '#history', label: '변경 이력', icon: Archive },
];

const categoryTone: Record<RuleCategory, string> = {
  고정: 'mint',
  국내: 'blue',
  해외: 'violet',
  기타: 'amber',
};

export default function Home() {
  const [category, setCategory] = useState<(typeof categories)[number]>('전체');
  const [query, setQuery] = useState('');

  const visibleRules = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase('ko-KR');

    return rules.filter((rule) => {
      const categoryMatches = category === '전체' || rule.category === category;
      const queryMatches =
        normalized.length === 0 ||
        [rule.id, rule.condition, rule.destination, rule.note, rule.category]
          .join(' ')
          .toLocaleLowerCase('ko-KR')
          .includes(normalized);

      return categoryMatches && queryMatches;
    });
  }, [category, query]);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true">
            <Mail size={19} strokeWidth={2.2} />
          </div>
          <div>
            <strong>상상특허</strong>
            <span>Operations</span>
          </div>
        </div>

        <nav aria-label="대시보드 메뉴" className="side-nav">
          <p className="nav-eyebrow">대시보드</p>
          {navigation.map(({ href, label, icon: Icon }, index) => (
            <a className={index === 0 ? 'nav-link active' : 'nav-link'} href={href} key={href}>
              <Icon size={17} />
              <span>{label}</span>
            </a>
          ))}
        </nav>

        <div className="sidebar-status">
          <div className="status-pulse" aria-hidden="true" />
          <div>
            <strong>구성 완료</strong>
            <span>Outlook (classic) 실행 시 활성</span>
          </div>
        </div>

        <div className="sidebar-meta">
          <span>대상 계정</span>
          <strong>{dashboardMeta.account}</strong>
          <span>업데이트 {dashboardMeta.lastUpdated}</span>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div>
            <p>WORKFLOW CONTROL CENTER</p>
            <h1>{dashboardMeta.subtitle}</h1>
          </div>
          <div className="topbar-state">
            <a className="workspace-return-link" href="/">업무 시작</a>
            <span className="live-dot" />
            로컬 운영판 v1.0
          </div>
        </header>

        <div className="mobile-nav" aria-label="모바일 대시보드 메뉴">
          {navigation.map(({ href, label }) => (
            <a href={href} key={href}>{label}</a>
          ))}
        </div>

        <section className="dashboard-section overview" id="overview">
          <div className="section-heading hero-heading">
            <div>
              <span className="kicker">CURRENT OPERATION</span>
              <h2>메일 분류가 어떤 기준으로 움직이는지<br />한눈에 확인합니다.</h2>
              <p>현재 적용된 Outlook 자동분류와 향후 업무 자동화 계획을 분리해 관리합니다.</p>
            </div>
            <div className="updated-chip">
              <ShieldCheck size={15} />
              실행본 반영 · 신규 메일 관찰 대기
            </div>
          </div>

          <div className="metric-grid">
            <article className="metric-card primary-metric">
              <div className="metric-icon"><Activity size={20} /></div>
              <span>Outlook (classic) 자동분류</span>
              <strong>{runtimeObservation.status}</strong>
              <p>{runtimeObservation.note}</p>
            </article>
            <article className="metric-card">
              <span>우선순위 판정</span>
              <strong>22<span>단계</span></strong>
              <p>위에서 먼저 일치한 규칙 하나만 적용</p>
            </article>
            <article className="metric-card">
              <span>분류 대상 폴더</span>
              <strong>21<span>개</span></strong>
              <p>기존 최상위 폴더만 사용</p>
            </article>
            <article className="metric-card">
              <span>실메일 분류 일치</span>
              <strong>{runtimeObservation.matchedClassified}<span>/{runtimeObservation.expectedClassified}건</span></strong>
              <p>{runtimeObservation.period} · 총 {runtimeObservation.observed}건 관찰</p>
            </article>
          </div>

          <div className="overview-grid">
            <article className="panel flow-panel">
              <div className="panel-heading">
                <div>
                  <span className="panel-label">CLASSIFICATION FLOW</span>
                  <h3>수신 메일 처리 순서</h3>
                </div>
                <span className="panel-badge">결정적 규칙</span>
              </div>
              <div className="mail-flow">
                <div className="flow-step">
                  <span className="flow-order">01</span><Mail size={18} /><span className="location-tag cloud">Hiworks 서버</span><strong>메일 수신</strong><small>원본 보관·POP3 제공</small>
                </div>
                <ArrowRight className="flow-arrow" size={18} />
                <div className="flow-step classic-step">
                  <span className="flow-order">02</span><Activity size={18} /><span className="location-tag classic">사용자 PC</span><strong>Outlook (classic)</strong><small>POP3 다운로드·NewMailEx</small>
                </div>
                <ArrowRight className="flow-arrow" size={18} />
                <div className="flow-step">
                  <span className="flow-order">03</span><FileCode2 size={18} /><span className="location-tag embedded">Outlook 내부</span><strong>VBA 분류 판단</strong><small>HiworksRulesFinal · 22단계</small>
                </div>
                <ArrowRight className="flow-arrow" size={18} />
                <div className="flow-step success-step">
                  <span className="flow-order">04</span><Folder size={18} /><span className="location-tag storage">사용자 PC</span><strong>Outlook 폴더 이동</strong><small>로컬 데이터 파일·기존 폴더</small>
                </div>
              </div>
              <div className="inbox-policy">
                <Inbox size={20} />
                <div>
                  <strong>판정이 불명확하면 받은 편지함 유지</strong>
                  <span>포괄적인 “기타” 규칙으로 억지 분류하지 않습니다.</span>
                </div>
              </div>
            </article>

            <article className="panel safeguard-panel">
              <div className="panel-heading">
                <div>
                  <span className="panel-label">SAFETY GUARDS</span>
                  <h3>충돌 방지 장치</h3>
                </div>
                <ShieldCheck size={21} />
              </div>
              <ul className="check-list">
                <li><Check size={15} /><span>Outlook 기본 규칙 <strong>0개</strong></span></li>
                <li><Check size={15} /><span><strong>PT·PI</strong>는 국내 P 사건에서 제외</span></li>
                <li><Check size={15} /><span><strong>PI + 6자리</strong>는 해외 특허가 최우선</span></li>
                <li><Check size={15} /><span><strong>P######-S#·DIV#</strong>는 국내 특허 시리즈 예외</span></li>
                <li><Check size={15} /><span><strong>EASYPAT_S OA 본문</strong>은 국내 OA 우선</span></li>
                <li><Check size={15} /><span>삭제된 동명 폴더는 검색 대상에서 제외</span></li>
                <li><Check size={15} /><span>기존 메일은 자동 이동하지 않음</span></li>
              </ul>
              <div className="scope-note">
                <CircleAlert size={16} />
                적용 범위: {dashboardMeta.scope}
              </div>
            </article>
          </div>

          <article className="panel runtime-panel">
            <div className="panel-heading">
              <div>
                <span className="panel-label">EXECUTION MAP</span>
                <h3>동작별 수행 위치</h3>
              </div>
              <span className="panel-badge">현재 구현 기준</span>
            </div>
            <div className="classic-callout">
              <strong>Outlook (classic) 전용</strong>
              <span>새 Outlook은 VBA를 실행하지 않습니다. 자동분류가 작동하려면 classic 앱이 실행 중이고 매크로가 허용되어야 합니다.</span>
            </div>
            <div className="runtime-table" role="table" aria-label="동작별 수행 위치">
              <div className="runtime-row runtime-head" role="row">
                <span role="columnheader">동작</span><span role="columnheader">수행 위치</span><span role="columnheader">처리 내용</span><span role="columnheader">실행 조건</span>
              </div>
              {executionMap.map((item) => (
                <div className="runtime-row" role="row" key={item.action}>
                  <strong role="cell">{item.action}</strong><span className="runtime-location" role="cell">{item.location}</span><span role="cell">{item.detail}</span><span role="cell">{item.condition}</span>
                </div>
              ))}
            </div>
            <div className="dashboard-boundary">
              <strong>대시보드의 역할</strong>
              <span>이 페이지는 로컬 정책 현황판입니다. 메일 다운로드·판정·이동은 모두 Outlook (classic)에서 수행됩니다.</span>
            </div>
          </article>
        </section>

        <section className="dashboard-section" id="rules">
          <div className="section-heading">
            <div>
              <span className="kicker">RULE CATALOG</span>
              <h2>최종 분류 규칙</h2>
              <p>검색하거나 업무 영역별로 필터링할 수 있습니다.</p>
            </div>
            <span className="result-count">{visibleRules.length} / {rules.length}</span>
          </div>

          <div className="rule-toolbar">
            <label className="search-box">
              <Search size={17} />
              <span className="sr-only">분류 규칙 검색</span>
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="조건, 폴더명, 사건번호 검색"
              />
            </label>
            <div className="filter-group" aria-label="규칙 영역 필터">
              {categories.map((item) => (
                <button
                  type="button"
                  key={item}
                  className={category === item ? 'filter-button selected' : 'filter-button'}
                  aria-pressed={category === item}
                  onClick={() => setCategory(item)}
                >
                  {item}
                </button>
              ))}
            </div>
          </div>

          <div className="rule-table-wrap">
            <table className="rule-table">
              <thead>
                <tr>
                  <th>순서</th>
                  <th>영역</th>
                  <th>판정 조건</th>
                  <th>이동 폴더</th>
                  <th>메모</th>
                </tr>
              </thead>
              <tbody>
                {visibleRules.map((rule) => (
                  <tr key={rule.id}>
                    <td><span className="rule-id">{rule.id}</span></td>
                    <td><span className={`category-pill ${categoryTone[rule.category]}`}>{rule.category}</span></td>
                    <td className="condition-cell">{rule.condition}</td>
                    <td><span className="folder-target"><Folder size={14} />{rule.destination}</span></td>
                    <td className="note-cell">{rule.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {visibleRules.length === 0 && (
              <div className="empty-state">
                <Search size={22} />
                <strong>일치하는 규칙이 없습니다.</strong>
                <span>다른 검색어나 영역을 선택해 주세요.</span>
              </div>
            )}
          </div>
        </section>

        <section className="dashboard-section" id="folders">
          <div className="section-heading">
            <div>
              <span className="kicker">FOLDER MAP</span>
              <h2>기존 폴더 분류 체계</h2>
              <p>상위 그룹은 화면상의 구분일 뿐 Outlook 폴더로 생성하지 않습니다.</p>
            </div>
            <span className="result-count">20 folders</span>
          </div>

          <div className="folder-grid">
            {folderGroups.map((group) => (
              <article className={`folder-card ${group.tone}`} key={group.name}>
                <div className="folder-card-heading">
                  <div className="folder-stack"><Folder size={19} /></div>
                  <div><strong>{group.name}</strong><span>{group.folders.length}개 폴더</span></div>
                </div>
                <ul>
                  {group.folders.map((folder) => (
                    <li key={folder}><ChevronRight size={14} />{folder}</li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
        </section>

        <section className="dashboard-section" id="architecture">
          <div className="section-heading">
            <div>
              <span className="kicker">SYSTEM MAP</span>
              <h2>전체 자동화 구조</h2>
              <p>진한 단계는 현재 운영 중이며, 옅은 단계는 이후 구축 범위입니다.</p>
            </div>
          </div>

          <div className="architecture-grid">
            <article className="panel roadmap-panel">
              <div className="roadmap-line" aria-hidden="true" />
              {roadmap.map((item) => (
                <div className={`roadmap-item ${item.state}`} key={item.title}>
                  <div className="roadmap-dot" />
                  <span>{item.phase}</span>
                  <div>
                    <strong>{item.title}</strong>
                    <p>{item.detail}</p>
                  </div>
                </div>
              ))}
            </article>

            <article className="panel signal-panel">
              <div className="panel-heading">
                <div>
                  <span className="panel-label">OVERSEAS SIGNALS</span>
                  <h3>해외 사건 판정 핵심</h3>
                </div>
              </div>
              <ul>
                {overseasSignals.map((signal) => (
                  <li key={signal}><span />{signal}</li>
                ))}
              </ul>
              <div className="signal-caution">
                <strong>중요</strong>
                <p>jtjang@sspat.net가 수신자라는 이유만으로 해외 사건으로 보지 않습니다.</p>
              </div>
            </article>
          </div>
        </section>

        <section className="dashboard-section" id="history">
          <div className="section-heading">
            <div>
              <span className="kicker">CHANGE LOG</span>
              <h2>작업 반영 이력</h2>
              <p>앞으로 완료되는 작업은 이 목록과 관련 운영 지표에 함께 반영합니다.</p>
            </div>
          </div>

          <div className="history-list">
            {changeLog.map((item, index) => (
              <article className="history-item" key={`${item.date}-${item.title}`}>
                <div className="history-index">{String(index + 1).padStart(2, '0')}</div>
                <time>{item.date}</time>
                <div className="history-copy"><strong>{item.title}</strong><p>{item.detail}</p></div>
                <span className={item.status === '완료' ? 'history-status done' : 'history-status working'}>{item.status}</span>
              </article>
            ))}
          </div>
        </section>

        <footer>
          <div><FileCode2 size={15} /> 정책 원본: {dashboardMeta.module}</div>
          <span>로컬 전용 · 외부 전송 없음</span>
        </footer>
      </main>
    </div>
  );
}
