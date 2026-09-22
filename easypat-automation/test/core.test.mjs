import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  assertDryRunOnly,
  buildPlan,
  classifyScreen,
  normalizeMatterNumber,
  planReadOnlyLookup,
  redactSensitiveMetadata,
  validateProtocolIntent,
} from "../src/core.mjs";

const safetyPolicy = {
  authorizedEndpoint: {
    protocol: "https:",
    hostname: "mssql2.easypnp.co.kr",
    port: "8443",
    pathname: "/servlet/Jbori",
  },
  allowedOperations: ["search-matter", "download-document"],
  mutationOperationsEnabled: false,
  arbitrarySqlEnabled: false,
  tlsVerificationRequired: true,
};

const configuredSafetyPolicy = JSON.parse(
  readFileSync(new URL("../config/safety-policy.json", import.meta.url), "utf8"),
);

const searchObservationText = readFileSync(
  new URL("../config/protocol-observations/search-matter.json", import.meta.url),
  "utf8",
);
const searchObservation = JSON.parse(searchObservationText);
const detailObservationText = readFileSync(
  new URL("../config/protocol-observations/matter-detail-entry.json", import.meta.url),
  "utf8",
);
const detailObservation = JSON.parse(detailObservationText);

test("preserves the full series suffix", () => {
  assert.equal(normalizeMatterNumber("p261830-s1"), "P261830-S1");
});

test("keeps CN and CN(PA) distinct", () => {
  assert.notEqual(normalizeMatterNumber("P123-CN"), normalizeMatterNumber("P123-CN(PA)"));
});

test("creates a read-only lookup plan", () => {
  const plan = buildPlan({ operation: "lookup", matterNumber: "P261793" });
  assert.equal(plan.mode, "dry-run");
  assert.equal(plan.operation, "lookup");
  assert.equal(plan.matterNumber, "P261793");
});

test("requires a reporter for progress additions", () => {
  assert.throws(
    () => buildPlan({ operation: "add-progress", matterNumber: "P261793" }),
    /requires a reporter/,
  );
});

test("refuses live execution", () => {
  assert.throws(() => assertDryRunOnly(true), /live execution is intentionally disabled/);
});

test("detects the authenticated main screen", () => {
  const result = classifyScreen("장진태 파트너변리사님 로그인 중 메인화면 나의업무");
  assert.equal(result.state, "authenticated-main");
  assert.equal(result.authenticated, true);
});

test("detects an authenticated matter detail screen", () => {
  const result = classifyScreen("국내출원 저장 OurRef P261940 진행사항 연차관리 공지메일");
  assert.equal(result.state, "authenticated-matter-detail");
  assert.equal(result.authenticated, true);
});

test("detects search results before the detail rule", () => {
  const result = classifyScreen("통합검색 결과 총 1건 OurRef P261793");
  assert.equal(result.state, "authenticated-search-results");
});

test("detects a login screen without accepting credentials", () => {
  const result = classifyScreen("LOGIN 아이디 비밀번호 로그인");
  assert.equal(result.state, "login-required");
  assert.equal(result.authenticated, false);
});

test("stops on an unknown screen", () => {
  const result = classifyScreen("알 수 없는 팝업");
  assert.equal(result.state, "unknown");
  assert.match(result.nextAction, /do not click/);
});

test("blocks navigation away from an open matter by default", () => {
  const plan = planReadOnlyLookup({
    screenState: "authenticated-matter-detail",
    matterNumber: "P261793",
  });
  assert.equal(plan.status, "blocked");
  assert.equal(plan.reason, "open-matter-may-have-unsaved-changes");
  assert.deepEqual(plan.steps, []);
});

test("prepares an exact read-only lookup from the main screen", () => {
  const plan = planReadOnlyLookup({
    screenState: "authenticated-main",
    matterNumber: "p261793",
  });
  assert.equal(plan.status, "ready");
  assert.equal(plan.matterNumber, "P261793");
  assert.match(plan.steps.join(" "), /exact matter number P261793/);
  assert.match(plan.steps.at(-1), /without opening a save path/);
});

test("routes a login screen to the protected automatic authentication step", () => {
  const plan = planReadOnlyLookup({
    screenState: "login-required",
    matterNumber: "P261793",
  });
  assert.equal(plan.status, "blocked");
  assert.equal(plan.reason, "automatic-authentication-required");
});

test("blocks an unknown screen", () => {
  const plan = planReadOnlyLookup({ screenState: "unknown", matterNumber: "P261793" });
  assert.equal(plan.status, "blocked");
  assert.equal(plan.reason, "screen-state-not-safe-for-navigation");
});

test("allows only a declared read-only EasyPAT protocol operation", () => {
  const result = validateProtocolIntent(safetyPolicy, {
    operation: "search-matter",
    url: "https://mssql2.easypnp.co.kr:8443/servlet/Jbori",
    mutates: false,
  });
  assert.equal(result.allowed, true);
});

test("rejects endpoints outside the authorized EasyPAT scope", () => {
  assert.throws(
    () => validateProtocolIntent(safetyPolicy, {
      operation: "search-matter",
      url: "https://example.com/servlet/Jbori",
      mutates: false,
    }),
    /outside the authorized/,
  );
});

test("rejects mutation and arbitrary SQL intents", () => {
  const base = {
    operation: "search-matter",
    url: "https://mssql2.easypnp.co.kr:8443/servlet/Jbori",
  };
  assert.throws(() => validateProtocolIntent(safetyPolicy, { ...base, mutates: true }), /mutation/);
  assert.throws(() => validateProtocolIntent(safetyPolicy, { ...base, sql: "select 1" }), /SQL/);
});

test("keeps domestic report upload outside the enabled operation set", () => {
  assert.ok(configuredSafetyPolicy.plannedOperationsNotYetEnabled.includes("upload-domestic-report"));
  assert.equal(configuredSafetyPolicy.allowedOperations.includes("upload-domestic-report"), false);
  assert.equal(configuredSafetyPolicy.mutationOperationsEnabled, false);
});

test("redacts authentication and SQL metadata recursively", () => {
  assert.deepEqual(
    redactSensitiveMetadata({
      operation: "search-matter",
      headers: { Cookie: "secret", Authorization: "token" },
      nested: [{ password: "secret", sql: "secret" }],
    }),
    {
      operation: "search-matter",
      headers: { Cookie: "[REDACTED]", Authorization: "[REDACTED]" },
      nested: [{ password: "[REDACTED]", sql: "[REDACTED]" }],
    },
  );
});

test("automatic authentication policy requires the Windows credential store and one attempt", () => {
  assert.equal(configuredSafetyPolicy.credentialStore, "windows-credential-manager");
  assert.equal(configuredSafetyPolicy.automaticAuthenticationEnabled, true);
  assert.equal(configuredSafetyPolicy.manualAuthenticationRequired, false);
  assert.equal(configuredSafetyPolicy.maxAutomaticLoginAttempts, 1);
  assert.deepEqual(configuredSafetyPolicy.authorizedAuthenticationEndpoints.map(endpoint=>endpoint.pathname),["/EASYPAT_S_SSPAT/ip.jsp","/servlet/Jbori"]);
});

test("stored protocol observation is read-only and contains no raw statement or credential values", () => {
  assert.equal(searchObservation.operation, "search-matter");
  assert.equal(searchObservation.transport.method, "POST");
  assert.equal(searchObservation.transport.status, 200);
  assert.ok(searchObservation.requestSequence.every((item) => item.rawStatementStored === false));
  assert.doesNotMatch(searchObservationText, /"sqlText"\s*:/i);
  assert.doesNotMatch(searchObservationText, /"cookieValue"\s*:/i);
  assert.doesNotMatch(searchObservationText, /"authorizationValue"\s*:/i);
});

test("blocks UI detail replay while allowing only the identity-validated direct read", () => {
  assert.equal(detailObservation.classification, "unsafe-for-read-only-navigation");
  assert.ok(detailObservation.observedCommandClasses.includes("write-update"));
  assert.equal(detailObservation.rawStatementsStored, false);
  assert.ok(configuredSafetyPolicy.allowedOperations.includes("get-matter-detail"));
  assert.equal(configuredSafetyPolicy.directReadConstraints["get-matter-detail"].uiNavigationReplayAllowed,false);
  assert.deepEqual(configuredSafetyPolicy.directReadConstraints["get-matter-detail"].enabledTemplateIds,["matter-detail.main-record.v1"]);
  assert.deepEqual(configuredSafetyPolicy.directReadConstraints["get-matter-detail"].boundMatterReferences,["P261793"]);
  assert.doesNotMatch(detailObservationText, /"sqlText"\s*:/i);
  assert.doesNotMatch(detailObservationText, /"cookieValue"\s*:/i);
});

test("quarantines the captured shared-group download until matter binding is verified",()=>{
  assert.ok(configuredSafetyPolicy.allowedOperations.includes("download-document"));
  assert.equal(configuredSafetyPolicy.documentDownloadConstraints.enabled,false);
  assert.equal(configuredSafetyPolicy.documentDownloadConstraints.matterBindingVerified,false);
  assert.equal(configuredSafetyPolicy.directReadConstraints["list-documents"].matterBindingVerified,false);
  assert.equal(configuredSafetyPolicy.documentDownloadConstraints.matterReference,"P261793");
  assert.equal(configuredSafetyPolicy.documentDownloadConstraints.sourceTemplateId,"matter-detail.documents.v1");
  assert.equal(configuredSafetyPolicy.documentDownloadConstraints.sameOriginOnly,true);
  assert.equal(configuredSafetyPolicy.documentDownloadConstraints.freshVerifiedListRequired,true);
  assert.deepEqual(configuredSafetyPolicy.documentDownloadConstraints.allowedSelections,[{position:2,expectedFileName:"P261545외_수임내역서(수정).jpg",expectedSha256:"74fe072fb2ac8e0ac0e989370a82ef7770f00eccaffa4a9df2f43cf47817c778"}]);
});
