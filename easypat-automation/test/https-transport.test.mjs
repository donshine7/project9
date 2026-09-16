import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHttpsTransport, EASYPAT_ENDPOINT } from "../src/protocol/https-transport.mjs";

function mockResponse({status=200,type="text/resultset",chunks=[Buffer.from("ok")],headers={},networkError=false,hang=false}={}) {
  const calls=[];
  const request=(url,options,onResponse)=>{
    const req=new EventEmitter(); req.destroy=()=>{};
    req.end=body=>{
      calls.push({url,options,body});
      if(hang)return;
      queueMicrotask(()=>{
        if(networkError){req.emit("error",new Error("private-cookie-and-sql"));return;}
        const res=new EventEmitter();res.statusCode=status;res.headers={"content-type":type,...headers};res.complete=true;res.destroy=()=>{};
        onResponse(res);
        for(const chunk of chunks)res.emit("data",chunk);
        res.emit("end");
      });
    };
    return req;
  };
  return {request,calls};
}
const payload={endpoint:EASYPAT_ENDPOINT,body:"fixed-body",cookie:"JSESSIONID=test-only"};
test("transport pins endpoint, POST and TLS validation without exposing response cookies",async()=>{
  const mock=mockResponse({headers:{"set-cookie":"private-cookie"}});
  const result=await createHttpsTransport(mock)(payload);
  assert.deepEqual(result,{status:200,contentType:"text/resultset",text:"ok"});
  assert.equal(mock.calls[0].url,EASYPAT_ENDPOINT);
  assert.equal(mock.calls[0].options.method,"POST");
  assert.equal(mock.calls[0].options.rejectUnauthorized,true);
  assert.equal(mock.calls[0].options.agent,false);
});
test("rejects redirects and session failures without retry",async()=>{
  for(const [status,code]of [[302,"UNEXPECTED_HTTP_STATUS"],[401,"SESSION_REQUIRED"],[403,"SESSION_REQUIRED"]]){
    const mock=mockResponse({status,headers:{location:"https://other.invalid"}});
    await assert.rejects(createHttpsTransport(mock)(payload),e=>e.code===code);
    assert.equal(mock.calls.length,1);
  }
});
test("rejects unscoped endpoints and cookie header injection before network",async()=>{
  const mock=mockResponse();const transport=createHttpsTransport(mock);
  await assert.rejects(transport({...payload,endpoint:EASYPAT_ENDPOINT+"?x=1"}),/INVALID_REQUEST/);
  await assert.rejects(transport({...payload,cookie:"test\r\nX: injected"}),/INVALID_REQUEST/);
  assert.equal(mock.calls.length,0);
});
test("enforces streaming size, media type, UTF-8 and content length",async()=>{
  for(const [config,limits,code]of [
    [{chunks:[Buffer.from("123"),Buffer.from("45")]},{maxBytes:4},"RESPONSE_TOO_LARGE"],
    [{type:"text/html"},{},"UNEXPECTED_RESPONSE_TYPE"],
    [{chunks:[Buffer.from([255])]},{},"INVALID_RESPONSE_UTF8"],
    [{headers:{"content-length":"3"}},{},"RESPONSE_LENGTH_MISMATCH"],
    [{headers:{"content-encoding":"gzip"}},{},"UNSUPPORTED_RESPONSE_ENCODING"],
  ]){
    const mock=mockResponse(config);
    await assert.rejects(createHttpsTransport({...mock,...limits})(payload),e=>e.code===code);
  }
});
test("times out stalled requests and suppresses raw network exceptions",async()=>{
  await assert.rejects(createHttpsTransport({...mockResponse({hang:true}),timeoutMs:10})(payload),/REQUEST_TIMEOUT/);
  await assert.rejects(createHttpsTransport(mockResponse({networkError:true}))(payload),e=>e.code==="NETWORK_OR_TLS_ERROR"&&!String(e).includes("private-cookie"));
});
