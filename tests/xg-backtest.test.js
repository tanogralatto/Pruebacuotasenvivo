'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const xg = require('../modelo-xg.js');
const backtest = require('../backtest-poisson.js');

test('el parser de xG solo acepta xG explícito y no negativo', () => {
  assert.equal(xg.extractExplicitXg([{ statistics: [{ type: 'Total Shots', value: 12 }] }]).available, false);
  assert.equal(xg.extractExplicitXg([{ statistics: [{ type: 'expected_goals', value: '1.20' }] }]).value, 1.2);
  assert.equal(xg.extractExplicitXg([{ statistics: [{ type: 'Expected Goals', value: '1.2' }] }]).value, 1.2);
  assert.equal(xg.extractExplicitXg([{ statistics: [{ type: 'expected_goals', value: null }] }]).available, false);
  assert.equal(xg.extractExplicitXg([{ statistics: [{ type: 'expected_goals', value: -1 }] }]).available, false);
});

test('el xG del partido se asigna por id de equipo, no por orden', () => {
  const resp = [
    { team: { id: 20 }, statistics: [{ type: 'expected_goals', value: '0.4' }] },
    { team: { id: 10 }, statistics: [{ type: 'expected_goals', value: '1.7' }] }
  ];
  const r = xg.extractMatchXg(resp, 10, 20);
  assert.equal(r.available, true);
  assert.equal(r.home, 1.7);
  assert.equal(r.away, 0.4);
  assert.equal(xg.extractMatchXg([resp[0], { team: { id: 10 }, statistics: [] }], 10, 20).available, false);
});

test('xG del primer tiempo solo se etiqueta así si viene de un dataset de 1T', () => {
  assert.equal(xg.extractFirstHalfXg([{ statistics: [{ type: 'xG', value: 0.8 }] }]).scope, 'first_half');
  assert.equal(xg.extractExplicitXg([{ statistics: [{ type: 'xG', value: 0.8 }] }]).scope, 'unspecified');
});

test('el backtest elimina ids duplicados y ordena cronológicamente', () => {
  const ordered = backtest.uniqueChronological([
    { fixtureId: 2, date: '2026-01-02', leagueId: 1, season: 2026, homeTeamId: 1, awayTeamId: 2, homeHT: 0, awayHT: 0 },
    { fixtureId: 1, date: '2026-01-01', leagueId: 1, season: 2026, homeTeamId: 1, awayTeamId: 2, homeHT: 1, awayHT: 0 },
    { fixtureId: 1, date: '2026-01-01', leagueId: 1, season: 2026, homeTeamId: 1, awayTeamId: 2, homeHT: 1, awayHT: 0 }
  ]);
  assert.deepEqual(ordered.map(m => m.fixtureId), [1, 2]);
});

test('las métricas usan Brier y calculan ROI solo donde hay cuota real', () => {
  const metrics = backtest.scorePredictions([
    { probability: 0.8, outcome: 1, odds: 1.5 },
    { probability: 0.6, outcome: 0, odds: null }
  ]);
  assert.equal(metrics.count, 2);
  // ((0.8-1)^2 + (0.6-0)^2) / 2 = (0.04 + 0.36) / 2 = 0.20
  assert.ok(Math.abs(metrics.brierScore - 0.2) < 1e-10);
  assert.equal(metrics.oddsCount, 1);
  assert.equal(metrics.profitUnits, 0.5);
  assert.equal(metrics.roi, 0.5);
});

test('las bandas de calibración incluyen el rango 70-80%', () => {
  const m = backtest.scorePredictions([{ probability: 0.75, outcome: 1, odds: null }]);
  assert.equal(m.calibration.length, 1);
  assert.equal(m.calibration[0].range, '70-80%');
});

test('runBacktest funciona de punta a punta con un dataset en el formato documentado', () => {
  const matches = [];
  let id = 0;
  for (let r = 0; r < 12; r++) for (let i = 1; i <= 6; i++) for (let j = 1; j <= 6; j++) if (i !== j) {
    id++;
    matches.push({ fixtureId: id, date: new Date(Date.UTC(2026, 0, 1) + id * 3600e3 * 6).toISOString(), leagueId: 1, season: 2026, homeTeamId: i, awayTeamId: j, homeHT: (id % 3 === 0) ? 1 : 0, awayHT: (id % 5 === 0) ? 1 : 0, oddsOver05HT: 1.4 });
  }
  const res = backtest.runBacktest(matches, { minFitMatches: 30 });
  assert.ok(res.scored > 50);
  assert.ok(res.metrics.oddsCount > 0);
});
