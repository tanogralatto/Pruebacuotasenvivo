'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const F = require('../modelo-ft.js');
const T = require('../modelo-poisson.js');
const close = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) < tol, `${a} ≠ ${b}`);

test('matriz: suma 1 y el 1X2 suma 1', () => {
  const m = F.scoreMatrix(1.5, 1.1), s = F.summarize(m);
  close(m.flat().reduce((a, b) => a + b, 0), 1);
  close(s.home + s.draw + s.away, 1);
  close(s.totals.reduce((a, b) => a + b, 0), 1);
  close(s.expGoals, 2.6, 1e-3);
});

test('apuestas: más/menos de 2,5 se complementan; más de 3 devuelve con 3 goles', () => {
  const m = F.scoreMatrix(1.4, 1.2);
  const o = F.betProbs({ type: 'total', side: 'over', line: 2.5 }, m), u = F.betProbs({ type: 'total', side: 'under', line: 2.5 }, m);
  close(o.win + u.win, 1);
  const o3 = F.betProbs({ type: 'total', side: 'over', line: 3 }, m), s = F.summarize(m);
  close(o3.push, s.totals[3]);
  const o275 = F.betProbs({ type: 'total', side: 'over', line: 2.75 }, m);
  close(o275.halfWin, s.totals[3]); // con 3 goles gana la mitad
});

test('apuestas: hándicap 0 del local = 1X2 sin empate; +0,5 = doble oportunidad', () => {
  const m = F.scoreMatrix(1.6, 1.0), s = F.summarize(m);
  const ah0 = F.betProbs({ type: 'ah', side: 'home', line: 0 }, m);
  close(ah0.push, s.draw); close(ah0.p, s.home / (s.home + s.away));
  const ahp = F.betProbs({ type: 'ah', side: 'away', line: 0.5 }, m), dc = F.betProbs({ type: 'dc', pick: 'X2' }, m);
  close(ahp.win, dc.win);
  const ahq = F.betProbs({ type: 'ah', side: 'home', line: -0.25 }, m);
  close(ahq.halfLose, s.draw);
});

test('EV y cuota justa: EV = p × cuota − 1; score 0 sin valor y más alto con cuotas bajas', () => {
  const pr = { W: 0.6, L: 0.4, p: 0.6, fair: 1 / 0.6 };
  close(F.evaluate(pr, 2).ev, 0.2);
  assert.equal(F.evaluate(pr, 1.5).score, 0);
  assert.ok(F.betScore(0.1, 0.8) > F.betScore(0.1, 0.3));
});

const oddsResponse = [{ fixture: { id: 1 }, bookmakers: [
  { name: 'Pinnacle', bets: [
    { name: 'Match Winner', values: [{ value: 'Home', odd: '2.10' }, { value: 'Draw', odd: '3.40' }, { value: 'Away', odd: '3.60' }] },
    { name: 'Goals Over/Under', values: [{ value: 'Over 2.5', odd: '1.95' }, { value: 'Under 2.5', odd: '1.90' }, { value: 'Over 3.0', odd: '2.60' }, { value: 'Under 3.0', odd: '1.50' }] },
    { name: 'Both Teams Score', values: [{ value: 'Yes', odd: '1.80' }, { value: 'No', odd: '2.00' }] },
    { name: 'Asian Handicap', values: [{ value: 'Home -0.5', odd: '2.10' }, { value: 'Away +0.5', odd: '1.80' }, { value: 'Home -0.25', odd: '1.85' }, { value: 'Away +0.25', odd: '2.02' }] },
    { name: 'Goals Over/Under First Half', values: [{ value: 'Over 0.5', odd: '1.40' }, { value: 'Under 0.5', odd: '2.90' }] }
  ] },
  { name: 'Bet365', bets: [
    { name: 'Match Winner', values: [{ value: 'Home', odd: '2.20' }, { value: 'Draw', odd: '3.30' }, { value: 'Away', odd: '3.40' }] },
    { name: 'Double Chance', values: [{ value: 'Home/Draw', odd: '1.30' }, { value: 'Draw/Away', odd: '1.70' }, { value: 'Home/Away', odd: '1.33' }] },
    { name: 'Asian Handicap', values: [{ value: 'Home -0.5', odd: '2.15' }, { value: 'Away -0.5', odd: '1.75' }] }
  ] }
] }];

test('cuotas: lee 1X2, doble oportunidad, totales, ambos marcan y hándicap; ignora el primer tiempo', () => {
  const o = F.parseOdds(oddsResponse);
  assert.equal(o.get('1x2:home').best.price, 2.2);
  assert.equal(o.get('1x2:home').best.bookmaker, 'Bet365');
  const pin = 1 / 2.1 / (1 / 2.1 + 1 / 3.4 + 1 / 3.6);
  close(o.get('1x2:home').mkt, pin);
  assert.ok(o.get('dc:1X'));
  assert.ok(o.get('total:over:2.5') && o.get('total:under:3'));
  assert.ok(!o.get('total:over:0.5'), 'no mezcla el primer tiempo');
  assert.ok(o.get('btts:no'));
  // Bet365 escribe el visitante repitiendo la línea del local («Away -0.5») y Pinnacle con su signo («Away +0.5»).
  assert.ok(o.get('ah:away:0.5'));
  assert.equal(o.get('ah:home:-0.5').best.price, 2.15);
  assert.ok(o.get('ah:home:-0.25'));
  const m = F.market1x2(o);
  close(m[0] + m[1] + m[2], 1);
});

test('mercados del partido: filas agrupadas, ordenadas por score, y edge 0-100', () => {
  const o = F.parseOdds(oddsResponse);
  const { rows } = F.matchMarkets({ home: 1.9, away: 0.9 }, o, { home: 'River', away: 'Boca' });
  assert.ok(rows.length >= 10);
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i - 1].score >= rows[i].score);
  assert.equal(rows.find(r => r.key === '1x2:home').group, 'home');
  assert.equal(rows.find(r => r.key === 'btts:no').group, 'low');
  assert.equal(rows.find(r => r.key === 'ah:away:0.5').label, 'Hándicap Boca +0,5');
  const e = F.matchEdge(rows);
  assert.ok(e > 0 && e <= 100);
  assert.equal(F.matchEdge([]), 0);
});

test('RPS: pronóstico perfecto = 0; ECE con probabilidades bien calibradas es chico', () => {
  assert.equal(F.rps([1, 0, 0], 0), 0);
  close(F.rps([0, 0, 1], 0), 1);
  const rows = [];
  for (let i = 0; i < 1000; i++) rows.push({ p1x2: [0.5, 0.25, 0.25], hg: i % 4 < 2 ? 1 : 0, ag: i % 4 === 2 ? 0 : i % 4 === 3 ? 1 : 0 });
  assert.ok(F.ece(rows).ece < 0.01);
});

test('backtest: usa solo partidos anteriores y el modelo le gana al promedio con equipos distintos', () => {
  // Liga sintética: el equipo 1 es muy fuerte, el 6 muy débil.
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const pois = l => { let k = 0, p = Math.exp(-l), s = p; const u = rnd(); while (u > s && k < 15) { k++; p *= l / k; s += p; } return k; };
  const str = { 1: 2.0, 2: 1.4, 3: 1.1, 4: 0.9, 5: 0.7, 6: 0.45 };
  const games = []; let ts = 1.6e9, id = 1;
  for (let r = 0; r < 12; r++) for (let h = 1; h <= 6; h++) for (let a = 1; a <= 6; a++) if (h !== a) {
    const lh = 1.4 * str[h] / str[a] ** 0.7, la = 1.1 * str[a] / str[h] ** 0.7;
    games.push({ id: id++, ts: ts += 86400, h, a, hg: pois(lh), ag: pois(la), season: 2024, leagueId: 1 });
  }
  const rows = F.backtestLeague(games, T);
  assert.ok(rows.length > 200);
  assert.ok(rows.every(r => r.p1x2 && Math.abs(r.p1x2.reduce((a, b) => a + b, 0) - 1) < 1e-9));
  const g = F.goalsSkill(rows);
  assert.ok(g.skill > 0, 'skill en goles ' + g.skill);
  const ms = F.marketSkill(rows.map(r => Object.assign({}, r, { m1x2: [0.45, 0.27, 0.28] })));
  assert.ok(ms.skill > 0, 'le gana a un mercado que no distingue equipos');
});
