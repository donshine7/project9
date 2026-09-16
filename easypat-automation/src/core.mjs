const MATTER_PATTERN = /^[A-Z0-9()_-]{2,64}$/;

const SENSITIVE_KEY_PATTERN = /^(authorization|cookie|set-cookie|password|session|sql)$/i;

function includesAny(text, values) {
  return values.some((value) => text.includes(value));
}

function includesAll(text, values) {
  return values.every((value) => text.includes(value));
}

export function classifyScreen(visibleText) {
  const text = String(visibleText ?? "").replace(/\s+/g, " ").trim();
  if (!text) {
    return {
      state: "unknown",
      authenticated: null,
      confidence: "low",
      evidence: [],
      nextAction: "capture a fresh EasyPAT window observation",
    };
  }

  if (includesAll(text, ["통합검색 결과", "OurRef"])) {
    return {
      state: "authenticated-search-results",
      authenticated: true,
      confidence: "high",
      evidence: ["통합검색 결과", "OurRef"],
      nextAction: "verify the exact matter number and result count",
    };
  }

  if (
    text.includes("OurRef") &&
    text.includes("저장") &&
    includesAny(text, ["진행사항", "연차관리", "공지메일", "업무관리"])
  ) {
    const evidence = ["OurRef", "저장"];
    evidence.push(
      ["진행사항", "연차관리", "공지메일", "업무관리"].find((value) => text.includes(value)),
    );
    return {
      state: "authenticated-matter-detail",
      authenticated: true,
      confidence: "high",
      evidence,
      nextAction: "preserve the open matter; do not save without a separate approved plan",
    };
  }

  if (
    text.includes("로그인 중") &&
    includesAny(text, ["MY WORK", "메인화면", "나의업무"])
  ) {
    return {
      state: "authenticated-main",
      authenticated: true,
      confidence: "high",
      evidence: ["로그인 중", "메인화면 또는 나의업무"],
      nextAction: "a read-only lookup may be prepared",
    };
  }

  const hasLoginAction = includesAny(text.toUpperCase(), ["LOGIN", "로그인"]);
  const hasIdentityInput = includesAny(text.toUpperCase(), ["아이디", "사용자", "PASSWORD", "비밀번호"]);
  const hasLogout = includesAny(text.toUpperCase(), ["LOGOUT", "로그아웃"]);
  if (hasLoginAction && hasIdentityInput && !hasLogout) {
    return {
      state: "login-required",
      authenticated: false,
      confidence: "medium",
      evidence: ["login action", "identity or password input", "no logout marker"],
      nextAction: "start one automatic authentication attempt through the protected credential provider",
    };
  }

  return {
    state: "unknown",
    authenticated: null,
    confidence: "low",
    evidence: [],
    nextAction: "stop; do not click, type, download, or save from an unknown screen",
  };
}

export function normalizeMatterNumber(value) {
  if (typeof value !== "string") {
    throw new Error("matter number must be a string");
  }

  const normalized = value.trim().toUpperCase();
  if (!MATTER_PATTERN.test(normalized)) {
    throw new Error("matter number contains unsupported characters");
  }

  return normalized;
}

export function buildPlan({ operation, matterNumber, reporter }) {
  const matter = normalizeMatterNumber(matterNumber);
  if (!new Set(["lookup", "add-progress"]).has(operation)) {
    throw new Error(`unsupported operation: ${operation}`);
  }

  if (operation === "add-progress" && !reporter?.trim()) {
    throw new Error("add-progress requires a reporter");
  }

  const steps = [
    "detect EasyPAT process",
    "detect whether the main screen or login screen is visible",
    "run at most one automatic authentication attempt when login is required",
    `open the exact matter number ${matter}`,
  ];

  if (operation === "lookup") {
    steps.push("read the result without opening a save path");
  } else {
    steps.push(`prepare one progress row with reporter ${reporter.trim()}`);
    steps.push("show a preview and require action-time confirmation");
    steps.push("save exactly once");
    steps.push("re-query and verify the new row to prevent an ambiguous retry");
  }

  return {
    mode: "dry-run",
    operation,
    matterNumber: matter,
    reporter: operation === "add-progress" ? reporter.trim() : undefined,
    steps,
    guarantees: [
      "the full matter number is preserved",
      "passwords and session cookies are not accepted or logged",
      "captured SQL and mutation requests are not replayed",
      "live execution is disabled in this prototype",
    ],
  };
}

export function planReadOnlyLookup({ screenState, matterNumber, safeToLeave = false }) {
  const matter = normalizeMatterNumber(matterNumber);

  if (screenState === "login-required") {
    return {
      status: "blocked",
      reason: "automatic-authentication-required",
      matterNumber: matter,
      steps: [],
    };
  }

  if (screenState === "authenticated-matter-detail" && !safeToLeave) {
    return {
      status: "blocked",
      reason: "open-matter-may-have-unsaved-changes",
      matterNumber: matter,
      steps: [],
    };
  }

  if (screenState === "authenticated-search-results") {
    return {
      status: "blocked",
      reason: "existing-search-results-must-be-verified-first",
      matterNumber: matter,
      steps: [],
    };
  }

  if (screenState !== "authenticated-main" && !(
    screenState === "authenticated-matter-detail" && safeToLeave
  )) {
    return {
      status: "blocked",
      reason: "screen-state-not-safe-for-navigation",
      matterNumber: matter,
      steps: [],
    };
  }

  const steps = [];
  if (screenState === "authenticated-matter-detail") {
    steps.push("return to the main screen without saving");
  }
  steps.push(
    "focus the global matter search field",
    `enter the exact matter number ${matter}`,
    "run the search once",
    "verify that the result contains the exact full matter number",
    "stop without opening a save path",
  );

  return {
    status: "ready",
    reason: null,
    matterNumber: matter,
    steps,
  };
}

export function assertDryRunOnly(execute) {
  if (execute) {
    throw new Error(
      "live execution is intentionally disabled; connect an approved UI driver after review",
    );
  }
}

export function parseTasklistCsv(line) {
  const match = line.match(/^"([^"]+)","([^"]+)","([^"]*)","([^"]*)","([^"]*)"$/);
  if (!match) return null;
  return {
    imageName: match[1],
    pid: Number(match[2]),
    sessionName: match[3],
    sessionNumber: match[4],
    memoryUsage: match[5],
  };
}

export function validateProtocolIntent(policy, intent) {
  if (!policy || !intent) throw new Error("policy and intent are required");

  const url = new URL(intent.url);
  const endpoint = policy.authorizedEndpoint;
  if (policy.tlsVerificationRequired && url.protocol !== "https:") {
    throw new Error("HTTPS with certificate verification is required");
  }
  if (
    url.username || url.password || url.search || url.hash ||
    url.protocol !== endpoint.protocol ||
    url.hostname !== endpoint.hostname ||
    url.port !== endpoint.port ||
    url.pathname !== endpoint.pathname
  ) {
    throw new Error("endpoint is outside the authorized EasyPAT scope");
  }
  if (!policy.allowedOperations.includes(intent.operation)) {
    throw new Error("operation is not allowed by the read-only policy");
  }
  if (intent.mutates === true || policy.mutationOperationsEnabled !== false) {
    throw new Error("mutation operations are disabled");
  }
  if (intent.sql != null || intent.allowArbitrarySql === true) {
    throw new Error("arbitrary SQL is prohibited");
  }

  return { allowed: true, operation: intent.operation, endpoint: url.origin + url.pathname };
}

export function redactSensitiveMetadata(value) {
  if (Array.isArray(value)) return value.map(redactSensitiveMetadata);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        SENSITIVE_KEY_PATTERN.test(key) ? "[REDACTED]" : redactSensitiveMetadata(nested),
      ]),
    );
  }
  return value;
}
