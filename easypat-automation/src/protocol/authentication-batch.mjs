import { extractCapturedEnvelope } from "./fiddler-capture.mjs";
import { inspectAuthenticationSql } from "./authentication-shape.mjs";
import { assertReadOnlyStatement } from "./read-only-guard.mjs";

// Offline metadata only; does not approve a batch for replay.
// Returns secret-bearing statements to trusted local callers; never log this result.
export function extractAuthenticationBatch(copied) {
  try {
    if (typeof copied !== "string" || copied.length > 256 * 1024) throw new Error();
    let form = copied.trim(), sourceFormat = "form-body";
    let requestCookieHeaderPresent = null;
    if (form.startsWith("Key=")) {
      // Observed Fiddler Form-Data Copy output. Reject unsupported multiline rows.
      const rows = form.split(/\r?\n/);
      if (rows.length !== 8) throw new Error();
      const fields = new URLSearchParams();
      for (const row of rows) {
        const m = /^Key=(connection|count|command|sql[0-4]); Value=(.*)$/.exec(row);
        if (!m || fields.has(m[1])) throw new Error();
        fields.append(m[1], m[2]);
      }
      form = fields.toString(); sourceFormat = "fiddler-form-data-copy";
    }
    if (form.startsWith("POST ")) {
      const split = form.indexOf("\r\n\r\n");
      if (split < 0) throw new Error();
      const headers = form.slice(0, split).split("\r\n");
      if (!/^POST (?:https:\/\/mssql2\.easypnp\.co\.kr:8443)?\/servlet\/Jbori HTTP\/1\.[01]$/.test(headers.shift())) throw new Error();
      const hosts = headers.filter(h => /^host:/i.test(h));
      if (hosts.length !== 1 || !/^host:\s*mssql2\.easypnp\.co\.kr:8443\s*$/i.test(hosts[0])) throw new Error();
      requestCookieHeaderPresent = headers.some(h => /^cookie:/i.test(h));
      form = form.slice(split + 4); sourceFormat = "http-request";
    }
    const envelope = extractCapturedEnvelope({
      method:"POST",url:"https://mssql2.easypnp.co.kr:8443/servlet/Jbori",statusCode:200,
      requestBody:{content:form,isBase64:false,mimeType:"application/x-www-form-urlencoded; charset=utf-8"},
    });
    if (envelope.command !== "OTHERS" || envelope.statements.length !== 5) throw new Error();
    envelope.statements.forEach(assertReadOnlyStatement);
    return {sourceFormat,requestCookieHeaderPresent,envelope};
  } catch { throw new Error("AUTH_BATCH_REJECTED"); }
}

export function inspectAuthenticationBatch(copied) {
  try {
    const {sourceFormat,requestCookieHeaderPresent,envelope}=extractAuthenticationBatch(copied);
    const statements = envelope.statements.map((sql,index) => {
      assertReadOnlyStatement(sql);
      return {index,...inspectAuthenticationSql(sql)};
    });
    return {status:"batch-shapes-inspected",sourceFormat,requestCookieHeaderPresent,command:"OTHERS",statementCount:5,statements,
      valuesIncluded:false,executable:false,authenticationVerified:false,
      sourceSessionIdentityVerified:false};
  } catch { throw new Error("AUTH_BATCH_REJECTED"); }
}
