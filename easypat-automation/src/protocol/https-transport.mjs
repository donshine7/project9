import https from "node:https";

export const EASYPAT_ENDPOINT = "https://mssql2.easypnp.co.kr:8443/servlet/Jbori";
const MAX_BYTES = 2 * 1024 * 1024;

export class EasyPatTransportError extends Error {
  constructor(code) { super(code); this.name = "EasyPatTransportError"; this.code = code; }
}

// Internal transport: no redirects, proxy, certificate override, retry, or logging.
export function createHttpsTransport({ request = https.request, timeoutMs = 15000, maxBytes = MAX_BYTES } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000 || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES) {
    throw new EasyPatTransportError("INVALID_TRANSPORT_LIMITS");
  }
  return ({ endpoint, body, cookie }) => new Promise((resolve, reject) => {
    if (endpoint !== EASYPAT_ENDPOINT || typeof body !== "string" || Buffer.byteLength(body) > MAX_BYTES ||
        typeof cookie !== "string" || !cookie.length || cookie.length > 8192 || /[^\x20-\x7e]/.test(cookie)) {
      reject(new EasyPatTransportError("INVALID_REQUEST")); return;
    }
    let req, res, timer, settled = false;
    const chunks = [];
    let size = 0;
    const fail = code => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      chunks.forEach(c => c.fill(0));
      reject(new EasyPatTransportError(code));
      res?.destroy(); req?.destroy();
    };
    timer = setTimeout(() => fail("REQUEST_TIMEOUT"), timeoutMs);
    try {
      req = request(EASYPAT_ENDPOINT, {
        method: "POST", rejectUnauthorized: true, minVersion: "TLSv1.2", agent: false,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
          "Content-Length": Buffer.byteLength(body),
          "Accept": "text/resultset", "Accept-Encoding": "identity",
          "Cookie": cookie,
        },
      }, response => {
        res = response;
        if (settled) { res.destroy(); return; }
        res.on("error", () => fail("RESPONSE_ERROR"));
        res.on("aborted", () => fail("RESPONSE_ABORTED"));
        res.on("close", () => { if (!settled) fail("RESPONSE_ABORTED"); });
        if ([401, 403].includes(res.statusCode)) { fail("SESSION_REQUIRED"); return; }
        if (res.statusCode !== 200) { fail("UNEXPECTED_HTTP_STATUS"); return; }
        const type = res.headers["content-type"] ?? "";
        if (!/^text\/resultset(?:;|$)/i.test(type)) { fail("UNEXPECTED_RESPONSE_TYPE"); return; }
        if (res.headers["content-encoding"] && res.headers["content-encoding"] !== "identity") { fail("UNSUPPORTED_RESPONSE_ENCODING"); return; }
        const length = res.headers["content-length"];
        if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > maxBytes)) { fail("RESPONSE_TOO_LARGE"); return; }
        res.on("data", chunk => {
          if (settled) return;
          const bytes = Buffer.from(chunk);
          size += bytes.length;
          if (size > maxBytes) { bytes.fill(0); fail("RESPONSE_TOO_LARGE"); return; }
          chunks.push(bytes);
        });
        res.on("end", () => {
          if (settled) return;
          if (res.complete === false) { fail("RESPONSE_ABORTED"); return; }
          if (length !== undefined && Number(length) !== size) { fail("RESPONSE_LENGTH_MISMATCH"); return; }
          let text;
          const bytes = Buffer.concat(chunks);
          try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
          catch { bytes.fill(0); fail("INVALID_RESPONSE_UTF8"); return; }
          bytes.fill(0); chunks.forEach(c => c.fill(0));
          settled = true; clearTimeout(timer);
          // Headers, Set-Cookie and raw transport errors never cross this boundary.
          resolve({ status: 200, contentType: "text/resultset", text });
        });
      });
      req.on("error", () => fail("NETWORK_OR_TLS_ERROR"));
      req.end(body);
    } catch { fail("NETWORK_OR_TLS_ERROR"); }
  });
}
