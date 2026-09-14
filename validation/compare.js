// 실측 CSV(load.js 출력)와 시뮬레이터(index.html의 엔진)를 비교 — 터미널용. UI의 D7 「보정 + 검증」과 같은 계산.
//
// 실행:
//   node compare.js result.csv                                   # 현재 파라미터로 전 구간 비교
//   node compare.js result.csv --fit 50,100,250 --holdout 150,330,400
//        → 보정용 rps 로만 DB 시간 배율 · 감속률 α · 시작점 γ 를 맞춘 뒤,
//          보정에 쓰지 않은 rps 에서 보정 전/후 예측 오차를 비교한다. (이게 예측력의 증거다)
//
// 옵션: --threads 50 --conns 10 --db 30 --queue 100 --timeout 3000 --cpu 0
//       --mix "상품조회:0.9:20,복잡검색:0.1:150"     ← 서버를 MIX로 띄웠다면 같은 값을 넣을 것
//
// 모델:  dbTime_eff = dbTime × dbScale × (1 + α × (사용 중 커넥션 / 커넥션 수)^γ)
//   α — 커넥션이 꽉 찼을 때의 감속률. server.js 가 시작할 때 직접 측정해 출력한다 (--alpha 로 고정 권장).
//   γ — 언제부터 느려지기 시작하는가. 클수록 "평소엔 멀쩡하다 갑자기". 부하 곡선에서만 알 수 있다.
//
// 주의: 맞출 파라미터가 3개이므로 보정 구간에 서로 다른 3개 "구간"이 필요하다 —
//       한산(기본 시간) · 무릎 직전(γ) · 포화(α·용량). 무릎 직전 점이 빠지면 γ가 제멋대로 잡힌다.
//       예)  --fit <최저>,<실패 직전>,<최고>  --holdout <나머지 전부>

const fs = require('node:fs'), path = require('node:path');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const num = (k, d) => +arg(k, d);
const list = (k, d) => String(arg(k, d) || '').split(/[,\s]+/).map(Number).filter(v => isFinite(v) && v > 0);
const csv = process.argv[2] || 'result.csv';

function parseMix(s) {
  if (!s) return null;
  const out = [];
  for (const p of String(s).split(',')) { const [name, share, ms] = p.split(':'); if (name && isFinite(+share) && isFinite(+ms)) out.push({ id: name, name, share: +share, dbTimeMs: +ms, cpuTimeMs: 0 }); }
  if (!out.length) return null;
  const tot = out.reduce((a, b) => a + b.share, 0); out.forEach(m => { m.share /= tot; });
  return out;
}
const MIX = parseMix(arg('mix', ''));
const cfg = { threads: num('threads', 50), conns: num('conns', 10), dbTimeMs: num('db', 30), queueCap: num('queue', 100),
  timeoutMs: num('timeout', 3000), cpuTimeMs: num('cpu', 0), retryProb: 0, mixOn: !!MIX, mix: MIX || undefined, dbScale: 1,
  dbLoadAlpha: num('alpha', 0), dbLoadGamma: num('gamma', 2) };
const FIX_ALPHA = process.argv.indexOf('--alpha') > 0;   // --alpha 를 줬으면 서버 실측값으로 고정하고 γ만 맞춘다

// index.html에서 엔진 구획(1~4)만 추출해 로드 (렌더링/DOM 이전까지)
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const src = html.match(/<script>([\s\S]*)<\/script>/)[1];
const engine = src.split(/\/\* =+\r?\n \* 5\./)[0];
const E = new Function(engine + '\nreturn { runHeadless, theory, effTimes };')();

// CSV: 헤더 이름으로 열을 찾는다 (작업별 p95_* 열이 붙어도 안전)
const lines = fs.readFileSync(csv, 'utf8').trim().split(/\r?\n/).filter(l => l && !l.startsWith('#'));
const head = lines[0].toLowerCase().split(',').map(s => s.trim());
const col = (k) => head.indexOf(k);
const rows = lines.slice(1).map(l => { const c = l.split(','); return {
  rps: +c[col('rps')], p50: +c[col('p50')] || 0, p95: +c[col('p95')],
  p99: col('p99') >= 0 ? +c[col('p99')] || 0 : 0, err: col('err_rate') >= 0 ? +c[col('err_rate')] || 0 : 0 };
}).filter(r => isFinite(r.rps) && isFinite(r.p95) && r.p95 > 0);

const rel = (a, b) => Math.abs(a - b) / Math.max(1, b);
const run = (rps, scale, alpha, gamma, dur = 15, warm = 5) => E.runHeadless(Object.assign({}, cfg, { rps, dbScale: scale, dbLoadAlpha: alpha, dbLoadGamma: gamma }), dur, warm);
const GAMMAS = [1, 2, 4, 6, 8, 12, 16, 24];
// 목적함수: p95 상대오차 + 실패율 절대오차 (p95만 쓰면 "느리지만 성공"과 "빠르지만 실패"를 구분 못한다)
function score(pts, scale, alpha, gamma, dur, warm, rep) {
  let e = 0;
  for (const p of pts) for (let k = 0; k < rep; k++) { const r = run(p.rps, scale, alpha, gamma, dur, warm); e += (rel(r.p95, p.p95) + 2 * Math.abs(r.errRate - p.err)) / rep; }
  return e / Math.max(1, pts.length);
}
const seq = (a, b, s) => { const o = []; for (let v = a; v <= b + 1e-9; v += s) o.push(+v.toFixed(3)); return o; };
function fit(pts) {
  const alphas = FIX_ALPHA ? [cfg.dbLoadAlpha] : [0, 0.15, 0.3, 0.45, 0.6, 0.8];
  let best = null;
  for (const s of seq(0.7, 1.6, 0.15)) for (const a of alphas) for (const g of (FIX_ALPHA ? GAMMAS : [1, 4, 8, 16]))
    { const e = score(pts, s, a, g, 12, 3, 2); if (!best || e < best.err) best = { scale: s, alpha: a, gamma: g, err: e }; }
  const gi = Math.max(0, GAMMAS.indexOf(best.gamma)), fineG = GAMMAS.slice(Math.max(0, gi - 1), gi + 2);
  const fineA = FIX_ALPHA ? [cfg.dbLoadAlpha] : seq(Math.max(0, best.alpha - 0.15), best.alpha + 0.15, 0.075);
  const all = []; let b2 = null;
  for (const s of seq(Math.max(0.4, best.scale - 0.1), best.scale + 0.1, 0.05)) for (const a of fineA) for (const g of fineG)
    { const e = score(pts, s, a, g, 15, 4, 3); all.push({ scale: s, alpha: a, gamma: g, err: e }); if (!b2 || e < b2.err) b2 = { scale: s, alpha: a, gamma: g, err: e }; }
  const tied = all.filter(x => x.err <= b2.err * 1.3 + 0.03);
  return Object.assign(b2, { aLo: Math.min(...tied.map(x => x.alpha)), aHi: Math.max(...tied.map(x => x.alpha)),
                             gLo: Math.min(...tied.map(x => x.gamma)), gHi: Math.max(...tied.map(x => x.gamma)) });
}

const eff = E.effTimes(cfg);
console.log(`시뮬 설정: threads=${cfg.threads} conns=${cfg.conns} queue=${cfg.queueCap} timeout=${cfg.timeoutMs}ms cpu=${cfg.cpuTimeMs}ms`);
console.log(`작업 구성: ${MIX ? MIX.map(m => `${m.name} ${Math.round(m.share * 100)}%/${m.dbTimeMs}ms`).join('  ') : `단일 ${cfg.dbTimeMs}ms`}  → 실효 DB ${eff.db.toFixed(1)}ms`);

const fitL = list('fit', ''), hodL = list('holdout', '');
if (!fitL.length) {
  // 보정 없이 현재 파라미터로 전 구간 비교 (기존 동작)
  console.log('\n rps | 실측 p95 | 시뮬 p95 | 실측 실패 | 시뮬 실패');
  let se = 0, n = 0;
  for (const r of rows) {
    const s = run(r.rps, 1, cfg.dbLoadAlpha, cfg.dbLoadGamma);
    console.log(String(r.rps).padStart(4), '|', r.p95.toFixed(0).padStart(7), '|', s.p95.toFixed(0).padStart(7), '|', ((r.err * 100).toFixed(1) + '%').padStart(8), '|', ((s.errRate * 100).toFixed(1) + '%').padStart(8));
    se += rel(s.p95, r.p95); n++;
  }
  console.log(`p95 평균 상대오차: ${(se / n * 100).toFixed(0)}%`);
  console.log(`\n힌트: --fit 50,100,250 --holdout 150,330,400 을 주면 자동 보정 + 예측 검증까지 한다.`);
  process.exit(0);
}

// ── 보정 + holdout 검증 ──
const near = (L) => L.map(v => rows.reduce((b, d) => Math.abs(d.rps - v) < Math.abs(b.rps - v) ? d : b, rows[0])).filter((d, i, a) => a.indexOf(d) === i);
const fitP = near(fitL), hodP = near(hodL).filter(d => !fitP.includes(d));
if (!fitP.length) { console.error('보정에 쓸 rps 가 CSV에 없다.'); process.exit(1); }

const fitRho = Math.max(...fitP.map(p => { const t = E.theory(Object.assign({}, cfg, { rps: p.rps })); return Math.max(t.rhoT, t.rhoD); }));
console.log(`\n[보정] 사용 rps: ${fitP.map(p => p.rps).join(', ')}  (이 구간 최대 이용률 ρ ≈ ${fitRho.toFixed(2)})`);
const f = fit(fitP);
console.log(`[보정] 한산할 때 DB ${eff.db.toFixed(0)}ms → ${(eff.db * f.scale).toFixed(0)}ms (배율 ${f.scale.toFixed(2)})`);
console.log(`[보정] 감속률 α = ${f.alpha.toFixed(2)}${FIX_ALPHA ? ' (서버 실측값 고정)' : `  (구분 안 되는 범위 ${f.aLo.toFixed(2)}~${f.aHi.toFixed(2)})`}   시작점 γ = ${f.gamma}${f.gLo !== f.gHi ? ` (범위 ${f.gLo}~${f.gHi})` : ''}   맞춤 오차 ${(f.err * 100).toFixed(0)}%`);
const occ = (u) => `${Math.round(u * 100)}%→${(eff.db * f.scale * (1 + f.alpha * Math.pow(u, f.gamma))).toFixed(0)}ms`;
console.log(`[보정] ⇒ 커넥션 점유율별 쿼리 시간:  ${occ(0.25)}  ${occ(0.5)}  ${occ(0.8)}  ${occ(1)}`);
if (fitRho < 0.75)
  console.log(`[경고] 보정 구간 최대 ρ ≈ ${fitRho.toFixed(2)}로 한산하다 — α·γ가 이 데이터로 결정되지 않는다. 실패가 나기 시작하는 rps를 보정에 넣을 것.`);
if (!FIX_ALPHA && f.aHi - f.aLo > 0.3)
  console.log(`[경고] α ${f.aLo.toFixed(2)}~${f.aHi.toFixed(2)}가 구분되지 않는다 — server.js 가 출력한 값을 --alpha 로 고정하는 편이 정확하다.`);

if (!hodP.length) { console.log('\n[검증] holdout 이 비어 있다 — 보정에 쓰지 않은 rps 를 --holdout 으로 지정해야 예측력을 증명할 수 있다.'); process.exit(0); }
console.log(`\n[검증] 보정에 쓰지 않은 rps: ${hodP.map(p => p.rps).join(', ')}`);
console.log(' rps | 실측 p95 | 보정 전 |  오차 | 보정 후 |  오차');
let eb = 0, ea = 0;
for (const p of hodP) {
  const b = run(p.rps, 1, 0, 1), a = run(p.rps, f.scale, f.alpha, f.gamma);
  eb += rel(b.p95, p.p95); ea += rel(a.p95, p.p95);
  console.log(String(p.rps).padStart(4), '|', p.p95.toFixed(0).padStart(7), '|', b.p95.toFixed(0).padStart(6), '|',
    ((rel(b.p95, p.p95) * 100).toFixed(0) + '%').padStart(5), '|', a.p95.toFixed(0).padStart(6), '|', ((rel(a.p95, p.p95) * 100).toFixed(0) + '%').padStart(5));
}
eb /= hodP.length; ea /= hodP.length;
console.log(`\nholdout 평균 상대오차: ${(eb * 100).toFixed(0)}%  →  ${(ea * 100).toFixed(0)}%   ${ea < eb ? '보정에 쓰지 않은 구간에서도 예측이 좋아졌다' : '보정 후가 더 나쁘다 — 보정 구간이 좁거나 모델에 없는 요인이 섞였다'}`);
console.log(`\nindex.html 에 적용: DB 평균 처리시간 ${(eff.db * f.scale).toFixed(0)}ms · 고급의 α ${f.alpha.toFixed(2)} · γ ${f.gamma}`);
