'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const A = require('../aeg-formula.js');

const close = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) < tol, `${a} ≠ ${b}`);
const DAY = 86400;
const KICK = Date.UTC(2026, 9, 1) / 1000;
const fx = { id: 999, iso: new Date(KICK * 1000).toISOString(), lid: 10, season: 2026, hid: 1, aid: 2 };

// Partidos de un equipo: lista de [goles 1T, goles totales, temporada, liga, local?], del más reciente al más viejo.
function games(team, rows) {
  return rows.map(([fh, tot, s = 2026, l = 10, home = true], i) => ({
    i: team * 1000 + i, d: KICK - (i + 1) * DAY, h: home ? team : 50, a: home ? 50 : team,
    fh, fs: [tot, 0], s, l
  }));
}

test('cuota real = 1 / % (ejemplos de la clase)', () => {
  close(1 / (105 / 131), 1.2476, 1e-4);
  close(1 / (75 / 88), 1.1733, 1e-4);
  close(1 / (8 / 9), 1.125);
});

test('suma de los dos equipos: las temporadas se juntan partido a partido', () => {
  const h = games(1, [...Array(10).fill([1, 3]), ...Array(10).fill([1, 3, 2025]), [0, 1, 2025]]);
  const a = games(2, [...Array(8).fill([1, 3]), [0, 2], [0, 2]]);
  const ms = A.matchStats(h, a, fx, 'pooled|all|cp|both');
  assert.equal(ms.n, 31); assert.equal(ms.hits, 28);
  close(ms.fair, 31 / 28);
  assert.deepEqual([ms.current.n, ms.current.hits, ms.previous.n, ms.previous.hits], [20, 18, 11, 10]);
  // Solo temporada actual
  const c = A.matchStats(h, a, fx, 'pooled|all|c|both');
  assert.equal(c.n, 20);
});

test('variantes de muestra: liga, local/visitante y promedio o mínimo de %', () => {
  const h = games(1, [[1, 3, 2026, 10, true], [0, 1, 2026, 99, true], [1, 3, 2026, 10, false], [0, 2, 2026, 10, false]]);
  const a = games(2, [[1, 3, 2026, 10, false], [1, 3, 2026, 10, true]]);
  assert.equal(A.matchStats(h, a, fx, 'pooled|league|cp|both').a.n, 3);
  assert.equal(A.matchStats(h, a, fx, 'pooled|all|cp|split').a.n, 2);
  assert.equal(A.matchStats(h, a, fx, 'pooled|all|cp|split').b.n, 1);
  close(A.matchStats(h, a, fx, 'avg|all|cp|both').rate, (0.5 + 1) / 2);
  close(A.matchStats(h, a, fx, 'min|all|cp|both').rate, 0.5);
});

test('no usa partidos posteriores ni el propio partido', () => {
  const h = games(1, [[1, 3]]); h.push({ i: 999, d: KICK, h: 1, a: 2, fh: 0, fs: [0, 0], s: 2026, l: 10 });
  h.push({ i: 5, d: KICK + DAY, h: 1, a: 3, fh: 0, fs: [0, 0], s: 2026, l: 10 });
  assert.equal(A.matchStats(h, games(2, [[1, 2]]), fx, A.DEFAULT_VARIANT).a.n, 1);
});

test('rachas actuales y reglas de la clase', () => {
  const strong = games(1, [...Array(12).fill([1, 4]), ...Array(8).fill([1, 3])]);
  const other = games(2, [...Array(5).fill([1, 3]), [0, 2], ...Array(14).fill([1, 3])]);
  const ms = A.matchStats(strong, other, fx, A.DEFAULT_VARIANT);
  assert.equal(ms.a.over, 20); assert.equal(ms.b.over, 5); assert.equal(ms.b.under, 0);
  const ev = A.evaluate(ms, 'full');
  assert.ok(ev.pass); assert.equal(ev.streakVia, 'over');

  // Racha Under de 4: afuera aunque el % sea alto
  const under4 = games(2, [[0, 3], [0, 3], [0, 3], [0, 3], ...Array(30).fill([1, 3])]);
  assert.deepEqual(A.evaluate(A.matchStats(strong.slice(12), under4, fx, A.DEFAULT_VARIANT), 'full').fails, ['racha Under larga']);

  // Muestra chica: 8/9 no alcanza (River)
  const small = A.matchStats(games(1, [[1, 3], [1, 3], [1, 3], [1, 3], [0, 3]]), games(2, [[1, 3], [1, 3], [1, 3], [1, 3]]), fx, A.DEFAULT_VARIANT);
  close(small.fair, 1.125);
  assert.deepEqual(A.evaluate(small, 'core').fails, ['muestra']);

  // Promedios: uno ≥ 3,0 y el otro ≥ 2,8
  const low = A.matchStats(games(1, Array(20).fill([1, 3])), games(2, Array(20).fill([1, 2])), fx, A.DEFAULT_VARIANT);
  assert.ok(A.evaluate(low, 'core').pass);
  assert.deepEqual(A.evaluate(low, 'avg').fails, ['promedios']);
});

test('calibración: encuentra la variante que reproduce los picks', () => {
  // El pick tiene 80% sumando todas las competiciones, pero no en su liga sola.
  const pickFx = { ...fx, id: 1 };
  const otherFx = { ...fx, id: 2, hid: 3, aid: 4 };
  const histories = new Map([
    [1, games(1, [...Array(16).fill([1, 3, 2026, 99]), ...Array(4).fill([0, 3, 2026, 10])])],
    [2, games(2, [...Array(16).fill([1, 3, 2026, 99]), ...Array(4).fill([0, 3, 2026, 10])])],
    [3, games(3, Array(20).fill([0, 1]))],
    [4, games(4, Array(20).fill([0, 1]))]
  ]);
  const rows = A.calibrate(new Set(['1']), [{ date: '2026-10-01', fixtures: [pickFx, otherFx] }], histories, null, { ruleSets: ['core'] });
  const best = rows[0];
  assert.equal(best.recall, 1); assert.equal(best.perDay, 1);
  assert.ok(best.variant.includes('|all|'));
  const leagueOnly = rows.find(r => r.variant === 'pooled|league|cp|both');
  assert.equal(leagueOnly.found, 0); assert.deepEqual(leagueOnly.missed, [1]);
});

test('cuota justa en vivo con 0-0 (tabla del análisis)', () => {
  close(A.liveFair(0.8, 15).odd, 1.52, 0.01);
  close(A.liveFair(0.85, 10).odd, 1.30, 0.01);
  assert.equal(A.liveFair(0.8, 45), null);
});

test('umbrales de cuota real y filtro de EV en la calibración', () => {
  const pickFx = { ...fx, id: 1 }, otherFx = { ...fx, id: 2, hid: 3, aid: 4 };
  // Pick con 15/20 por equipo (cuota real 1,33) y otro partido con 18/20 (1,11).
  const mk = (t, hits) => games(t, Array.from({ length: 20 }, (_, i) => [i < hits ? 1 : 0, 3]));
  const histories = new Map([[1, mk(1, 15)], [2, mk(2, 15)], [3, mk(3, 18)], [4, mk(4, 18)]]);
  const days = [{ date: 'd', fixtures: [pickFx, otherFx] }];
  const v = [A.variantById(A.DEFAULT_VARIANT)];
  const rows = A.calibrate(new Set(['1']), days, histories, null, { variants: v, ruleSets: ['core'], thresholds: [1.25, 1.35] });
  assert.equal(rows.find(r => r.maxFair === 1.25).found, 0);
  const r135 = rows.find(r => r.maxFair === 1.35);
  assert.equal(r135.found, 1); assert.equal(r135.perDay, 2);
  // EV: el pick paga 1,45 (EV +9%) y el otro 1,08 (EV −3%): con EV queda solo el pick.
  const odds = new Map([['1', { best: 1.45, median: 1.30 }], ['2', { best: 1.08, median: 1.05 }]]);
  const ev = A.calibrate(new Set(['1']), days, histories, null, { variants: v, ruleSets: ['coreEv'], thresholds: [1.35], odds, quotes: ['best', 'median'] });
  const best = ev.find(r => r.quote === 'best'), med = ev.find(r => r.quote === 'median');
  assert.equal(best.found, 1); assert.equal(best.perDay, 1);
  assert.equal(med.found, 0);
  const e = A.evaluate(A.matchStats(histories.get(1), histories.get(2), pickFx, v[0]), 'coreEv', { maxFair: 1.35 }, null);
  assert.deepEqual(e.fails, ['sin cuota']);
});

test('orden de la lista: mide cuántos picks quedan entre los primeros del día', () => {
  const mk = (t, hits) => games(t, Array.from({ length: 20 }, (_, i) => [i < hits ? 1 : 0, 3]));
  // Tres partidos que pasan: el pick (cuota real 1,18) es el de mayor EV, pero no el de menor cuota real.
  const f1 = { ...fx, id: 1, hid: 1, aid: 2 }, f2 = { ...fx, id: 2, hid: 3, aid: 4 }, f3 = { ...fx, id: 3, hid: 5, aid: 6 };
  const histories = new Map([[1, mk(1, 17)], [2, mk(2, 17)], [3, mk(3, 19)], [4, mk(4, 19)], [5, mk(5, 18)], [6, mk(6, 18)]]);
  const odds = new Map([['1', { best: 1.40, median: 1.35 }], ['2', { best: 1.02, median: 1.01 }], ['3', { best: 1.12, median: 1.10 }]]);
  const days = [{ date: 'd', fixtures: [f1, f2, f3] }];
  const v = [A.variantById(A.DEFAULT_VARIANT)];
  const rows = A.calibrate(new Set(['1']), days, histories, null, { variants: v, ruleSets: ['core'], thresholds: [1.25], sorts: ['ev', 'fair'], odds });
  const byEv = rows.find(r => r.sort === 'ev'), byFair = rows.find(r => r.sort === 'fair');
  assert.equal(byEv.topK, 1); assert.equal(byFair.topK, 0); assert.equal(byFair.top10, 1);
  assert.equal(rows[0].sort, 'ev');
  // Tolerancia de EV: con −5% también pasa un partido de EV −3%.
  const tol = A.calibrate(new Set(['2']), days, histories, null, { variants: v, ruleSets: ['coreEv'], thresholds: [1.25], minEvs: [0, -0.05], odds });
  assert.equal(tol.find(r => r.minEv === 0).found, 0);
  assert.equal(tol.find(r => r.minEv === -0.05).found, 1);
});

test('reglas de la clase: temporadas, rango de cuota, Under que se corta y promedios compensados', () => {
  const v = A.DEFAULT_VARIANT;
  const seq = (t, rows) => games(t, rows);
  const ok = Array(20).fill([1, 3]);
  // Base que pasa todo: 40/40 con racha Over larga.
  const pass = A.matchStats(seq(1, ok), seq(2, ok), fx, v);
  assert.ok(A.evaluate(pass, 'video', { maxFair: 1.25 }).pass);
  // Cuota real por debajo del mínimo del rango (1,10).
  assert.deepEqual(A.evaluate(pass, 'video', { maxFair: 1.25, minFair: 1.10 }).fails, ['cuota real baja']);

  // Temporada anterior floja (60%) aunque el total llegue al 80%: afuera.
  const cur = Array(30).fill([1, 3]), prev = [...Array(6).fill([1, 3, 2025]), ...Array(4).fill([0, 3, 2025])];
  const ms = A.matchStats(seq(1, [...cur.slice(0, 15), ...prev]), seq(2, cur.slice(0, 15)), fx, v);
  assert.ok(ms.fair <= 1.25);
  assert.ok(A.evaluate(ms, 'video', { maxFair: 1.25 }).fails.includes('temporada anterior'));
  assert.ok(A.evaluate(ms, 'full', { maxFair: 1.25 }).pass, 'las reglas viejas no lo miraban');

  // Rangers (documento): 53/67 = 79,1% en la temporada actual y 105/131 en total → se acepta con cuota real 1,25.
  const mkSeason = (t, curHits, curN, prevHits, prevN) => games(t, [
    ...Array.from({ length: curN }, (_, i) => [i < curHits ? 1 : 0, 3, 2026]),
    ...Array.from({ length: prevN }, (_, i) => [i < prevHits ? 1 : 0, 3, 2025])]);
  const rangers = A.matchStats(mkSeason(1, 31, 40, 30, 34), mkSeason(2, 22, 27, 22, 30), fx, v);
  assert.deepEqual([rangers.current.hits, rangers.current.n, rangers.hits, rangers.n], [53, 67, 105, 131]);
  const re = A.evaluate(rangers, 'video', { maxFair: 1.25 });
  assert.equal(re.fails.includes('temporada actual'), false);
  assert.equal(re.fails.includes('cuota real'), false);
  // Racha Under de 2 que en el historial casi siempre se cortó → pasa; que suele seguir → afuera.
  const breaks = [[0, 3], [0, 3], ...Array(4).fill([[1, 3], [1, 3], [1, 3], [0, 3], [0, 3]]).flat(), ...Array(10).fill([1, 3])];
  const cont = [[0, 3], [0, 3], ...Array(4).fill([[1, 3], [1, 3], [1, 3], [1, 3], [0, 3], [0, 3], [0, 3]]).flat(), ...Array(20).fill([1, 3])];
  const other = seq(2, Array(30).fill([1, 3]).map((x, i) => i === 0 ? [0, 3] : x));
  const good = A.evaluate(A.matchStats(seq(1, breaks), other, fx, v), 'video', { maxFair: 1.40 });
  assert.equal(good.streakVia, 'under'); assert.ok(!good.fails.includes('racha Under que suele seguir'));
  const bad = A.evaluate(A.matchStats(seq(1, cont), other, fx, v), 'video', { maxFair: 1.40 });
  assert.ok(bad.fails.includes('racha Under que suele seguir'));

  // Promedios bajos: se compensan con racha Over fuerte y muestra ≥ 40; sin eso, afuera.
  const low = A.matchStats(seq(1, Array(25).fill([1, 2])), seq(2, Array(25).fill([1, 2])), fx, v);
  const lowEv = A.evaluate(low, 'video', { maxFair: 1.25 });
  assert.ok(lowEv.pass); assert.ok(lowEv.notes.some(n => n.includes('compensados')));
  const lowSmall = A.matchStats(seq(1, Array(16).fill([1, 2])), seq(2, Array(16).fill([1, 2])), fx, v);
  assert.deepEqual(A.evaluate(lowSmall, 'video', { maxFair: 1.25 }).fails, ['promedios']);
});
