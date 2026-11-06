'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const F = require('../modelo-ft.js');
const T = require('../modelo-poisson.js');
const close = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) < tol, `${a} ≠ ${b}`);

test('binomial negativa: suma 1, media correcta y más dispersión que Poisson', () => {
  const d = F.nbPmf(5.2, 10);
  close(d.reduce((a, b) => a + b, 0), 1);
  close(d.reduce((a, q, k) => a + q * k, 0), 5.2, 0.01);
  const v = d.reduce((a, q, k) => a + q * (k - 5.2) ** 2, 0);
  close(v, 5.2 * (1 + 5.2 / 10), 0.05);
  const t = F.cornerDist(5.5, 4.5, 12).total;
  close(t.reduce((a, b) => a + b, 0), 1);
  close(t.reduce((a, q, k) => a + q * k, 0), 10, 0.02);
});

test('cuotas de córners: se leen, se resuelven con córners y la línea 9 devuelve con 9', () => {
  const odds = F.parseOdds([{ fixture: { id: 1 }, bookmakers: [
    { name: 'Pinnacle', bets: [{ id: 45, name: 'Corners Over Under', values: [{ value: 'Over 9.5', odd: '1.95' }, { value: 'Under 9.5', odd: '1.90' }] }] },
    { name: 'Bet365', bets: [{ id: 45, name: 'Corners Over Under', values: [{ value: 'Over 9.5', odd: '1.90' }, { value: 'Under 9.5', odd: '1.85' }, { value: 'Over 10.5', odd: '2.50' }, { value: 'Under 10.5', odd: '1.50' }] },
      { id: 57, name: 'Home Corners Over/Under', values: [{ value: 'Over 4.5', odd: '1.80' }, { value: 'Under 4.5', odd: '1.95' }] },
      { id: 99, name: 'Corners Over Under 1st Half', values: [{ value: 'Over 4.5', odd: '1.9' }, { value: 'Under 4.5', odd: '1.9' }] }] }] }]);
  assert.ok(odds.get('c:total:over:9.5').sharp);
  assert.ok(odds.get('c:home:over:4.5'));
  assert.equal([...odds.keys()].filter(k => k.startsWith('c:')).length, 6); // el 1T no entra
  assert.equal(F.betResult({ type: 'corners', scope: 'total', side: 'over', line: 9 }, 5, 4), 0);
  assert.equal(F.betResult({ type: 'corners', scope: 'home', side: 'over', line: 4.5 }, 5, 4), 1);
  assert.equal(F.betLabel({ type: 'corners', scope: 'away', side: 'under', line: 3.5 }, 'Boca', 'River'), 'Córners River menos de 3,5');
  // Las líneas que Pinnacle no cotiza toman el precio de su línea principal.
  const { rows, mean } = F.cornerMarkets({ home: 5.8, away: 4.4 }, odds, { home: 'A', away: 'B' }, 12);
  assert.ok(mean > 9 && mean < 11, 'media ' + mean);
  const r105 = rows.find(r => r.key === 'c:total:over:10.5');
  close(r105.mkt, F.cornerProbs({ scope: 'total', side: 'over', line: 10.5 }, F.cornerDist(mean * 5.8 / 10.2, mean * 4.4 / 10.2, 12)).p);
  assert.ok(r105.sharp && rows.every(r => r.group === 'corners' && r.p > 0));
  // matchMarkets (goles) no mezcla los córners.
  assert.equal(F.matchMarkets({ home: 1.5, away: 1.1 }, odds, {}).rows.length, 0);
});

test('backtest de córners: el modelo le gana al promedio de la liga cuando hay equipos distintos', () => {
  // Liga simulada: 10 equipos con fuerza de córners distinta, binomial negativa.
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const draw = (mu, size) => { const d = F.nbPmf(mu, size); let u = rnd(), k = 0; while (k < d.length - 1 && u > d[k]) { u -= d[k]; k++; } return k; };
  const att = [1.4, 1.25, 1.15, 1.05, 1, 0.95, 0.9, 0.85, 0.8, 0.75], games = [];
  let id = 0;
  for (let round = 0; round < 4; round++) for (let h = 0; h < 10; h++) for (let a = 0; a < 10; a++) if (h !== a) {
    const ts = 1.7e9 + (id++) * 40000;
    games.push({ id, ts, season: 2025, h: 't' + h, a: 't' + a, hg: draw(5.4 * att[h] / att[a] ** 0.5, 12), ag: draw(4.6 * att[a] / att[h] ** 0.5, 12) });
  }
  const rows = F.backtestLeague(games, T, { priorMatches: F.CORNERS.priorMatches, halfLifeDays: F.CORNERS.halfLifeDays });
  const sz = F.fitCornerSize(rows);
  assert.ok(sz.size > 5 && sz.size < 40, 'size ' + sz.size);
  const sk = F.cornerSkill(rows, sz.size);
  assert.ok(sk.n > 200 && sk.skill > 0.02, JSON.stringify(sk));
  assert.ok(F.teamGoalsSkill(rows).n > 0);
});
