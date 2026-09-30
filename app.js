/* app.js — 공동
   UI 바인딩 · 메인 루프(인스턴스마다 시뮬 한 벌) · 공개 데이터 로딩
   engine.js → advisor.js → app.js 순서로 로드된다. */
'use strict';

/* =====================================================================
 * 8. UI 바인딩
 * ===================================================================== */
const bind = (id, key, scale = 1) => {
  const el = $(id), out = $(id + 'Val');
  const apply = () => { BASE[key] = +el.value * scale; if (out) out.textContent = el.value; };
  el.addEventListener('input', apply); apply();
};
bind('threads', 'threads'); bind('conns', 'conns'); bind('qcap', 'queueCap');
bind('dbt', 'dbTimeMs'); bind('cpums', 'cpuTimeMs'); bind('to', 'timeoutMs');
bind('rps', 'rps');
// 화면에 노출하지 않는 값들 — 시나리오(장애 패턴)와 보정이 필요할 때만 바꾼다
BASE.retryProb = 0; BASE.cancelOnTimeout = false; BASE.dbScale = 1;
BASE.dbLoadAlpha = 0; BASE.dbLoadGamma = 2;
BASE.mixOn = false; BASE.mix = MODEL.mix;
BASE.cores = null;

/* ── 시나리오 (트래픽 모양) ── */
const scSel = $('scenario');
function fillScenarios() {
  scSel.innerHTML = '';
  for (const k in SCENARIOS) {
    if (k.startsWith('curve:') ) continue;
    const o = document.createElement('option'); o.value = k; o.textContent = SCENARIOS[k].name; scSel.appendChild(o);
  }
  for (const d of DATA.list.filter(d => d.kind === 'traffic')) {
    const o = document.createElement('option'); o.value = 'curve:' + d.id;
    o.textContent = `실측 곡선: ${d.name}`; scSel.appendChild(o);
  }
  scSel.value = scenarioKey;
}
// 시나리오가 직접 정하는 파라미터(재시도 확률·타임아웃·큐)를 슬라이더/BASE 에 1회 반영
const SLIDER_OF = { threads: 'threads', conns: 'conns', queueCap: 'qcap', dbTimeMs: 'dbt', timeoutMs: 'to', rps: 'rps' };
function applyScenarioParams(key) {
  const p = (SCENARIOS[key] || {}).params || {};
  for (const k in p) {
    const id = SLIDER_OF[k];
    if (id && $(id)) { $(id).value = p[k]; $(id).dispatchEvent(new Event('input')); }
    else BASE[k] = p[k];
  }
}
scSel.addEventListener('change', async () => {
  if (scSel.value.startsWith('curve:')) await useCurve(scSel.value.slice(6));
  else { scenarioKey = scSel.value; DATA.cur = null; }
  scenarioStart = CLOCK.t;
  applyScenarioParams(scenarioKey);
  // 유입 슬라이더: 수동·실측 곡선에서만 쓸 수 있다 (곡선에서는 '평균 유입' 이 된다)
  const manual = scenarioKey === 'manual' || scenarioKey.startsWith('curve:');
  $('ctlRps').classList.toggle('disabled', !manual);
  $('rpsLbl').textContent = DATA.cur ? '평균 유입' : '유입';
  showLoadInfo(); resetAll();
});
function showLoadInfo() {
  $('loadInfo').innerHTML = DATA.cur
    ? `피크/평균 <b>${DATA.cur.peakToMean}배</b> → 피크 <b>${Math.round(BASE.rps * DATA.cur.peakToMean)} rps</b> · ${DATA.cur.points.length}점 · ${DATA.cur.source || ''}`
    : '';
}
$('rps').addEventListener('input', showLoadInfo);

/* ── 재생 ── */
const PLAY = { paused: false };
const CLOCK = { t: 0 };
function resetAll() { CLOCK.t = 0; scenarioStart = 0; for (const it of INST.list) it.sim.reset(); }
$('btnPause').addEventListener('click', () => { PLAY.paused = !PLAY.paused; $('btnPause').textContent = PLAY.paused ? '재생' : '일시정지'; });
$('btnReset').addEventListener('click', resetAll);
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !/INPUT|SELECT|BUTTON/.test(e.target.tagName)) { e.preventDefault(); $('btnPause').click(); }
});

/* =====================================================================
 * 8b. 메인 루프 — 인스턴스마다 같은 트래픽을 동시에 먹인다
 *   인스턴스별로 다른 것은 두 개뿐이다: vCPU(=CPU 슬롯) 와 메모리로 정해지는 스레드 상한.
 *   나머지 설정·유입·DB 조건은 전부 같게 두어야 "인스턴스 차이"만 남는다.
 * ===================================================================== */
function syncInstModels() {
  for (const it of INST.list) {
    Object.assign(it.M, MODEL);
    it.M.cores = it.vcpu;
    it.M.threads = Math.min(BASE.threads, it.threadCap);
    it.M.label = it.type;
    it.M.baseline = it.baseline;        // 버스터블 기준선 — 흐름도 vCPU 칸에 점선으로 깔린다
  }
}
function scenarioMarks() {
  const sc = SCENARIOS[scenarioKey], out = [];
  if (!sc || !sc.period || !sc.explain) return out;
  const base = scenarioStart / 1000, tEnd = CLOCK.t / 1000;
  for (let k = 0; k < 200 && base + k * sc.period <= tEnd; k++)
    for (const st of sc.explain) { const t = base + k * sc.period + st.t; if (t <= tEnd) out.push({ t, text: st.text }); }
  return out;
}
function updateStats() {
  const it = instSel();
  const put = (id, v) => { const el = $(id); if (el) el.textContent = v; };
  $('bnWho').textContent = it ? it.type : '';
  if (!it) { $('bottleneck').dataset.level = 'ok'; $('bottleneck').querySelector('.t').textContent = '인스턴스 없음'; return; }
  const S = it.sim.S, M = it.M, h = S.history[S.history.length - 1], th = theory(M);
  if (h) { put('mThr', h.out); put('mP95', Math.round(h.p95)); put('mErr', h.rej + h.to); }
  put('tCap', th.cap.toFixed(0));
  const b = detectBottleneck(S, M), el = $('bottleneck');
  el.dataset.level = b.level;
  el.querySelector('.t').textContent = b.title;
  el.querySelector('.d').innerHTML = b.desc || '';
}
let last = performance.now(), acc = 0, lastSec = -1;
function frame(now) {
  const real = Math.min(100, now - last); last = now;
  if (!PLAY.paused) {
    applyScenario({ S: { t: CLOCK.t } });                  // BASE → MODEL, 시나리오가 덮어쓴다
    if (scenarioKey !== 'manual' && !DATA.cur) { $('rps').value = MODEL.rps; $('rpsVal').textContent = MODEL.rps; }
    syncInstModels();
    acc += real;
    while (acc >= MODEL.dt) { for (const it of INST.list) it.sim.step(MODEL.dt); CLOCK.t += MODEL.dt; acc -= MODEL.dt; }
  }
  $('simClock').textContent = (CLOCK.t / 1000).toFixed(1) + 's';
  const sel = instSel();
  if (sel) drawStage(sel.sim);
  drawCompare(INST.list.map(it => Object.assign({ sel: it === sel }, it)),
    { win: MODEL.historySec, p95: +$('sloP95').value, marks: scenarioMarks() });
  const sec = Math.floor(CLOCK.t / 1000);
  // 표는 1초에 한 번만 다시 그린다 (좌우 두 리스트 + 추천)
  if (sec !== lastSec) { lastSec = sec; updateStats(); renderAdvice(); renderInstTable(); renderCfgTable(); }
  requestAnimationFrame(frame);
}

/* =====================================================================
 * 9. 공개 데이터 — EC2 실가격 카탈로그 + 실제 트래픽 곡선
 *   validation/fetch_public.js 가 받아 정규화해 둔 data/ 를 읽는다.
 *   트래픽은 절대량이 아니라 *모양*(0~1)만 쓰고, 유입 슬라이더(평균)로 스케일한다.
 * ===================================================================== */
const DATA = { list: [], cur: null };
async function loadData() {
  try {
    DATA.list = await (await fetch('data/index.json')).json();
    const loaded = [];
    for (const meta of DATA.list.filter(d => d.kind === 'pricing' && d.tier === 'ec2')) {
      const p = await (await fetch('data/' + meta.file)).json();
      PRICE.ec2 = p.items.map(i => [i.type, i.vcpu, i.gb, i.usdHour]).sort((a, b) => a[3] - b[3]);
      loaded.push(`EC2 ${p.items.length}종`);
    }
    if (loaded.length) PRICE.src = `${loaded.join(' · ')} — ap-northeast-2 실가격 (fetch_public.js)`;
    refreshCatalog();
    fillScenarios();
  } catch (e) {
    $('loadInfo').innerHTML = `공개 데이터 없음 — <code>python -m http.server</code> 로 열면 실가격·실측 곡선을 씁니다`;
  }
}
async function useCurve(id) {
  const meta = DATA.list.find(d => d.id === id); if (!meta) return;
  const d = await (await fetch('data/' + meta.file)).json();
  DATA.cur = d;
  const span = d.points.length * 5;   // 점 하나당 5초로 압축 재생
  const key = 'curve:' + id;
  SCENARIOS[key] = {
    name: d.name, period: span, params: {},
    at: (t) => {
      const i = Math.min(d.points.length - 1, Math.floor(t / 5)), nx = Math.min(d.points.length - 1, i + 1), f = (t / 5) - i;
      const rel = d.points[i].rel * (1 - f) + d.points[nx].rel * f;
      return { rps: Math.round(rel * BASE.rps * d.peakToMean) };   // 슬라이더 = 평균 유입
    },
    explain: [{ t: Math.round(span * .4), text: '피크' }, { t: Math.round(span * .75), text: '저점' }],
  };
  scenarioKey = key;
}

/* =====================================================================
 * 10. 설정 시나리오 — 서버 설정 한 벌을 표로 저장해 두고, 돌려보기 전에 결과를 미리 본다
 *   저장하는 것: 슬라이더 값 한 벌 + 트래픽 시나리오 키. (localStorage)
 *   미리보기   : 그 설정으로 헤드리스 20초를 돌려 p95·처리량·실패율을 먼저 본다.
 *                재생 중인 화면은 건드리지 않는다 — 불러오기를 눌러야 실제로 적용된다.
 * ===================================================================== */
const CFG_KEY = 'reinforcebean.cfgs.v1';
const CFG_FIELDS = [
  { k: 'rps',       id: 'rps',     label: '유입',    unit: 'rps' },
  { k: 'threads',   id: 'threads', label: '스레드',  unit: '' },
  { k: 'conns',     id: 'conns',   label: '커넥션',  unit: '' },
  { k: 'queueCap',  id: 'qcap',    label: '큐',      unit: '' },
  { k: 'dbTimeMs',  id: 'dbt',     label: 'DB',      unit: 'ms' },
  { k: 'cpuTimeMs', id: 'cpums',   label: 'CPU',     unit: 'ms' },
  { k: 'timeoutMs', id: 'to',      label: '타임아웃', unit: 'ms' },
];
const CFG_SEED = [
  { name: '기본 — 스레드 50 · 커넥션 20', scenario: 'manual',
    cfg: { rps: 250, threads: 50, conns: 20, queueCap: 100, dbTimeMs: 30, cpuTimeMs: 8, timeoutMs: 3000, retryProb: 0 } },
  { name: '커넥션 10 — 풀이 먼저 막힌다', scenario: 'manual',
    cfg: { rps: 250, threads: 50, conns: 10, queueCap: 100, dbTimeMs: 30, cpuTimeMs: 8, timeoutMs: 3000, retryProb: 0 } },
  { name: '큐 400 · 타임아웃 10s — 에러 없이 느려진다', scenario: 'hiddenq',
    cfg: { rps: 360, threads: 50, conns: 20, queueCap: 400, dbTimeMs: 30, cpuTimeMs: 8, timeoutMs: 10000, retryProb: 0 } },
  { name: '재시도 90% · 타임아웃 1s — 폭풍 조건', scenario: 'retrystorm',
    cfg: { rps: 300, threads: 50, conns: 20, queueCap: 400, dbTimeMs: 30, cpuTimeMs: 8, timeoutMs: 1000, retryProb: 0.9 } },
];
const CFGS = { list: [], prev: new Map(), filter: 'all' };   // prev: "행id|인스턴스" → 미리보기 결과 (인스턴스가 바뀌면 다시 잰다)

function curCfg() {
  const o = {}; for (const f of CFG_FIELDS) o[f.k] = BASE[f.k];
  o.retryProb = BASE.retryProb || 0; return o;
}
function cfgStoreLoad() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(CFG_KEY)); } catch (e) { saved = null; }
  CFGS.list = Array.isArray(saved) && saved.length ? saved
    : CFG_SEED.map((s, i) => ({ id: 'seed' + i, name: s.name, scenario: s.scenario, cfg: Object.assign({}, s.cfg) }));
  cfgStoreSave();
}
function cfgStoreSave() { try { localStorage.setItem(CFG_KEY, JSON.stringify(CFGS.list)); } catch (e) {} }

// 미리보기: 저장된 유입으로 정상 부하 20초(워밍업 6초). 시나리오의 시간 변화(스파이크 등)는 빼고
// 같은 조건에서 행끼리 견주기 위한 값이다 — 인스턴스는 지금 선택한 한 대를 기준으로 한다.
function cfgPreview(row) {
  const it = instSel();
  const c = Object.assign({}, row.cfg, {
    cores: it ? it.vcpu : null,
    threads: it ? Math.min(row.cfg.threads, it.threadCap) : row.cfg.threads,
    retryProb: row.cfg.retryProb || 0, dbScale: 1, cancelOnTimeout: false, mixOn: false,
  });
  const r = runHeadless(c, 20, 6), th = theory(Object.assign({}, MODEL, c));
  return { p95: r.p95, thr: r.thr, err: r.errRate, bottle: th.bottle, cap: th.cap };
}
const cfgKeyOf = (row) => row.id + '|' + (instSel() ? instSel().type : '-');

function renderCfgTable() {
  const it = instSel(), cur = curCfg(), p95T = +$('sloP95').value, errT = +$('sloErr').value / 100;
  $('cfgBasis').textContent = it ? `기준 ${it.type} (${it.vcpu} vCPU)` : '인스턴스 없음';
  const BN = { cpu: 'vCPU', db: 'DB 커넥션', thread: '스레드/큐' };
  // 한 행이 후보 하나. 설정도 결과도 전부 인셀 차트 — 셀이 칠해진 길이가 그 값의 크기다.
  //   설정 칸 : 슬라이더 최댓값 대비 (지금 설정과 다르면 진하게)
  //   결과 칸 : 목표치 대비 (넘으면 빨갛게) + 「기준(지금 설정)」 대비 증감률
  const SHOW = CFG_FIELDS.concat([{ k: 'retryProb', label: '재시도', unit: '%', max: 1, pct: true }]);
  const slider = (f) => f.max != null ? f.max : (($(f.id) && +$(f.id).max) || 100);
  const pv0 = CFGS.prev.get('now|' + (it ? it.type : '-'));       // 기준 행의 예측 — 증감률의 분모
  const W = (frac) => `<i class="fill" style="width:${Math.round(Math.max(0, Math.min(1, frac)) * 100)}%"></i>`;
  const dlt = (v, base, lowerBetter) => {
    if (base == null || !isFinite(base) || base <= 0 || v == null) return '';
    const d = Math.round((v - base) / base * 100);
    if (Math.abs(d) < 1) return ' <em>=</em>';
    const good = lowerBetter ? d < 0 : d > 0;
    return ` <em class="${good ? 'dn' : 'up'}">${d > 0 ? '+' : ''}${d}%</em>`;
  };
  const head = '<tr><th class="l">후보 · 트래픽</th>'
    + SHOW.map(f => `<th>${f.label}</th>`).join('')
    + '<th class="sep">예상 p95</th><th>처리량</th><th>실패</th><th class="l">병목</th><th>판정</th><th></th></tr>';

  const nowRow = { id: 'now', name: '지금 설정', scenario: scenarioKey, cfg: cur };
  const shown = CFGS.list.filter(r => {
    if (CFGS.filter === 'all') return true;
    const pv = CFGS.prev.get(cfgKeyOf(r));
    if (!pv) return false;
    return (pv.p95 <= p95T && pv.err <= errT) === (CFGS.filter === 'ok');
  });
  // 인셀 차트의 눈금은 「보이는 후보들 중 최댓값」 — 후보끼리 길이로 바로 견주려면 열 안에서 정규화해야 한다
  const all = [nowRow].concat(shown);
  const colMax = {};
  for (const f of SHOW) colMax[f.k] = Math.max(1e-9, ...all.map(r => r.cfg[f.k] || 0));
  const thrMax = Math.max(1, ...all.map(r => {
    const pv = r.id === 'now' ? pv0 : CFGS.prev.get(cfgKeyOf(r)); return pv ? pv.thr : 0;
  }));

  const line = (row, isNow) => {
    const c = row.cfg, pv = isNow ? pv0 : CFGS.prev.get(cfgKeyOf(row));
    const ok = pv ? (pv.p95 <= p95T && pv.err <= errT) : null;
    // ── 설정 셀 ──
    const cells = SHOW.map(f => {
      const v = c[f.k] == null ? 0 : c[f.k], d = !isNow && v !== (cur[f.k] || 0);
      const txt = f.pct ? (v ? Math.round(v * 100) + '%' : '—') : v + (f.unit || '');
      return `<td class="cell${d ? ' d' : ''}${v ? '' : ' zero'}"`
        + ` title="${f.label} ${txt} · 후보 중 최대 ${f.pct ? Math.round(colMax[f.k] * 100) + '%' : colMax[f.k] + (f.unit || '')}`
        + ` · 슬라이더 최대 ${f.pct ? '100%' : slider(f) + (f.unit || '')}">`
        + W(v / colMax[f.k] * 0.92) + `<b>${txt}</b></td>`;
    }).join('');
    // ── 결과 셀 ──
    const pvc = pv
      ? `<td class="cell sep ${pv.p95 > p95T ? 'hot' : ''}" title="목표 ${p95T}ms">${W(pv.p95 / Math.max(1, p95T))}`
        + `<b>${Math.round(pv.p95)} ms</b>${isNow ? '' : dlt(pv.p95, pv0 && pv0.p95, true)}</td>`
        + `<td class="cell" title="이론 최대 ${pv.cap.toFixed(0)}rps">${W(pv.thr / thrMax * 0.92)}`
        + `<b>${pv.thr.toFixed(0)} rps</b>${isNow ? '' : dlt(pv.thr, pv0 && pv0.thr, false)}</td>`
        + `<td class="cell ${pv.err > errT ? 'hot' : pv.err > 0 ? 'warm' : 'zero'}" title="허용 ${(errT * 100).toFixed(1)}%">`
        + `${W(Math.min(1, pv.err) / Math.max(.001, errT))}<b>${(Math.min(1, pv.err) * 100).toFixed(1)} %</b></td>`
        + `<td class="l">${BN[pv.bottle]}</td>`
        + `<td><span class="pill ${ok ? 'ok' : 'no'}">${ok ? '만족' : '미달'}</span></td>`
      : '<td class="sep">—</td><td>—</td><td>—</td><td class="l" style="color:var(--muted)">미리보기 전</td><td>—</td>';
    const sc = SCENARIOS[row.scenario] ? SCENARIOS[row.scenario].name : (row.scenario || '수동');
    const act = isNow
      ? `<div class="act"><button data-pv="now">예측</button></div>`
      : `<div class="act"><button data-pv="${row.id}" title="이 설정으로 20초 돌려 본 예측">예측</button>`
        + `<button class="primary" data-load="${row.id}" title="슬라이더·트래픽 시나리오를 이 설정으로">적용</button>`
        + `<button data-del="${row.id}" title="삭제">✕</button></div>`;
    return `<tr class="${isNow ? 'now' : ''}" data-ok="${ok === null ? '' : ok ? 'ok' : 'no'}">`
      + `<td class="l name">${isNow ? '▸ 기준 (지금 설정)' : esc(row.name)}`
      + ` <span style="color:var(--muted);font-weight:400">${esc(sc)}</span></td>`
      + `${cells}${pvc}<td>${act}</td></tr>`;
  };

  const nCol = 1 + SHOW.length + 6;
  $('cfgTable').innerHTML = `<thead>${head}</thead><tbody>`
    + line(nowRow, true) + shown.map(r => line(r, false)).join('')
    + (shown.length ? '' : `<tr><td colspan="${nCol}" class="l" style="color:var(--muted)">`
        + (CFGS.list.length ? '이 조건에 맞는 후보가 없다 — 「전부 미리보기」로 예측을 먼저 채운다'
                            : '저장된 후보가 없다 — 왼쪽 슬라이더를 맞춘 뒤 「＋ 저장」') + '</td></tr>')
    + '</tbody>';
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function cfgSaveCurrent() {
  const c = curCfg();
  const name = ($('cfgName') && $('cfgName').value.trim())
    || `${c.rps}rps · 스레드 ${c.threads} · 커넥션 ${c.conns}`;
  CFGS.list.push({ id: 'c' + Date.now().toString(36), name, scenario: scenarioKey, cfg: c });
  cfgStoreSave();
  if ($('cfgName')) $('cfgName').value = '';
  renderCfgTable();
}
// 불러오기: 트래픽 시나리오를 먼저 바꾸고(시나리오 기본값이 슬라이더를 덮으므로) 그 위에 저장값을 얹는다
function cfgApply(row) {
  const key = SCENARIOS[row.scenario] ? row.scenario : 'manual';
  if (key !== scenarioKey || key === 'manual') { scSel.value = key; scSel.dispatchEvent(new Event('change')); }
  for (const f of CFG_FIELDS) {
    const el = $(f.id), v = row.cfg[f.k];
    if (el && v != null) { el.value = v; el.dispatchEvent(new Event('input')); }
  }
  BASE.retryProb = row.cfg.retryProb || 0;
  showLoadInfo(); resetAll(); renderCfgTable();
}

/* ── 표 안의 버튼 (미리보기 · 적용 · 삭제) ── */
$('cfgSave').addEventListener('click', cfgSaveCurrent);
$('cfgSave2').addEventListener('click', cfgSaveCurrent);
document.querySelectorAll('.fbtn').forEach(b => b.addEventListener('click', () => {
  CFGS.filter = b.dataset.filter;
  document.querySelectorAll('.fbtn').forEach(x => x.classList.toggle('on', x === b));
  renderCfgTable();
}));
$('cfgTable').addEventListener('click', (e) => {
  const btn = e.target.closest('button'); if (!btn) return;
  if (btn.dataset.del) { CFGS.list = CFGS.list.filter(r => r.id !== btn.dataset.del); cfgStoreSave(); renderCfgTable(); }
  else if (btn.dataset.load) { const r = CFGS.list.find(x => x.id === btn.dataset.load); if (r) cfgApply(r); }
  else if (btn.dataset.pv) {
    const id = btn.dataset.pv;
    const row = id === 'now' ? { id: 'now', cfg: curCfg() } : CFGS.list.find(x => x.id === id);
    if (!row) return;
    btn.textContent = '…';
    setTimeout(() => { CFGS.prev.set(cfgKeyOf(row), cfgPreview(row)); renderCfgTable(); }, 20);
  }
});
// 전부 미리보기: 한 행씩 끊어서 돈다 (재생 중인 화면이 멈춰 보이지 않게)
$('cfgPreviewAll').addEventListener('click', () => {
  const rows = [{ id: 'now', cfg: curCfg() }].concat(CFGS.list);
  let i = 0;
  const next = () => {
    if (i >= rows.length) { renderCfgTable(); return; }
    const row = rows[i++];
    CFGS.prev.set(cfgKeyOf(row), cfgPreview(row));
    renderCfgTable(); setTimeout(next, 15);
  };
  next();
});

/* ── 시작 ── */
fillScenarios();
loadData().then(() => { if (!INST.list.length) $('instPreset').click(); });
$('instPreset').click();
cfgStoreLoad();
updateStats(); showLoadInfo(); renderAdvice(); renderInstTable(); renderCfgTable();
requestAnimationFrame(frame);
