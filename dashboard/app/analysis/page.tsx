"use client";
import "./review.css";

import { FormEvent, useCallback, useEffect, useState } from "react";
type AuditFeedback = { status: "resolved" | "needs_follow_up" | "dismissed"; answer: string };
type AuditFinding = {
  decisionId: string | null;
  reviewStatus: string;
  userAnswer: AuditFeedback | null;
  answeredAt: string | null;
  inheritedFeedback?: boolean;
  feedbackSourceDecisionId?: string | null;
  verifiedNotes?: { candidateId: string; summary: string; confidence: number; model: string; effort: string; verificationModels: string[]; evidence: {mailId: string; field: string; quote: string}[] }[];
};
type Candidate = {
  id: string;
  kind: string;
  entityLabel: string;
  row_version: number;
  review_status: string;
  risk_level: string;
  model: string;
  reasoning_effort: string;
  prompt_version: string;
  verifications: { value: string; rationale: string }[];
  existingPartyOptions: {
    id: string;
    partyType: "organization" | "person";
    name: string;
    businessType: "개인사업자" | "법인" | "미정" | null;
    email: string | null;
    role: string;
  }[];
  payload: {
    fields: Record<
      string,
      {
        value: unknown;
        confidence: number;
        rationale: string;
        evidence: { mailId: string; field: string; quote: string }[];
      }
    >;
  };
};
type GroupReview = {
  runId: string;
  createdAt: string;
  sourceName: string;
  findings: {
    key: string;
    category: string;
    title: string;
    organization: string;
    knownMatterRefs: string[];
    rawMatterRefs: string[];
    expectedCount: number | null;
    knownCount: number;
    questions: string[];
    reason: string;
    reviewStatus: string;
    userAnswer: { status: string; answer: string; remainingQuestions: string[] } | null;
    answeredAt: string | null;
    evidence: { sheet: string; range: string; excerpt: string }[];
  }[];
};
type State = {
  linkAudit: {
    mailCount: number;
    linkCount: number;
    createdAt: string;
    findings: ({
      mailId: string;
      subject: string;
      matterRef: string;
      kind: string;
      reason: string;
      sourceField: "subject" | "body_text";
      evidenceExcerpt: string;
    } & AuditFinding)[];
  } | null;
  relationshipAudit: {
    createdAt: string;
    confirmedRelationshipCount: number;
    findingCount: number;
    findings: ({
      matterRef: string;
      mailCount: number;
      latestMailAt: string;
      latestSubject: string;
      reason: string;
    } & AuditFinding)[];
  } | null;
  groupReview: GroupReview | null;
  mailCount: number;
  candidates: Candidate[];
  runs: {
    id: string;
    operation: string;
    model: string;
    reasoning_effort: string;
    status: string;
    started_at: string;
    error_code: string | null;
    coverage: { mailId: string; outcome: string; reason: string }[];
  }[];
};
async function request<T = Record<string, unknown>>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const data = await response.json() as { error?: string };
  if (!response.ok) throw new Error(data.error || "처리 실패");
  return data as T;
}
const labels: Record<string, string> = {
  fact: "메일 사실",
  link: "사건·관계 연결",
  partyType: "자연인·회사 구분",
  businessType: "회사 구분",
  name: "이름",
  email: "이메일",
  role: "사건과의 관계",
  action: "Action",
  risk: "고위험 검증",
  wiki: "Wiki 개정안",
  pending: "검토 대기",
  accepted: "수락",
  edited: "수정 반영",
  rejected: "반려",
  summary: "주요 내용",
  matterRef: "관리번호",
  registrationBasis: "신규 사건 등록 근거",
  required: "Action 필요",
  title: "할 일",
  assignee: "담당자",
  dueDate: "기한",
  priority: "중요도",
  verdict: "검증 결과",
  existing_link_review: "기존 연결 재검토",
  unknown_pattern: "미지원 번호 형식",
  missing_link: "연결 누락 후보",
  unregistered_ref: "미등록 번호 후보",
};

type LinkFinding = NonNullable<State["linkAudit"]>["findings"][number];
type PartyFinding = NonNullable<State["relationshipAudit"]>["findings"][number];
type GroupFinding = GroupReview["findings"][number];
type Tab = "questions" | "proposals" | "history";
type ReviewEntry = {
  id: string;
  category: string;
  title: string;
  subtitle: string;
  search: string;
  state: string;
  date: string;
  findings?: LinkFinding[];
  party?: PartyFinding;
  group?: GroupFinding;
  candidate?: Candidate;
};
const categoryLabels: Record<string, string> = {
  number: "번호 확인",
  party: "당사자 확인",
  group: "그룹 확인",
  link: "사건 연결",
  fact: "요약",
  action: "Action",
  wiki: "Wiki",
};
const stateLabels: Record<string, string> = {
  unanswered: "답변 필요",
  followup: "추가 확인 필요",
  ready: "승인 대기",
  verification: "추가 검증 필요",
  conflict: "검증 반려",
  resolved: "확인 완료",
  applied: "반영 완료",
  dismissed: "대상 아님",
  rejected: "반려",
};
const doneStates = new Set(["resolved", "applied", "dismissed", "rejected"]);
function answerState(f: AuditFinding) {
  if (f.userAnswer?.status === "resolved") return "resolved";
  if (f.userAnswer?.status === "dismissed") return "dismissed";
  return f.userAnswer ? "followup" : "unanswered";
}
function proposalState(c: Candidate) {
  if (c.review_status !== "pending") return c.review_status === "rejected" ? "rejected" : "applied";
  if (c.verifications.some((v) => v.value === "rejected")) return "conflict";
  if (
    c.kind === "wiki" ||
    c.verifications.some((v) => v.value !== "confirmed") ||
    (c.risk_level === "high" && !c.verifications.length)
  )
    return "verification";
  return "ready";
}
function reviewEntries(data: State | null): ReviewEntry[] {
  if (!data) return [];
  const entries: ReviewEntry[] = [],
    groups = new Map<string, LinkFinding[]>();
  for (const f of data.linkAudit?.findings || []) {
    const key = f.kind + ":" + f.matterRef;
    groups.set(key, [...(groups.get(key) || []), f]);
  }
  for (const [key, findings] of groups) {
    const f = findings[0],
      states = findings.map(answerState);
    const state = states.includes("unanswered")
      ? "unanswered"
      : states.includes("followup")
        ? "followup"
        : states.every((s) => s === "dismissed")
          ? "dismissed"
          : "resolved";
    entries.push({
      id: "number:" + key,
      category: "number",
      title: f.matterRef,
      subtitle: labels[f.kind],
      state,
      date: data.linkAudit!.createdAt,
      findings,
      search: findings
        .map((x) => [x.matterRef, x.subject, x.evidenceExcerpt, x.userAnswer?.answer, ...(x.verifiedNotes || []).map(n => n.summary)].join(" "))
        .join(" "),
    });
  }
  for (const f of data.relationshipAudit?.findings || [])
    entries.push({
      id: "party:" + f.matterRef,
      category: "party",
      title: f.matterRef,
      subtitle: "관련 회사·자연인과 역할을 확인해 주세요",
      state: answerState(f),
      date: f.latestMailAt,
      party: f,
      search: [f.matterRef, f.latestSubject, f.userAnswer?.answer].join(" "),
    });
  for (const f of data.groupReview?.findings || [])
    entries.push({
      id: "group:" + f.key,
      category: "group",
      title: f.title,
      subtitle: f.organization,
      state: f.reviewStatus === "accepted" ? "resolved" : f.userAnswer ? "followup" : "unanswered",
      date: f.answeredAt || data.groupReview!.createdAt,
      group: f,
      search: [
        f.title,
        f.organization,
        ...f.knownMatterRefs,
        ...f.rawMatterRefs,
        f.userAnswer?.answer,
      ].join(" "),
    });
  for (const c of data.candidates.filter((c) => c.kind !== "risk")) {
    const v = Object.fromEntries(Object.entries(c.payload.fields).map(([k, f]) => [k, f.value]));
    entries.push({
      id: "candidate:" + c.id,
      category: c.kind,
      title: String(v.matterRef || c.entityLabel),
      subtitle:
        c.kind === "link"
          ? v.partyType
            ? "사건의 회사·자연인 관계를 추가합니다"
            : "이메일과 사건을 연결합니다"
          : c.kind === "action"
            ? v.required
              ? String(v.title)
              : "Action이 필요하지 않다는 제안입니다"
            : String(v.summary || "내용을 확인해 주세요"),
      state: proposalState(c),
      date: "",
      candidate: c,
      search: [
        c.entityLabel,
        JSON.stringify(v),
        ...Object.values(c.payload.fields).map((f) => f.evidence.map((e) => e.quote).join(" ")),
      ].join(" "),
    });
  }
  return entries;
}
function Badge({ state }: { state: string }) {
  return (
    <span className={"review-badge state-" + state}>
      {doneStates.has(state) ? "✓ " : state === "conflict" ? "! " : "• "}
      {stateLabels[state] || state}
    </span>
  );
}
function dateLabel(value: string) {
  return value ? new Date(value).toLocaleDateString("ko-KR") : "";
}

export default function AnalysisPage() {
  const [data, setData] = useState<State | null>(null),
    [error, setError] = useState("");
  const [tab, setTab] = useState<Tab>("questions"),
    [category, setCategory] = useState("all"),
    [status, setStatus] = useState("all");
  const [query, setQuery] = useState(""),
    [page, setPage] = useState(1),
    [selectedId, setSelectedId] = useState<string | null>(null),
    [notice, setNotice] = useState("");
  const load = useCallback(async () => {
    const next = await request<State>("/api/analysis");
    setData(next);
    setError("");
  }, []);
  useEffect(() => {
    void load().catch((e) => setError(String(e)));
  }, [load]);
  const entries = reviewEntries(data);
  const questions = entries.filter((x) => !x.candidate && !doneStates.has(x.state)),
    proposals = entries.filter((x) => x.candidate && !doneStates.has(x.state));
  const source =
    tab === "questions"
      ? questions
      : tab === "proposals"
        ? proposals
        : entries.filter((x) => doneStates.has(x.state));
  const filtered = source.filter(
    (x) =>
      (category === "all" || x.category === category) &&
      (status === "all" || x.state === status) &&
      x.search.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );
  const pageCount = Math.max(1, Math.ceil(filtered.length / 20)),
    activePage = Math.min(page, pageCount);
  const visible = filtered.slice((activePage - 1) * 20, activePage * 20),
    selected = visible.find((x) => x.id === selectedId) || visible[0];
  function resetFilters(next: Tab) {
    setTab(next);
    setCategory("all");
    setStatus("all");
    setPage(1);
    setSelectedId(null);
    setNotice("");
  }
  async function afterSave(message: string) {
    const index = visible.findIndex((x) => x.id === selected?.id);
    await load();
    setNotice(message);
    setSelectedId(visible[index + 1]?.id || visible[index - 1]?.id || null);
  }
  const categories =
    tab === "questions"
      ? ["number", "party", "group"]
      : tab === "proposals"
        ? ["link", "fact", "action", "wiki"]
        : Object.keys(categoryLabels);
  const statuses = [...new Set(source.map((x) => x.state))];
  return (
    <div className="matter-shell review-shell">
      <header className="matter-header">
        <a href="/matters" className="provisional-brand">
          ← 사건 업무관리
        </a>
        <div className="review-header-actions">
          <a href="/wiki" className="ghost-button">
            업무 Wiki 열기 ↗
          </a>
          <button
            className="ghost-button"
            onClick={() => void load().catch((e) => setError(String(e)))}
          >
            새로고침
          </button>
        </div>
      </header>
      <main className="matter-main review-main">
        <div className="review-intro">
          <div>
            <span className="review-eyebrow">장진태 · 업무 검토</span>
            <h1>검토함</h1>
            <p>확인할 질문에 답하고, 변경 제안을 검토해 반영합니다.</p>
          </div>
          <details className="review-help">
            <summary>사용 방법</summary>
            <p>
              <b>정보 확인</b>에서 답변을 저장하고 <b>변경 제안</b>에서 DB 반영을 승인합니다. 저장한
              답변의 후속 분석과 Wiki 갱신은 이 프로젝트에 요청하세요.
            </p>
            <p>처리 이력에는 현재 조회 범위의 완료 항목과 최근 실행 기록이 표시됩니다.</p>
          </details>
        </div>
        <nav className="review-tabs" aria-label="검토함 메뉴">
          {(
            [
              ["questions", "정보 확인", questions.length],
              ["proposals", "변경 제안", proposals.length],
              ["history", "처리 이력", entries.filter((x) => doneStates.has(x.state)).length],
            ] as const
          ).map(([key, label, count]) => (
            <button
              key={key}
              aria-pressed={tab === key}
              className={"tab-" + key}
              onClick={() => resetFilters(key)}
            >
              {label}
              <span>{data ? count : "…"}</span>
            </button>
          ))}
        </nav>
        <div className={"review-purpose purpose-" + tab}>
          <strong>
            {tab === "questions"
              ? "확인할 질문에 답하기"
              : tab === "proposals"
                ? "변경 내용을 확인하고 승인하기"
                : "처리한 답변과 반영 결과 확인하기"}
          </strong>
          <span>
            {tab === "questions"
              ? "답변 저장은 검토 이력을 남깁니다. 사건 생성·연결은 후속 반영 단계에서 처리합니다."
              : tab === "proposals"
                ? "승인하면 해당 사건 연결·요약·Action이 DB에 반영됩니다."
                : "완료·반려 항목을 검색하고 기존 근거를 다시 확인할 수 있습니다."}
          </span>
        </div>
        {error && (
          <p role="alert" className="form-notice error">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="review-success">
            {notice}
          </p>
        )}
        <div className="review-toolbar">
          <div className="review-categories">
            <button
              aria-pressed={category === "all"}
              onClick={() => {
                setCategory("all");
                setPage(1);
                setSelectedId(null);
              }}
            >
              전체
            </button>
            {categories.map((key) => (
              <button
                key={key}
                aria-pressed={category === key}
                onClick={() => {
                  setCategory(key);
                  setPage(1);
                  setSelectedId(null);
                }}
              >
                {categoryLabels[key]}
              </button>
            ))}
          </div>
          <div className="review-search">
            <input
              aria-label="사건번호·회사·자연인 검색"
              placeholder="사건번호·회사·자연인 검색"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(1);
                setSelectedId(null);
              }}
            />
            <select
              aria-label="검토 상태"
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setPage(1);
                setSelectedId(null);
              }}
            >
              <option value="all">모든 상태</option>
              {statuses.map((s) => (
                <option key={s} value={s}>
                  {stateLabels[s]}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className={"review-workspace" + (selectedId && selected ? " has-selection" : "")}>
          <section className="review-list-pane" aria-label="검토 항목 목록">
            <div className="review-list-heading">
              <strong>{filtered.length}개 항목</strong>
              <span>20개씩 표시</span>
            </div>
            <div className="review-list">
              {!data && !error && <p className="review-empty">검토 항목을 불러오는 중입니다.</p>}
              {data && !visible.length && (
                <p className="review-empty">조건에 맞는 항목이 없습니다.</p>
              )}
              {visible.map((x) => (
                <button
                  className="review-list-item"
                  key={x.id}
                  aria-pressed={selected?.id === x.id}
                  onClick={() => {
                    setSelectedId(x.id);
                    setNotice("");
                  }}
                >
                  <div className="review-tags">
                    <span className="review-kind">{categoryLabels[x.category] || x.category}</span>
                    <Badge state={x.state} />
                  </div>
                  <strong>{x.title}</strong>
                  <p>{x.subtitle}</p>
                  <small>
                    {x.findings
                      ? "관련 메일 " + new Set(x.findings.map((f) => f.mailId)).size + "건"
                      : x.party
                        ? "관련 메일 " + x.party.mailCount + "건"
                        : x.group
                          ? "확인된 구성원 " + x.group.knownCount + "건"
                          : "변경 제안"}
                    {x.date && " · " + dateLabel(x.date)}
                  </small>
                </button>
              ))}
            </div>
            <div className="review-pagination">
              <button
                disabled={activePage === 1}
                onClick={() => {
                  setPage(activePage - 1);
                  setSelectedId(null);
                }}
              >
                ← 이전
              </button>
              <span>
                {activePage} / {pageCount}
              </span>
              <button
                disabled={activePage === pageCount}
                onClick={() => {
                  setPage(activePage + 1);
                  setSelectedId(null);
                }}
              >
                다음 →
              </button>
            </div>
          </section>
          <section
            className={
              "review-detail-pane detail-" + (selected?.candidate ? "proposal" : "question")
            }
            aria-label="선택 항목 상세"
          >
            <button className="review-back" onClick={() => setSelectedId(null)}>
              ← 목록으로
            </button>
            {selected ? (
              <div key={selected.id}>
                <div className="review-detail-heading">
                  <div className="review-tags">
                    <span className="review-kind">{categoryLabels[selected.category]}</span>
                    <Badge state={selected.state} />
                  </div>
                  <h2>{selected.title}</h2>
                  <p>{selected.subtitle}</p>
                  <a href={"/wiki?q=" + encodeURIComponent(selected.title)}>
                    관련 업무 Wiki 찾기 ↗
                  </a>
                </div>
                {selected.findings && (
                  <NumberDetail
                    findings={selected.findings}
                    onSaved={() =>
                      afterSave("답변이 저장되었습니다. 사건 정보의 후속 반영은 별도로 진행합니다.")
                    }
                  />
                )}
                {selected.party && (
                  <>
                    <h3>확인할 질문</h3>
                    <p>
                      이 사건의 관련 대상은 회사인가요, 자연인인가요? 이름과 사건에서의 역할을
                      알려주세요.
                    </p>
                    <p>회사라면 개인사업자·법인·미정 중 구분도 함께 입력해 주세요.</p>
                    <Evidence
                      subject={selected.party.latestSubject}
                      excerpt={selected.party.reason}
                    />
                    <AuditFeedbackForm
                      finding={selected.party}
                      reload={() => afterSave("당사자 확인 답변이 저장되었습니다.")}
                    />
                  </>
                )}
                {selected.group && (
                  <GroupDetail
                    finding={selected.group}
                    runId={data!.groupReview!.runId}
                    onSaved={() => afterSave("그룹 확인 답변이 저장되었습니다.")}
                  />
                )}
                {selected.candidate && (
                  <CandidateCard
                    candidate={selected.candidate}
                    reload={() =>
                      afterSave("검토 결과를 저장했습니다. 처리 이력에서 확인할 수 있습니다.")
                    }
                  />
                )}
              </div>
            ) : (
              <div className="review-empty">
                <h2>검토할 항목을 선택하세요</h2>
                <p>목록의 항목을 선택하면 질문·변경 내용과 근거를 확인할 수 있습니다.</p>
              </div>
            )}
          </section>
        </div>
        {tab === "history" && (
          <details className="review-runs">
            <summary>분석 실행 기록 · 최근 {data?.runs.length || 0}건</summary>
            <p>
              조회한 제안은 최대 1,000건입니다. 아래 기록은 분석 실행 여부를 나타내며 DB 반영 여부는
              각 항목에서 확인합니다.
            </p>
            {data?.runs.map((r) => (
              <details key={r.id}>
                <summary>
                  {dateLabel(r.started_at)} · {r.operation} · {r.status}
                </summary>
                <p>
                  {r.model || "규칙 검사"} / {r.reasoning_effort || "—"}
                  {r.error_code && " · " + r.error_code}
                </p>
                {r.coverage.map((c) => (
                  <p key={c.mailId}>
                    {c.outcome} · {c.reason}
                  </p>
                ))}
              </details>
            ))}
          </details>
        )}
      </main>
    </div>
  );
}
function Evidence({ subject, excerpt }: { subject: string; excerpt: string }) {
  return (
    <div className="review-evidence">
      <h3>판단 근거</h3>
      <p>{subject}</p>
      <blockquote>{excerpt}</blockquote>
    </div>
  );
}
function NumberDetail({
  findings,
  onSaved,
}: {
  findings: LinkFinding[];
  onSaved: () => Promise<void>;
}) {
  const [index, setIndex] = useState(() =>
    Math.max(
      0,
      findings.findIndex((f) => !doneStates.has(answerState(f))),
    ),
  );
  const f = findings[Math.min(index, findings.length - 1)];
  return (
    <>
      <h3>확인할 질문</h3>
      <p>
        {f.kind === "unregistered_ref"
          ? "실제로 관리하는 사건번호인가요? 등록할 번호인지, 과거 표기인지 알려주세요."
          : f.kind === "unknown_pattern"
            ? "이 번호의 의미와 전체 관리번호를 알려주세요."
            : "이 이메일과 사건을 연결하는 것이 맞나요?"}
      </p>
      <label className="review-evidence-select">
        검토할 메일 근거
        <select value={index} onChange={(e) => setIndex(Number(e.target.value))}>
          {findings.map((finding, i) => (
            <option value={i} key={finding.decisionId || i}>
              {i + 1}. [{stateLabels[answerState(finding)]}] {finding.subject}
            </option>
          ))}
        </select>
      </label>
      <p className="review-muted">
        동일 번호의 근거 {findings.length}건을 모았습니다. 답변은 선택한 근거에 저장됩니다.
      </p>
      <Evidence subject={f.subject} excerpt={f.evidenceExcerpt || f.reason} />
      {!!f.verifiedNotes?.length && <section className="reference-verified-notes" aria-label="독립 검증된 번호 관련 메일 요약">
        <h4>번호 확인에 필요한 원문 요약</h4>
        <p className="review-muted">독립 검증된 메일 내용입니다. 사건 등록·연결 확정이나 사용자 답변은 아닙니다.</p>
        {f.verifiedNotes.map(note => <article key={note.candidateId}>
          <p>{note.summary}</p>
          <small>원문 검증 완료 · 신뢰도 {Math.round(note.confidence * 100)}%</small>
          <details className="review-technical"><summary>요약 근거와 검증 정보</summary>
            <p>요약: {note.model} / {note.effort} · 검증: {note.verificationModels.join(", ")}</p>
            {note.evidence.map((e, i) => <blockquote key={i}>{e.quote}</blockquote>)}
          </details>
        </article>)}
      </section>}
      <details className="review-technical">
        <summary>발견 위치와 검사 이유</summary>
        <p>
          {f.sourceField === "subject" ? "제목" : "본문"} · {f.reason}
        </p>
        <small>{f.mailId}</small>
      </details>
      <AuditFeedbackForm key={f.decisionId} finding={f} reload={onSaved} />
    </>
  );
}
function GroupDetail({
  finding: f,
  runId,
  onSaved,
}: {
  finding: GroupFinding;
  runId: string;
  onSaved: () => Promise<void>;
}) {
  const [answer, setAnswer] = useState(f.userAnswer?.answer || ""),
    [status, setStatus] = useState(f.userAnswer?.status || "partially_resolved");
  const [remaining, setRemaining] = useState(
    (f.userAnswer?.remainingQuestions || f.questions).join("\n"),
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await request("/api/analysis/group-feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          runId,
          answers: [
            {
              key: f.key,
              status,
              answer,
              remainingQuestions:
                status === "resolved"
                  ? []
                  : remaining
                      .split("\n")
                      .map((s) => s.trim())
                      .filter(Boolean),
            },
          ],
        }),
      });
      await onSaved();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <h3>확인할 질문</h3>
      <ul>
        {(f.userAnswer?.remainingQuestions.length
          ? f.userAnswer.remainingQuestions
          : f.questions
        ).map((q) => (
          <li key={q}>{q}</li>
        ))}
      </ul>
      <p>{f.reason}</p>
      <h3>확인된 구성원</h3>
      <p>{f.knownMatterRefs.join(", ") || "아직 없음"}</p>
      {f.rawMatterRefs.length > 0 && <p>원문 표기: {f.rawMatterRefs.join(", ")}</p>}
      <details className="review-technical">
        <summary>Excel 근거 {f.evidence.length}건</summary>
        {f.evidence.map((e) => (
          <blockquote key={e.sheet + e.range}>
            {e.excerpt}
            <small>
              {e.sheet}!{e.range}
            </small>
          </blockquote>
        ))}
      </details>
      <form className="audit-feedback-form" onSubmit={submit}>
        <h3>확인 답변</h3>
        <label>
          검토 결과
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="partially_resolved">추가 확인 필요</option>
            <option value="resolved">확인 완료</option>
          </select>
        </label>
        <label>
          답변·근거
          <textarea
            required
            value={answer}
            maxLength={4000}
            onChange={(e) => setAnswer(e.target.value)}
          />
        </label>
        {status !== "resolved" && (
          <label>
            남은 질문 · 한 줄에 하나씩
            <textarea required value={remaining} onChange={(e) => setRemaining(e.target.value)} />
          </label>
        )}
        <p className="review-muted">
          답변을 저장하면 검토 이력에 기록됩니다. 그룹 구성은 후속 반영 단계에서 변경됩니다.
        </p>
        <button className="small-save-button" disabled={busy || !answer.trim()}>
          답변 저장
        </button>
        {error && <p role="alert">{error}</p>}
      </form>
    </>
  );
}
function CandidateCard({
  candidate: c,
  reload,
}: {
  candidate: Candidate;
  reload: () => Promise<void>;
}) {
  const [edit, setEdit] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [reason, setReason] = useState("");
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const proposed = Object.fromEntries(
      Object.entries(c.payload.fields).map(([k, f]) => [k, f.value]),
    );
    if (proposed.partyType && !Object.hasOwn(proposed, "businessType"))
      proposed.businessType = proposed.partyType === "organization" ? "미정" : null;
    return proposed;
  });
  const [existingPartyId, setExistingPartyId] = useState("");
  const isRelationship = c.kind === "link" && Boolean(c.payload.fields.partyType);
  const verificationBlocked =
    c.verifications.some((v) => v.value !== "confirmed") ||
    (c.risk_level === "high" && c.verifications.length === 0);
  const verificationRejected = c.verifications.some((v) => v.value === "rejected");
  const verificationMissing = c.verifications.length === 0;
  async function review(action: string) {
    setBusy(true);
    setError("");
    try {
      await request(`/api/analysis/candidates/${c.id}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          expectedVersion: c.row_version,
          values: edit || action === "confirm_relationship" ? values : undefined,
          existingPartyId: existingPartyId || null,
          reason,
        }),
      });
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "저장 실패");
    } finally {
      setBusy(false);
    }
  }
  return (
    <article className="analysis-panel review-proposal">
      <h3>{c.review_status === "pending" ? "반영할 내용" : "검토 당시 제안 내용"}</h3>
      <p className="review-muted">
        {c.review_status === "pending"
          ? "아래 내용을 승인하면 DB에 반영합니다."
          : "처리 당시의 원 제안입니다. 이후 수정된 현재 DB 값과는 다를 수 있습니다."}
      </p>
      <details className="review-technical">
        <summary>분석 상세 · 모델과 실행 정보</summary>
        <p>
          {c.model} / {c.reasoning_effort} · {c.prompt_version}
        </p>
      </details>
      {c.verifications.map((v, i) => (
        <details className="review-technical" open={v.value !== "confirmed"} key={i}>
          <summary>
            독립 검증:{" "}
            {
              (
                {
                  confirmed: "확인됨",
                  rejected: "반려",
                  needs_review: "사용자 확인 필요",
                } as Record<string, string>
              )[v.value]
            }
          </summary>
          <p>{v.rationale}</p>
        </details>
      ))}
      {Object.entries(c.payload.fields).map(([k, f]) => (
        <div key={k} className="analysis-field">
          <div className="review-value-row">
            <strong>{labels[k] || k}</strong>
            <span aria-hidden="true">→</span>
            <p>{displayValue(k, f.value)}</p>
          </div>
          {edit && !isRelationship && k !== "required" && (
            <label>
              수정값
              <input
                className="text-input"
                aria-label={`${labels[k] || k} 수정`}
                value={String(values[k] ?? "")}
                onChange={(e) =>
                  setValues({
                    ...values,
                    [k]: k === "dueDate" && !e.target.value ? null : e.target.value,
                  })
                }
              />
            </label>
          )}
          <details>
            <summary>
              근거 · 모델 제안 신뢰도 {Math.round(f.confidence * 100)}% (정확도 보증 아님)
            </summary>
            <p>{f.rationale}</p>
            {f.evidence.map((e, i) => (
              <blockquote key={i}>
                <p>{e.quote}</p>
                <small>
                  메일 {e.mailId} · {e.field}
                </small>
              </blockquote>
            ))}
          </details>
        </div>
      ))}
      {c.review_status === "pending" && isRelationship && (
        <div className="relationship-feedback">
          <h3>사용자 확인</h3>
          <p>자연인·회사 및 회사 구분을 직접 확인하면 모델 판정과 별도 피드백으로 기록됩니다.</p>
          {c.existingPartyOptions.length > 0 && (
            <label>
              이 사건에 이미 연결된 대상 재사용
              <select
                value={existingPartyId}
                onChange={(e) => {
                  const id = e.target.value;
                  setExistingPartyId(id);
                  const selected = c.existingPartyOptions.find((option) => option.id === id);
                  if (selected)
                    setValues({
                      ...values,
                      partyType: selected.partyType,
                      businessType: selected.businessType,
                      name: selected.name,
                      email: selected.email,
                      role: selected.role,
                    });
                }}
              >
                <option value="">새 대상으로 확인</option>
                {c.existingPartyOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.partyType === "organization" ? "회사" : "자연인"} · {option.name} ·{" "}
                    {option.role}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="record-editor-grid">
            <label>
              대상 구분
              <select
                value={String(values.partyType)}
                onChange={(e) => {
                  const partyType = e.target.value;
                  setExistingPartyId("");
                  setValues({
                    ...values,
                    partyType,
                    businessType: partyType === "organization" ? "미정" : null,
                    email: partyType === "organization" ? null : "",
                  });
                }}
              >
                <option value="person">자연인</option>
                <option value="organization">회사</option>
              </select>
            </label>
            {values.partyType === "organization" && (
              <label>
                회사 구분
                <select
                  value={String(values.businessType || "미정")}
                  onChange={(e) => setValues({ ...values, businessType: e.target.value })}
                >
                  <option>개인사업자</option>
                  <option>법인</option>
                  <option>미정</option>
                </select>
              </label>
            )}
            <label>
              이름
              <input
                value={String(values.name || "")}
                onChange={(e) => {
                  setExistingPartyId("");
                  setValues({ ...values, name: e.target.value });
                }}
                required
              />
            </label>
            {values.partyType === "person" && (
              <label>
                개인 이메일
                <input
                  type="email"
                  value={String(values.email || "")}
                  onChange={(e) => setValues({ ...values, email: e.target.value.toLowerCase() })}
                  required
                />
              </label>
            )}
            <label>
              사건과의 관계
              <input
                value={String(values.role || "")}
                onChange={(e) => setValues({ ...values, role: e.target.value })}
                required
              />
            </label>
          </div>
          <label>
            확인 근거 또는 설명
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={1000}
              placeholder="예: 직접 확인한 회사이며 법인 여부는 아직 미정"
              required
            />
          </label>
          <div className="analysis-buttons">
            <button
              className="primary-button"
              disabled={busy || verificationMissing || verificationRejected || !reason.trim()}
              onClick={() => review("confirm_relationship")}
            >
              확인하고 반영
            </button>
            <button className="danger-text-button" disabled={busy} onClick={() => review("reject")}>
              반려
            </button>
          </div>
          {verificationMissing && (
            <p>독립 고위험 검증을 먼저 실행해야 사용자 확인을 반영할 수 있습니다.</p>
          )}
          {verificationRejected && (
            <p>독립 검증에서 반려된 후보는 새 근거로 다시 분석해야 합니다.</p>
          )}
        </div>
      )}
      {c.review_status === "pending" && c.payload.fields.registrationBasis && (
        <p>신규 사건 식별 후보입니다. 독립 검증 후 주 작업에서 이메일 출처를 유지하여 반영합니다. 업무 상태·기일은 변경하지 않습니다.</p>
      )}
      {c.review_status === "pending" && !isRelationship && !c.payload.fields.registrationBasis && !["risk", "wiki"].includes(c.kind) && (
        <>
          <input
            className="text-input"
            aria-label="검토 메모"
            placeholder="수정·반려 이유 (선택)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <div className="analysis-buttons">
            <button
              className="primary-button"
              disabled={busy || verificationBlocked}
              onClick={() => review(edit ? "edit" : "accept")}
            >
              {edit ? "수정 반영" : "승인하고 반영"}
            </button>
            <button className="ghost-button" disabled={busy} onClick={() => setEdit(!edit)}>
              {edit ? "수정 취소" : "수정"}
            </button>
            <button className="danger-text-button" disabled={busy} onClick={() => review("reject")}>
              반려
            </button>
          </div>
          {(c.risk_level === "high" || verificationBlocked) && (
            <p>
              독립 검증에서 확인된 후보만 반영할 수 있습니다. 고위험 내용 수정 시에는 재검증이
              필요합니다.
            </p>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="form-notice error">
          {error}
        </p>
      )}
    </article>
  );
}

function displayValue(key: string, value: unknown) {
  if (typeof value === "boolean") return value ? "필요" : "불필요";
  if (value === "organization") return "회사";
  if (value === "person") return "자연인";
  if (value === null || value === undefined)
    return key === "dueDate" ? "명시 기한 없음" : "해당 없음";
  return String(value);
}

function AuditFeedbackForm({
  finding,
  reload,
}: {
  finding: AuditFinding;
  reload: () => Promise<void>;
}) {
  const [status, setStatus] = useState<AuditFeedback["status"]>(
    finding.userAnswer?.status || "needs_follow_up",
  );
  const [answer, setAnswer] = useState(finding.userAnswer?.answer || "");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!finding.decisionId) return;
    setBusy(true);
    setError("");
    try {
      await request(`/api/analysis/decisions/${finding.decisionId}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, answer }),
      });
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "저장 실패");
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="audit-feedback-form" onSubmit={submit}>
      {finding.userAnswer && (
        <p className="form-notice">
          <b>{finding.inheritedFeedback ? "이전 감사에서 이어진 피드백" : "최근 사용자 피드백"}:</b>{" "}
          {finding.userAnswer.answer}
        </p>
      )}
      <label>
        검토 결과
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as AuditFeedback["status"])}
        >
          <option value="needs_follow_up">추가 확인 필요</option>
          <option value="resolved">확인 완료</option>
          <option value="dismissed">대상 아님</option>
        </select>
      </label>
      <label>
        답변·근거
        <textarea
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          maxLength={2000}
          required
          placeholder="번호의 의미, 올바른 사건, 연결 여부 등 확인 내용을 입력하세요."
        />
      </label>
      <p className="review-muted">
        답변 저장은 검토 이력을 남깁니다. 사건 정보는 후속 반영 단계에서 변경됩니다.
      </p>
      <button
        className="small-save-button"
        disabled={busy || !answer.trim() || !finding.decisionId}
      >
        답변 저장
      </button>
      {error && (
        <p role="alert" className="form-notice error">
          {error}
        </p>
      )}
    </form>
  );
}
