'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const model = require('../modelo-poisson.js');

// Generador reproducible para datos sintéticos.
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function poisson(rnd, l) { const L = Math.exp(-l); let k = 0, p = 1; do { k++; p *= rnd(); } while (p > L); return k - 1; }

function syntheticLeague(seed) {
  const rnd = mulberry32(seed);
  const att = [2, 1, 1, 1, 0.5, 1], def = [1, 1, 1, 1, 1, 1.5];
  const games = [];
  let k = 0;
  for (let r = 0; r < 40; r++) for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) if (i !== j) {
    games.push({ id: ++k, ts: 1.6e9 + k * 3600, h: i, a: j, hg: poisson(rnd, 0.6 * att[i] * def[j]), ag: poisson(rnd, 0.45 * att[j] * def[i]), season: 1, leagueId: 9 });
  }
  return { games, cutoff: 1.6e9 + k * 3600 + 1 };
}

test('el ajuste rechaza muestras insuficientes y datos inválidos', () => {
  assert.equal(model.fitLeague([], {}).ok, false);
  assert.equal(model.fitLeague([{ h: '1', a: '2', hg: 1, ag: 0, w: 1 }], {}).ok, false);
  assert.equal(model.predictMatch(null, 1, 2).ok, false);
});

test('recupera fuerzas reales: el equipo ofensivo y la defensa débil se detectan', () => {
  const { games, cutoff } = syntheticLeague(7);
  const fit = model.fitLeague(model.buildFitMatches(games, { cutoffTs: cutoff, currentSeason: 1 }), { priorMatches: 4 });
  assert.equal(fit.ok, true);
  const t = fit.teams;
  assert.ok(t['0'].attack > 1.4, 'equipo 0 debería ser muy ofensivo');
  assert.ok(t['4'].attack < 0.75, 'equipo 4 debería ser poco ofensivo');
  assert.ok(t['5'].defence > 1.2, 'equipo 5 debería conceder más');
});

test('P(Over 0,5 1T) = 1 − exp(−λ total) con λ sin redondear', () => {
  const { games, cutoff } = syntheticLeague(11);
  const fit = model.fitLeague(model.buildFitMatches(games, { cutoffTs: cutoff, currentSeason: 1 }), {});
  const pr = model.predictMatch(fit, 0, 1, {});
  assert.equal(pr.ok, true);
  assert.ok(Math.abs(pr.pOver05 - (1 - Math.exp(-pr.lambdaTotal))) < 1e-12);
  assert.ok(pr.pLow <= pr.pOver05 && pr.pOver05 <= pr.pHigh);
  assert.ok(Math.abs(pr.lambdaTotal - (pr.lambdaHome + pr.lambdaAway)) < 1e-12);
});

test('el local y el visitante no se confunden: un equipo ofensivo en casa sube λ local', () => {
  const { games, cutoff } = syntheticLeague(5);
  const fit = model.fitLeague(model.buildFitMatches(games, { cutoffTs: cutoff, currentSeason: 1 }), {});
  const a = model.predictMatch(fit, 0, 4, {}), b = model.predictMatch(fit, 4, 0, {});
  assert.ok(a.lambdaHome > b.lambdaHome);
});

test('solo usa partidos anteriores al corte', () => {
  const games = [
    { ts: 100, h: 1, a: 2, hg: 1, ag: 0, season: 1 },
    { ts: 200, h: 1, a: 2, hg: 5, ag: 5, season: 1 }
  ];
  assert.equal(model.buildFitMatches(games, { cutoffTs: 150, currentSeason: 1 }).length, 1);
});

test('la mezcla con xG solo actúa cuando hay xG en ambos equipos', () => {
  const games = [
    { ts: 100, h: 1, a: 2, hg: 0, ag: 0, season: 1, xh: 2, xa: 1 },
    { ts: 100, h: 3, a: 4, hg: 0, ag: 0, season: 1 }
  ];
  const fm = model.buildFitMatches(games, { cutoffTs: 200, currentSeason: 1, xgWeight: 0.5 });
  assert.equal(fm.find(m => m.h === '1').usedXg, true);
  assert.equal(fm.find(m => m.h === '3').usedXg, false);
  assert.ok(fm.find(m => m.h === '1').hg > 0);
});

test('la calibración logística corrige probabilidades sobreconfiadas', () => {
  const rnd = mulberry32(3);
  const rows = [];
  for (let i = 0; i < 2000; i++) { const p = 0.5 + 0.45 * rnd(); const real = 0.7 + (p - 0.7) * 0.3; rows.push({ ts: i, p, y: rnd() < real ? 1 : 0 }); }
  const cal = model.fitCalibration(rows);
  assert.ok(cal.b < 0.6, 'la pendiente debe aplanarse');
  const raw = model.scoreRows(rows), fixed = model.scoreRows(rows, r => model.applyCalibration(cal, r.p));
  assert.ok(fixed.brier < raw.brier);
});

test('el backtest rolling no mira el futuro y arroja métricas coherentes', () => {
  const { games } = syntheticLeague(21);
  const bt = model.rollingBacktest(games, { minFitMatches: 30 });
  assert.ok(bt.rows.length > 100);
  assert.ok(bt.metrics.brier > 0 && bt.metrics.brier < 0.3);
  const sumBands = bt.metrics.calibration.reduce((s, b) => s + b.count, 0);
  assert.equal(sumBands, bt.metrics.count, 'las bandas de calibración deben cubrir todo (incluye 70-80%)');
});

test('regla de EV: exige edge, incertidumbre y consistencia con el mercado', () => {
  const sin = model.evDecision({ p: 0.7, pLow: 0.6, odds: 1.4 });
  assert.equal(sin.signal, 'sin_ev');
  assert.ok(Math.abs(sin.ev - (0.7 * 1.4 - 1)) < 1e-12);
  const solido = model.evDecision({ p: 0.75, pLow: 0.68, odds: 1.5, validated: true });
  assert.equal(solido.signal, 'ev_solido');
  const posible = model.evDecision({ p: 0.75, pLow: 0.6, odds: 1.5, validated: true });
  assert.equal(posible.signal, 'ev_posible');
  const lejos = model.evDecision({ p: 0.8, pLow: 0.75, odds: 1.5, marketProb: 0.6 });
  assert.equal(lejos.signal, 'sin_ev');
  assert.equal(model.evDecision({ p: 0.7, odds: 1 }).signal, 'no_evaluable');
});

test('en vivo: 0-0 avanzado baja la probabilidad y la línea 1,0 reconoce el push', () => {
  const base = 1.1;
  const m0 = model.liveRemainingLambda({ lambdaTotalHT: base, minute: 0, goalsNow: 0 });
  const m30 = model.liveRemainingLambda({ lambdaTotalHT: base, minute: 30, goalsNow: 0 });
  assert.ok(Math.abs(m0.lambdaRemaining - base) < 1e-9);
  assert.ok(m30.lambdaRemaining < m0.lambdaRemaining);
  const pOver = x => model.liveMarket({ lambdaRemaining: x.lambdaRemaining, goalsNow: 0, line: 0.5, odds: 2 }).pWin;
  assert.ok(pOver(m30) < pOver(m0));
  const r = model.liveMarket({ lambdaRemaining: 0.5, goalsNow: 1, line: 1.0, odds: 2 });
  assert.ok(Math.abs(r.pPush - Math.exp(-0.5)) < 1e-9);
  assert.ok(Math.abs(r.pWin + r.pPush + r.pLose - 1) < 1e-9);
  assert.ok(Math.abs(r.ev - (r.pWin * 1 - r.pLose)) < 1e-12);
});

test('compatibilidad: summarizeTeam ignora observaciones inválidas', () => {
  const summary = model.summarizeTeam([
    { scoredHT: 1, concededHT: 0 }, { scoredHT: -1, concededHT: 0 }, { scoredHT: '2', concededHT: 0 }
  ], 1, 8);
  assert.equal(summary.matches, 1);
  assert.equal(summary.scoredHT, 1);
});
