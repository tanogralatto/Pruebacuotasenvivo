'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const V = require('../validacion-v2.js');
const T = require('../modelo-poisson.js');

const fx = (st, ht, ft) => ({ fixture: { status: { short: st } }, score: { halftime: ht || {}, fulltime: ft || {} } });

test('liquidación: usa el HT de la API y nunca inventa uno', () => {
  assert.deepEqual(V.settleFromFixture(fx('FT', { home: 1, away: 0 }, { home: 2, away: 1 })), { status: 'settled', y: 1, ht: [1, 0], source: 'api' });
  assert.equal(V.settleFromFixture(fx('FT', { home: 0, away: 0 }, { home: 3, away: 1 })).y, 0);
  // Sin HT pero final 0-0: el HT 0-0 se deduce y queda marcado como inferido.
  const inferred = V.settleFromFixture(fx('FT', { home: null, away: null }, { home: 0, away: 0 }));
  assert.equal(inferred.status, 'settled'); assert.equal(inferred.source, 'inferred_ft_0_0'); assert.equal(inferred.y, 0);
  // Sin HT y final con goles: no se puede saber -> no se liquida.
  assert.equal(V.settleFromFixture(fx('FT', {}, { home: 2, away: 1 })).status, 'unverified');
  assert.equal(V.settleFromFixture(fx('PST')).status, 'void');
  assert.equal(V.settleFromFixture(fx('1H')).status, 'pending');
  assert.equal(V.settleFromFixture(null).status, 'pending');
});

test('chunk divide en grupos de 20 como máximo', () => {
  const parts = V.chunk(Array.from({ length: 45 }, (_, i) => i), 20);
  assert.deepEqual(parts.map(p => p.length), [20, 20, 5]);
});

test('resumen del registro: Brier, ROI plano y señales EV+', () => {
  const entries = [
    { ts: 1, p: 0.8, y: 1, odds: 1.5, signal: 'ev_solido' },
    { ts: 2, p: 0.6, y: 0, odds: 1.8, signal: 'ev_posible' },
    { ts: 3, p: 0.7, y: 1, odds: null, signal: 'sin_ev' },
    { ts: 4, p: 0.7, y: null }, // pendiente
    { ts: 5, p: 0.7, y: null, void: true } // anulado: no cuenta como pendiente
  ];
  const s = V.summarizeLog(entries, T);
  assert.equal(s.settled, 3);
  assert.equal(s.pending, 1);
  assert.equal(s.all.n, 2);
  assert.ok(Math.abs(s.all.profit - (0.5 - 1)) < 1e-12);
  assert.equal(s.evPlus.n, 2);
  assert.equal(s.evSolid.n, 1);
  assert.ok(Math.abs(s.evSolid.roi - 0.5) < 1e-12);
  assert.ok(Math.abs(s.promisedEv - ((0.8 * 1.5 - 1 + 0.6 * 1.8 - 1) / 2)) < 1e-12);
});

test('veredicto de validación: exige muestra, mejora sobre la base y buena calibración', () => {
  const good = { count: 500, skill: 0.03, calibration: [{ range: '60-70%', count: 200, predicted: 0.66, observed: 0.68 }] };
  assert.equal(V.validationVerdict(good).validated, true);
  assert.equal(V.validationVerdict({ ...good, count: 120 }).validated, false);
  assert.equal(V.validationVerdict({ ...good, skill: 0.002 }).validated, false);
  const bad = { ...good, calibration: [{ range: '70-80%', count: 100, predicted: 0.75, observed: 0.6 }] };
  const v = V.validationVerdict(bad);
  assert.equal(v.validated, false);
  assert.match(v.reasons.join(' '), /mal calibradas/);
  // Bandas con pocos casos no invalidan.
  const thin = { ...good, calibration: [{ range: '90-100%', count: 5, predicted: 0.95, observed: 0.6 }] };
  assert.equal(V.validationVerdict(thin).validated, true);
  assert.equal(V.validationVerdict({ count: 0 }).validated, false);
});

test('mejor configuración = menor Brier', () => {
  const best = V.bestByBrier([{ brier: 0.2, count: 10, id: 'a' }, { brier: 0.18, count: 10, id: 'b' }, { brier: null, count: 0, id: 'c' }]);
  assert.equal(best.id, 'b');
  assert.equal(V.bestByBrier([]), null);
});

test('en vivo: con 0-0 la probabilidad baja a medida que pasa el 1T y el EV usa la cuota', () => {
  const base = { lambdaTotal: 1.1, goalsNow: 0, odds05: 2.0 };
  const early = V.liveView({ ...base, minute: 5 }, T), late = V.liveView({ ...base, minute: 35 }, T);
  assert.equal(early.ok, true);
  assert.ok(early.over05.pWin > late.over05.pWin);
  assert.ok(late.over05.pWin > 0 && late.over05.pWin < 0.5);
  assert.ok(Math.abs(late.over05.ev - (late.over05.pWin * 2 - 1)) < 1e-9);
  assert.equal(V.liveView({ lambdaTotal: null, minute: 10 }, T).ok, false);
  assert.equal(V.liveView({ lambdaTotal: 1, minute: undefined }, T).ok, false);
});

test('en vivo: si ya hay un gol, Over 0,5 está ganado y Over 1,0 depende del resto', () => {
  const v = V.liveView({ lambdaTotal: 1.1, goalsNow: 1, minute: 20, odds05: 1.1, odds10: 2.2 }, T);
  assert.ok(Math.abs(v.over05.pWin - 1) < 1e-9);
  assert.ok(v.over10.pPush > 0.3); // con 1 gol y línea 1,0, "no más goles" devuelve el stake
});

test('el registro se limita a 3000 predicciones y conserva las más recientes', () => {
  const map = {};
  for (let i = 0; i < 3100; i++) map[i] = { id: String(i), ts: i };
  const kept = V.pruneLog(map);
  assert.equal(Object.keys(kept).length, 3000);
  assert.ok(kept['3099'] && !kept['0']);
});

test('Kelly: fórmula, mezcla con el mercado, fracción y tope', () => {
  // p=0,55 a cuota 2,0: Kelly completo = (0,55·1 − 0,45)/1 = 0,10 → ¼ = 2,5%.
  const k = T.kellyStake({ p: 0.55, odds: 2.0 });
  assert.ok(Math.abs(k.full - 0.10) < 1e-12);
  assert.ok(Math.abs(k.stake - 0.025) < 1e-12);
  // Con mercado 0,51 se usa 0,53 → completo 0,06 → ¼ = 1,5%.
  assert.ok(Math.abs(T.kellyStake({ p: 0.55, odds: 2.0, marketProb: 0.51 }).stake - 0.015) < 1e-12);
  // Liga sin validar: solo cuenta el mercado, y se apuesta ⅛. Mercado 0,55 a 2,0 → completo 0,10 → 1,25%.
  assert.ok(Math.abs(T.kellyStake({ p: 0.70, odds: 2.0, marketProb: 0.55, validated: false }).stake - 0.0125) < 1e-12);
  // Liga sin validar y sin mercado: no apostar.
  assert.equal(T.kellyStake({ p: 0.70, odds: 2.0, validated: false }).stake, 0);
  // Caso real (Mushuc Runa vs Manta): modelo 74,5%, mercado 66,4%, cuota 1,50, liga sin aprobar.
  // El mercado dice que no hay ventaja, así que Kelly no debe sugerir apostar.
  assert.equal(T.kellyStake({ p: 0.745, odds: 1.5, marketProb: 0.664, validated: false }).stake, 0);
  // Ventaja enorme: tope 3%.
  const big = T.kellyStake({ p: 0.9, odds: 2.0 });
  assert.equal(big.stake, 0.03); assert.equal(big.capped, true);
  // Sin ventaja o sin cuota: no apostar.
  assert.equal(T.kellyStake({ p: 0.45, odds: 2.0 }).stake, 0);
  assert.equal(T.kellyStake({ p: 0.6, odds: null }).ok, false);
});

test('registro: Brier del modelo contra el del mercado, sobre las mismas predicciones', () => {
  const entries = [
    { ts: 1, p: 0.9, marketProb: 0.6, y: 1 },
    { ts: 2, p: 0.2, marketProb: 0.5, y: 0 },
    { ts: 3, p: 0.7, y: 1 } // sin mercado: no entra en la comparación
  ];
  const v = V.brierVsMarket(entries, T);
  assert.equal(v.n, 2);
  assert.ok(Math.abs(v.model - (0.01 + 0.04) / 2) < 1e-9);
  assert.ok(Math.abs(v.market - (0.16 + 0.25) / 2) < 1e-9);
  assert.ok(v.diff < 0);
  assert.equal(V.brierVsMarket([], T).n, 0);
});

test('registro: desglose del ROI por rango de EV y por liga', () => {
  const entries = [
    { p: 0.6, y: 1, odds: 2.0, ev: 0.20, evMkt: 0.02, lid: 1, ln: 'Liga A' },
    { p: 0.6, y: 0, odds: 1.8, ev: 0.08, evMkt: -0.03, lid: 1, ln: 'Liga A' },
    { p: 0.6, y: 1, odds: 1.5, ev: 0.07, evMkt: 0.01, lid: 2, ln: 'Liga B' }
  ];
  const b = V.roiBreakdown(entries);
  const r510 = b.byEv.find(r => r.label === '5–10%');
  assert.equal(r510.n, 2); assert.ok(Math.abs(r510.profit - (-1 + 0.5)) < 1e-12);
  assert.equal(b.byEv.find(r => r.label === '15% o más').n, 1);
  assert.equal(b.byEvMkt.find(r => r.label === 'Negativo').n, 1);
  assert.equal(b.byLeague[0].label, 'Liga A'); assert.equal(b.byLeague[0].n, 2);
});

test('simulación de banca: Kelly y plano en orden cronológico', () => {
  const entries = [
    { ts: 2, p: 0.55, odds: 2.0, y: 0 },
    { ts: 1, p: 0.55, odds: 2.0, y: 1 }
  ];
  const r = V.stakeReplay(entries, T);
  assert.equal(r.n, 2);
  // Kelly 2,5%: gana primero (1,025) y pierde después (1,025·0,975).
  assert.ok(Math.abs(r.kelly.final - 1.025 * 0.975) < 1e-12);
  assert.ok(Math.abs(r.kelly.maxDrawdown - 0.025) < 1e-12);
  // Plano 1%: +0,01 y −0,01.
  assert.ok(Math.abs(r.flat.final - 1) < 1e-12);
  const s = V.summarizeLog(entries.map(e => ({ ...e, signal: 'ev_solido' })), T);
  assert.equal(s.replay.n, 2);
});

// Generador determinístico para datos de prueba.
function rng(seed) { let x = seed; return () => (x = (x * 16807) % 2147483647) / 2147483647; }

test('juicio honesto: elige parámetros solo con partidos anteriores', () => {
  const r = rng(3), A = [], B = [];
  for (let i = 0; i < 400; i++) {
    const truth = 0.5 + 0.4 * r(), y = r() < truth ? 1 : 0;
    A.push({ id: i, leagueId: 1, ts: i, p: 0.7, y });   // configuración por defecto: siempre 70%
    B.push({ id: i, leagueId: 1, ts: i, p: truth, y }); // configuración que conoce la verdad
  }
  const h = V.honestRows([{ cfg: 'A', rows: A }, { cfg: 'B', rows: B }], T, { minPrior: 150 });
  assert.equal(h.rows.length, 400);
  // Hasta tener 150 partidos previos usa la de por defecto; después, la mejor.
  assert.equal(h.rows[0].cfgIndex, 0);
  assert.equal(h.rows[149].cfgIndex, 0);
  assert.equal(h.rows[399].cfgIndex, 1);
});

test('juicio honesto: la calibración de un partido no depende de su propio resultado', () => {
  const make = lastY => {
    const r = rng(5), rows = [];
    for (let i = 0; i < 500; i++) rows.push({ id: i, leagueId: 1, ts: i, p: 0.6 + 0.3 * r(), y: i === 499 ? lastY : (r() < 0.6 ? 1 : 0) });
    return V.honestRows([{ cfg: 'A', rows }], T, { calibrate: true }).rows;
  };
  const a = make(0), b = make(1);
  assert.equal(a[499].p, b[499].p);
  assert.notEqual(a[499].p, a[499].pModel); // sí se calibró (había más de 300 previos)
  assert.equal(a[10].p, a[10].pModel);      // al principio no hay calibración
});

test('confianza: separa mejora real de suerte, y una liga necesita confianza alta para aprobar', () => {
  assert.equal(V.confidenceOf(0.02, 0.01), 'alta');
  assert.equal(V.confidenceOf(0.012, 0.01), 'media');
  assert.equal(V.confidenceOf(0.005, 0.01), 'baja');
  assert.equal(V.confidenceOf(null, 0.01), null);
  // Modelo que conoce la verdad en 2000 partidos: mejora clara y confianza alta.
  const r = rng(11), good = [], noise = [];
  for (let i = 0; i < 2000; i++) {
    const truth = 0.4 + 0.5 * r(), y = r() < truth ? 1 : 0;
    good.push({ leagueId: 1, ts: i, p: truth, y });
  }
  // Modelo que solo agrega ruido alrededor del 70% en 150 partidos.
  for (let i = 0; i < 150; i++) { const y = r() < 0.7 ? 1 : 0; noise.push({ leagueId: 2, ts: i, p: 0.7 + (r() - 0.5) * 0.04, y }); }
  const per = V.leagueVerdicts(good.concat(noise), T);
  assert.equal(per['1'].confidence, 'alta');
  assert.ok(per['1'].skillSe > 0);
  assert.notEqual(per['2'].status, 'aprobada');
});

test('por liga contra el mercado: separa la liga donde el modelo sabe más que las casas', () => {
  const r = rng(21), entries = [];
  for (let i = 0; i < 600; i++) {
    const truth = 0.4 + 0.5 * r(), y = r() < truth ? 1 : 0;
    // Liga 1: el modelo conoce la verdad y el mercado se equivoca bastante.
    entries.push({ lid: 1, ln: 'Liga buena', lc: 'Spain', p: truth, marketProb: Math.min(0.97, Math.max(0.03, truth + (r() - 0.5) * 0.4)), y });
  }
  for (let i = 0; i < 600; i++) {
    const truth = 0.4 + 0.5 * r(), y = r() < truth ? 1 : 0;
    // Liga 2: es al revés, el mercado conoce la verdad.
    entries.push({ lid: 2, ln: 'Liga mala', p: Math.min(0.97, Math.max(0.03, truth + (r() - 0.5) * 0.4)), marketProb: truth, y });
  }
  for (let i = 0; i < 20; i++) entries.push({ lid: 3, ln: 'Liga chica', p: 0.7, marketProb: 0.7, y: 1 });
  entries.push({ lid: 1, p: 0.7, y: 1 });              // sin mercado: no cuenta
  entries.push({ lid: 1, p: 0.7, marketProb: 0.6 });   // pendiente: no cuenta
  const list = V.leagueVsMarket(entries), by = Object.fromEntries(list.map(x => [x.lid, x]));
  assert.equal(by['1'].status, 'gana'); assert.equal(by['1'].n, 600); assert.ok(by['1'].skill > 0); assert.equal(by['1'].country, 'Spain');
  assert.equal(by['2'].status, 'no'); assert.ok(by['2'].skill < 0);
  assert.equal(by['3'].status, 'faltan');
  assert.equal(list[0].lid, '1'); // las que le ganan, primero
});
