'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const F = require('../modelo-ft.js');
const T = require('../modelo-poisson.js');
const FD = require('../data/fd-1x2.json');
const close = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) < tol, `${a} ≠ ${b}`);

test('invert1x2: los goles esperados reproducen el 1X2 (también con margen y con favorito visitante)', () => {
  for (const p of [[0.5, 0.27, 0.23], [0.2, 0.25, 0.55], [0.8, 0.13, 0.07], [0.36, 0.3, 0.34]]) {
    const r = F.invert1x2(p, -0.06), s = F.summarize(F.scoreMatrix(r.lh, r.la, -0.06));
    close(s.home, p[0]); close(s.draw, p[1]); close(s.away, p[2]);
  }
  const withMargin = F.invert1x2([0.53, 0.29, 0.24]), s = F.summarize(F.scoreMatrix(withMargin.lh, withMargin.la, -0.06));
  close(s.home, 0.53 / 1.06);
  assert.equal(F.invert1x2([0.5, 0.5]), null);
  assert.equal(F.invert1x2(null), null);
});

test('marketGames y marketCoverage: solo los partidos con cuota llevan goles esperados', () => {
  const games = [{ id: 1, ts: 100 * 86400, hg: 2, ag: 0 }, { id: 2, ts: 101 * 86400, hg: 1, ag: 1 }];
  const mkt = new Map([['1', [0.5, 0.27, 0.23]]]);
  const mg = F.marketGames(games, mkt, -0.06, new Map());
  assert.equal(mg.marketCount, 1);
  assert.ok(mg[0].xh > mg[0].xa && mg[0].market);
  assert.equal(mg[1].xh, null);
  assert.equal(mg[0].hg, 2); // los goles reales no se tocan
  close(F.marketCoverage(games, mkt).share, 0.5);
  assert.equal(F.marketCoverage(games, mkt, 101 * 86400).share, 1); // antes del 2.º partido
});

test('con datos reales: el modelo de mercado queda más cerca de Pinnacle que el de goles', () => {
  const season = d => { const t = new Date(d * 864e5); return t.getUTCMonth() >= 6 ? t.getUTCFullYear() : t.getUTCFullYear() - 1; };
  let dGoals = 0, dMarket = 0, n = 0;
  for (const lid of ['39', '140']) {
    const fd = FD.leagues[lid];
    if (!fd || fd.length < 200) continue;
    const games = fd.map((r, i) => ({ id: lid + ':' + i, ts: r[0] * 86400, season: season(r[0]), hg: r[1], ag: r[2], h: r[6], a: r[7] }));
    const mkt = new Map(fd.map((r, i) => [lid + ':' + i, [r[3], r[4], r[5]].map(x => x / 1000)]));
    const goals = F.withProbs(F.backtestLeague(games, T, { priorMatches: F.FT_PRIOR.shape, totalPriorMatches: F.FT_PRIOR.total }), -0.06);
    const M = F.MARKET_FIT;
    const market = F.withProbs(F.backtestLeague(F.marketGames(games, mkt, -0.06, new Map()), T,
      { xgWeight: M.weight, halfLifeDays: M.halfLifeDays, priorMatches: M.priorMatches, minTeamEffective: M.minTeamEffective }), -0.06);
    const byId = new Map(market.map(r => [r.id, r]));
    for (const g of goals) {
      const m = byId.get(g.id); if (!m) continue;
      const p = mkt.get(g.id), s = p[0] + p[1] + p[2];
      dGoals += Math.abs(g.p1x2[0] - p[0] / s); dMarket += Math.abs(m.p1x2[0] - p[0] / s); n++;
    }
  }
  if (!n) return; // sin datos en el repo no hay nada que medir
  assert.ok(n > 300, 'pocos partidos: ' + n);
  assert.ok(dMarket / n < 0.8 * dGoals / n, `mercado ${(dMarket / n).toFixed(4)} vs goles ${(dGoals / n).toFixed(4)}`);
});

test('goles de cada equipo: se leen, se resuelven y su precio justo sale del 1X2 y el total de Pinnacle', () => {
  const lh = 1.7, la = 0.9, m = F.scoreMatrix(lh, la, -0.06), s = F.summarize(m);
  const o25 = F.betProbs({ type: 'total', side: 'over', line: 2.5 }, m).p;
  const odd = (p, mg) => (1 / (p * mg)).toFixed(3);
  const book = (name, mg, extra) => ({ name, bets: [
    { id: 1, name: 'Match Winner', values: [{ value: 'Home', odd: odd(s.home, mg) }, { value: 'Draw', odd: odd(s.draw, mg) }, { value: 'Away', odd: odd(s.away, mg) }] },
    { id: 5, name: 'Goals Over/Under', values: [{ value: 'Over 2.5', odd: odd(o25, mg) }, { value: 'Under 2.5', odd: odd(1 - o25, mg) }] }].concat(extra || []) });
  // La casa blanda paga de más «visitante más de 0,5» (le da 55% cuando lo justo es ~59%).
  const pAway05 = 1 - Math.exp(-la);
  const soft = { id: 17, name: 'Total - Away', values: [{ value: 'Over 0.5', odd: odd(0.55, 1.06) }, { value: 'Under 0.5', odd: odd(0.45, 1.06) }] };
  const odds = F.parseOdds([{ fixture: { id: 1 }, bookmakers: [book('Pinnacle', 1.025), book('Bet365', 1.06, [soft])] }]);
  close(odds.lambdas.lh, lh, 0.02); close(odds.lambdas.la, la, 0.02);
  const x = odds.get('tt:away:over:0.5');
  assert.ok(x && x.derived && x.sharp);
  close(x.mkt, F.betProbs({ type: 'tt', team: 'away', side: 'over', line: 0.5 }, F.scoreMatrix(odds.lambdas.lh, odds.lambdas.la, -0.06)).p);
  close(x.mkt, pAway05, 0.03);
  assert.ok(x.offers.length && x.offers[0][0] === 'Bet365'); // paga más que lo justo
  assert.equal(F.groupOf(x.bet), 'team');
  assert.equal(F.betLabel(x.bet, 'Boca', 'River'), 'Goles River: más de 0,5');
  assert.equal(F.betResult({ type: 'tt', team: 'away', side: 'over', line: 0.5 }, 3, 1), 1);
  assert.equal(F.betResult({ type: 'tt', team: 'home', side: 'under', line: 1.5 }, 2, 0), -1);
  assert.equal(F.betResult({ type: 'tt', team: 'home', side: 'over', line: 1 }, 1, 0), 0); // devuelve
  // Sin Pinnacle no hay derivación: queda el precio de la mediana de las casas.
  const noPin = F.parseOdds([{ fixture: { id: 1 }, bookmakers: [book('Bet365', 1.06, [soft])] }]);
  assert.ok(!noPin.lambdas && !noPin.get('tt:away:over:0.5').derived);
});
