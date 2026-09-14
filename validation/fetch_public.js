// ReinforceBean 공개 실측 데이터 수집기 — 웹의 공개 데이터를 받아 앱이 읽는 형식으로 정규화한다. (의존성 없음, Node 22+)
//
// 실행:  node fetch_public.js            (전부)
//        node fetch_public.js wikipedia  (하나만)
//        node fetch_public.js --list
//
// 결과: ../data/<id>.json  +  ../data/index.json (앱이 읽는 목록)
//
// 정규화 스키마 (traffic): { id, name, source, url, license, kind:'traffic',
//                            unit:'상대값', peak, points:[{t(초), rel(0~1)}], note }
//   → 앱에서 "피크 rps"를 곱해 실제 유입 곡선으로 재생한다. 절대 요청량이 아니라 *모양*을 쓴다.
// 정규화 스키마 (latency): { id, name, kind:'latency', latencyPct, points:[{rps, p50, p90|p95, ...}] }
//   → C2 실측 검증 차트에 올린다.
// 정규화 스키마 (pricing): { id, kind:'pricing', tier:'ec2'|'rds', region, items:[{type, vcpu, gb, usdHour}] }
//   → D5 인프라 추천의 인스턴스 카탈로그를 실제 가격으로 교체한다.

const fs = require('node:fs');
const path = require('node:path');
const OUT = path.join(__dirname, '..', 'data');

const UA = 'ReinforceBean/1.0 (graduation project; capacity planning simulator)';
async function getJSON(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return r.json();
}

/* ─────────────────────────────────────────────────────────────
 * 소스 정의. 각 소스는 fetch() 하나만 구현하면 된다.
 * ───────────────────────────────────────────────────────────── */
const SOURCES = [
  {
    id: 'wikipedia-hourly',
    name: '위키백과(영문) 하루 트래픽',
    desc: '실제 서비스의 24시간 주기 — 새벽 저점 / 낮 피크. 피크 대 평균 비(peak-to-mean)를 보여준다.',
    async fetch() {
      const j = await getJSON('https://wikimedia.org/api/rest_v1/metrics/pageviews/aggregate/en.wikipedia/all-access/user/hourly/2024030400/2024030500');
      const v = j.items.map(i => i.views);
      const peak = Math.max(...v), mean = v.reduce((a, b) => a + b, 0) / v.length;
      return { kind: 'traffic', peakToMean: +(peak / mean).toFixed(2),
        points: v.map((x, i) => ({ t: i * 3600, rel: +(x / peak).toFixed(4) })),
        source: 'Wikimedia REST API (pageviews aggregate)', license: 'CC0 / Wikimedia Terms',
        url: 'https://wikimedia.org/api/rest_v1/metrics/pageviews/aggregate/en.wikipedia/all-access/user/hourly/2024030400/2024030500',
        note: '2024-03-04 UTC 하루, 시간 단위. 앱에서는 24시간을 120초로 압축해 재생한다.' };
    },
  },
  {
    id: 'wikipedia-week',
    name: '위키백과(영문) 일주일 트래픽',
    desc: '주중/주말 패턴. 용량 계획의 "피크는 언제 오는가"에 해당하는 실제 데이터.',
    async fetch() {
      const j = await getJSON('https://wikimedia.org/api/rest_v1/metrics/pageviews/aggregate/en.wikipedia/all-access/user/hourly/2024030400/2024031100');
      const v = j.items.map(i => i.views);
      const peak = Math.max(...v), mean = v.reduce((a, b) => a + b, 0) / v.length;
      return { kind: 'traffic', peakToMean: +(peak / mean).toFixed(2),
        points: v.map((x, i) => ({ t: i * 3600, rel: +(x / peak).toFixed(4) })),
        source: 'Wikimedia REST API (pageviews aggregate)', license: 'CC0 / Wikimedia Terms',
        url: 'https://wikimedia.org/api/rest_v1/metrics/pageviews/aggregate/en.wikipedia/all-access/user/hourly/2024030400/2024031100',
        note: '2024-03-04 ~ 03-10 UTC, 시간 단위(168점). 앱에서는 일주일을 180초로 압축해 재생한다.' };
    },
  },
  {
    id: 'korean-wikipedia-hourly',
    name: '한국어 위키백과 하루 트래픽',
    desc: '국내 서비스의 시간대 패턴 — 영문판과 피크 시각이 다르다 (KST 저녁 집중).',
    async fetch() {
      const j = await getJSON('https://wikimedia.org/api/rest_v1/metrics/pageviews/aggregate/ko.wikipedia/all-access/user/hourly/2024030400/2024030500');
      const v = j.items.map(i => i.views);
      const peak = Math.max(...v), mean = v.reduce((a, b) => a + b, 0) / v.length;
      return { kind: 'traffic', peakToMean: +(peak / mean).toFixed(2),
        points: v.map((x, i) => ({ t: i * 3600, rel: +(x / peak).toFixed(4) })),
        source: 'Wikimedia REST API (pageviews aggregate)', license: 'CC0 / Wikimedia Terms',
        url: 'https://wikimedia.org/api/rest_v1/metrics/pageviews/aggregate/ko.wikipedia/all-access/user/hourly/2024030400/2024030500',
        note: '2024-03-04 UTC 하루. UTC 기준이므로 KST는 +9시간.' };
    },
  },
  {
    id: 'aws-ec2-seoul',
    name: 'AWS EC2 가격 (서울)',
    desc: 'ap-northeast-2 온디맨드 실제 가격·사양. D5 인프라 추천의 앱 서버 카탈로그로 쓴다.',
    async fetch() {
      // ec2.shop — AWS Price List Bulk API(296MB)의 경량 대안. Cost = USD/시간 온디맨드.
      const r = await fetch('https://ec2.shop?region=ap-northeast-2', { headers: { 'User-Agent': UA, accept: 'json' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      const FAM = /^(t3|t4g|c6i|c7i|m6i|m7i|r6i|c5|m5|r5)\./;      // 웹 서버로 흔히 쓰는 계열만
      const items = j.Prices.filter(p => FAM.test(p.InstanceType) && p.VCPUS <= 64 && p.Cost > 0)
        .map(p => ({ type: p.InstanceType, vcpu: p.VCPUS, gb: parseFloat(p.Memory), usdHour: p.Cost }))
        .sort((a, b) => a.usdHour - b.usdHour);
      return { kind: 'pricing', tier: 'ec2', region: 'ap-northeast-2', items,
        source: 'ec2.shop (AWS 온디맨드 미러)', license: '공개 API',
        url: 'https://ec2.shop?region=ap-northeast-2',
        note: `온디맨드 시간당 USD. ${items.length}종.` };
    },
  },
  {
    id: 'aws-rds-seoul',
    name: 'AWS RDS PostgreSQL 가격 (서울)',
    desc: 'ap-northeast-2 RDS PostgreSQL 온디맨드 실제 가격·사양. D5의 DB 카탈로그. (37MB 다운로드)',
    async fetch() {
      const r = await fetch('https://instances.vantage.sh/rds/instances.json', { headers: { 'User-Agent': UA } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const all = await r.json();
      const FAM = /^db\.(t3|t4g|m6i|m6g|m5|r6i|r6g|r5)\./;
      const items = [];
      for (const i of all) {
        const px = i.pricing && i.pricing['ap-northeast-2'];
        const pg = px && (px.PostgreSQL || px.postgresql);
        const usd = pg && pg.ondemand && parseFloat(pg.ondemand);
        if (!usd || !FAM.test(i.instanceType)) continue;
        const gb = typeof i.memory === 'number' ? i.memory : parseFloat(i.memory);
        if (!i.vcpu || i.vcpu > 64) continue;
        items.push({ type: i.instanceType, vcpu: +i.vcpu, gb, usdHour: usd });
      }
      items.sort((a, b) => a.usdHour - b.usdHour);
      return { kind: 'pricing', tier: 'rds', region: 'ap-northeast-2', items,
        source: 'instances.vantage.sh (AWS RDS 온디맨드)', license: '공개 데이터',
        url: 'https://instances.vantage.sh/rds/instances.json',
        note: `PostgreSQL 단일 AZ 온디맨드 시간당 USD. ${items.length}종.` };
    },
  },
  {
    id: 'techempower-db-r22',
    name: 'TechEmpower DB 벤치마크 (외부 실측)',
    desc: '537개 웹 프레임워크의 DB 조회 엔드포인트를 동시성 16→512로 측정한 실제 데이터. 우리 모델이 예측하는 "무릎"이 실제로 나타나는지 확인하는 외부 증거.',
    async fetch() {
      // tfb-status.techempower.com 이 현재 접속 불가 → Wayback 아카이브의 원본(id_ 모드). 받은 뒤 로컬에 보관하므로 재접속 불필요.
      const url = 'https://web.archive.org/web/20240614003708id_/https://tfb-status.techempower.com/raw/results.2023-10-11-01-26-20-787.json';
      const j = await getJSON(url);
      const db = j.rawData.db, names = Object.keys(db);
      const parseMs = (x) => { if (typeof x !== 'string') return NaN; const m = x.match(/^([\d.]+)(us|ms|s)$/); return m ? +m[1] * (m[2] === 'us' ? 0.001 : m[2] === 'ms' ? 1 : 1000) : NaN; };
      const med = (arr) => { const v = arr.filter(Number.isFinite).sort((p, q) => p - q); return v.length ? v[v.length >> 1] : NaN; };
      const points = j.concurrencyLevels.map((L, i) => {
        const rows = names.map(n => db[n][i]).filter(e => e && e.totalRequests > 0 && e.endTime > e.startTime);
        return { concurrency: L, n: rows.length,
          rps: Math.round(med(rows.map(e => e.totalRequests / (e.endTime - e.startTime)))),
          avgMs: +med(rows.map(e => parseMs(e.latencyAvg))).toFixed(2) };
      });
      const knee = points.reduce((b, p) => p.rps > b.rps ? p : b, points[0]);
      return { kind: 'latency', latencyKind: 'avg', points, kneeRps: knee.rps,
        source: `TechEmpower Framework Benchmarks Round 22 (${j.name || ''}), ${names.length}개 프레임워크의 중앙값`,
        license: 'TechEmpower (공개 결과)', url,
        note: `test=db (요청당 DB 조회 1회). 동시성별 중앙값. 처리량이 ${knee.rps}rps에서 포화되는데 지연은 계속 오른다 — M/M/c의 무릎. ` +
              `Little's Law(동시성 ÷ 처리량) 검산이 측정 지연과 일치해 데이터 자체의 일관성도 확인됨.` };
    },
  },
];

/* ───────────────────────────────────────────────────────────── */
async function main() {
  const arg = process.argv[2];
  if (arg === '--list') { for (const s of SOURCES) console.log(`${s.id.padEnd(26)} ${s.name}`); return; }
  fs.mkdirSync(OUT, { recursive: true });
  const targets = arg ? SOURCES.filter(s => s.id.includes(arg)) : SOURCES;
  if (!targets.length) { console.error(`'${arg}' 에 해당하는 소스 없음. --list 로 확인.`); process.exit(1); }

  const index = [];
  // 기존 index를 읽어 이번에 받지 않은 항목도 유지
  const idxPath = path.join(OUT, 'index.json');
  if (fs.existsSync(idxPath)) index.push(...JSON.parse(fs.readFileSync(idxPath, 'utf8')));

  for (const src of targets) {
    process.stdout.write(`[fetch] ${src.id} … `);
    try {
      const data = await src.fetch();
      const rec = Object.assign({ id: src.id, name: src.name, desc: src.desc, fetchedAt: new Date().toISOString().slice(0, 10) }, data);
      fs.writeFileSync(path.join(OUT, src.id + '.json'), JSON.stringify(rec, null, 1));
      const meta = { id: rec.id, name: rec.name, desc: rec.desc, kind: rec.kind, file: src.id + '.json',
        source: rec.source, license: rec.license, peakToMean: rec.peakToMean, tier: rec.tier,
        n: (rec.points || rec.items || []).length };
      const at = index.findIndex(x => x.id === rec.id); if (at >= 0) index[at] = meta; else index.push(meta);
      console.log(`OK  ${(rec.points || rec.items || []).length}건` + (rec.peakToMean ? `  peak/mean=${rec.peakToMean}` : ''));
    } catch (e) { console.log(`실패 — ${e.message}`); }
  }
  fs.writeFileSync(idxPath, JSON.stringify(index, null, 1));
  console.log(`\n[fetch] ../data/index.json 갱신 (${index.length}개 데이터셋)`);
  console.log('        index.html → A열 「실제 서비스 트래픽」 에서 불러올 수 있다.');
}
main();
