// ReinforceBean 부하기 — 여러 rps 단계로 서버를 두드리고 단계별 p50/p95/p99/실패율을 CSV로 출력 (의존성 없음)
//
// 실행:  node load.js [--url http://localhost:8080/] [--levels 50,100,150,200,250,300,330,360,400]
//                    [--duration 15] [--warmup 5] [--timeout 3000] [--out result.csv]
//
// 출력 CSV: rps,p50,p95,p99,err_rate,thr[,p95_<작업>…]   ← index.html C2/D7 에서 그대로 불러올 수 있다.
// 서버가 작업 구성(MIX)으로 떠 있으면 응답의 type 을 읽어 작업별 p95 열을 함께 남긴다.
// 도착은 포아송(지수 간격), 타임아웃은 클라이언트 측 — 시뮬레이터 모델과 같은 가정.

const fs = require('node:fs');
const http = require('node:http');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const URL_ = arg('url', 'http://localhost:8080/');
const LEVELS = arg('levels', '50,100,150,200,250,300,330,360,400').split(',').map(Number);
const DURATION = +arg('duration', 15), WARMUP = +arg('warmup', 5), TIMEOUT = +arg('timeout', 3000), OUT = arg('out', 'result.csv');

const agent = new http.Agent({ keepAlive: true, maxSockets: 4096 });
const u = new URL(URL_);
function hit(timeoutMs) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'GET', agent }, (res) => {
      let body = ''; res.setEncoding('utf8');
      res.on('data', (d) => { if (body.length < 200) body += d; });
      res.on('end', () => {
        let type = null;
        if (res.statusCode === 200) { try { type = JSON.parse(body).type; } catch { /* 본문이 JSON이 아니면 종류 미상 */ } }
        resolve({ ms: performance.now() - t0, ok: res.statusCode === 200, type });
      });
    });
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('timeout')); });
    req.on('error', () => resolve({ ms: performance.now() - t0, ok: false, type: null }));
    req.end();
  });
}
const pct = (a, p) => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function runLevel(rps) {
  const start = performance.now(), end = start + DURATION * 1000, warmEnd = start + WARMUP * 1000;
  const lat = [], byType = new Map(); let sent = 0, ok = 0, fail = 0, measured = 0;
  const inflight = new Set();
  let next = start;
  while (performance.now() < end) {
    // 포아송 도착: 지수 간격
    next += -Math.log(1 - Math.random()) * 1000 / rps;
    const wait = next - performance.now(); if (wait > 0) await sleep(wait);
    const tSend = performance.now(); sent++;
    const p = hit(TIMEOUT).then(r => {
      inflight.delete(p); if (tSend < warmEnd) return;
      measured++;
      if (r.ok) { ok++; lat.push(r.ms); if (r.type) { if (!byType.has(r.type)) byType.set(r.type, []); byType.get(r.type).push(r.ms); } }
      else fail++;
    });
    inflight.add(p);
  }
  await Promise.all([...inflight]);
  const secs = DURATION - WARMUP;
  return { rps, p50: pct(lat, .5), p95: pct(lat, .95), p99: pct(lat, .99), err: measured ? fail / measured : 0, thr: ok / secs, sent, byType };
}

(async () => {
  console.log(`[load] ${URL_}  levels=${LEVELS.join(',')}  duration=${DURATION}s (warmup ${WARMUP}s)  timeout=${TIMEOUT}ms`);
  const results = [];
  for (const rps of LEVELS) {
    process.stdout.write(`  ${String(rps).padStart(4)} rps … `);
    const r = await runLevel(rps);
    results.push(r);
    const types = [...r.byType.entries()].map(([n, a]) => `${n} p95 ${pct(a, .95).toFixed(0)}ms(${a.length})`).join('  ');
    console.log(`p50 ${r.p50.toFixed(0).padStart(5)}ms  p95 ${r.p95.toFixed(0).padStart(5)}ms  p99 ${r.p99.toFixed(0).padStart(5)}ms  실패 ${(r.err * 100).toFixed(1).padStart(5)}%  처리량 ${r.thr.toFixed(0)}rps` + (types ? `\n         └ ${types}` : ''));
    await sleep(2000);   // 단계 사이 잔여 큐 소진
  }
  // 작업 종류가 있으면 종류별 p95 열을 추가 (모든 단계에서 관측된 종류 합집합)
  const typeNames = [...new Set(results.flatMap(r => [...r.byType.keys()]))].sort();
  const head = ['rps', 'p50', 'p95', 'p99', 'err_rate', 'thr', ...typeNames.map(n => `p95_${n}`)];
  const rows = [head.join(',')];
  for (const r of results) rows.push([r.rps, r.p50.toFixed(1), r.p95.toFixed(1), r.p99.toFixed(1), r.err.toFixed(4), r.thr.toFixed(1),
    ...typeNames.map(n => (r.byType.has(n) ? pct(r.byType.get(n), .95).toFixed(1) : ''))].join(','));
  fs.writeFileSync(OUT, rows.join('\n') + '\n');
  console.log(`[load] saved → ${OUT}`);
  console.log(`[load] 다음: node compare.js ${OUT} --fit 50,100,250 --holdout 150,330,400   (또는 index.html D7 「보정 + 검증」)`);
  agent.destroy();
})();
