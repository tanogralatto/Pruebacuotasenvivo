// Ambos marcan y +2,5 goles: probabilidades, backtest con goles finales y liquidación.
const assert = require('assert');
const T = require('../modelo-poisson.js');
const V = require('../validacion-v2.js');

// Fórmulas básicas.
const pr = { ok: true, lambdaHome: 1.5, lambdaAway: 1.1, lambdaTotal: 2.6, seLambda: 0.2, seHome: 0.15, seAway: 0.12, pOver05: 0.9, pLow: 0.88, pHigh: 0.92 };
const b = T.marketProbs(pr, 'btts');
assert(Math.abs(b.p - (1 - Math.exp(-1.5)) * (1 - Math.exp(-1.1))) < 1e-12);
assert(b.pLow < b.p && b.p < b.pHigh);
const o = T.marketProbs(pr, 'over25');
assert(Math.abs(o.p - (1 - Math.exp(-2.6) * (1 + 2.6 + 2.6 * 2.6 / 2))) < 1e-12);
assert(o.pLow < o.p && o.p < o.pHigh);
assert.equal(T.marketProbs(pr, 'ht05').p, 0.9);

// Resultado real.
assert.equal(T.marketOutcome({ fth: 1, fta: 1 }, 'btts'), 1);
assert.equal(T.marketOutcome({ fth: 3, fta: 0 }, 'btts'), 0);
assert.equal(T.marketOutcome({ fth: 2, fta: 1 }, 'over25'), 1);
assert.equal(T.marketOutcome({ fth: 2, fta: 0 }, 'over25'), 0);
assert.equal(T.marketOutcome({ fth: null, fta: 1 }, 'over25'), null);

// Liga simulada con Poisson real: el backtest debe salir calibrado y mejor que la tasa base.
let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const pois = l => { let k = 0, p = Math.exp(-l), s = p; const u = rnd(); while (u > s) { k++; p *= l / k; s += p; } return k; };
const teams = Array.from({ length: 20 }, (_, i) => ({ id: i + 1, att: 0.6 + 0.8 * rnd(), def: 0.6 + 0.8 * rnd() }));
const games = []; let id = 1; const t0 = 1.6e9;
for (let season = 0; season < 2; season++) for (let r = 0; r < 2; r++) for (let i = 0; i < 20; i++) for (let j = 0; j < 20; j++) {
  if (i === j) continue;
  const ts = t0 + season * 365 * 86400 + (r * 190 + ((i * 7 + j * 3) % 180)) * 86400;
  const lh = 1.45 * teams[i].att * teams[j].def, la = 1.15 * teams[j].att * teams[i].def;
  const fth = pois(lh), fta = pois(la);
  games.push({ id: id++, ts, h: teams[i].id, a: teams[j].id, hg: Math.min(fth, pois(0.45 * lh)), ag: Math.min(fta, pois(0.45 * la)), fth, fta, season: 2020 + season, leagueId: 1 });
}
const ft = T.ftGames(games);
assert.equal(ft.length, games.length);
assert.equal(ft[0].hg, games[0].fth);
for (const market of ['btts', 'over25']) {
  const bt = T.rollingBacktest(ft, { market, halfLifeDays: 240, priorMatches: 14 });
  const m = bt.metrics;
  assert(m.count > 800, market + ' pocas filas: ' + m.count);
  assert(m.skill > 0.01, market + ' sin mejora: ' + m.skill);
  assert(Math.abs(m.meanP - m.observed) < 0.04, market + ' descalibrado: ' + m.meanP + ' vs ' + m.observed);
  const per = V.leagueVerdicts(bt.rows, T);
  assert.equal(per['1'].status, 'aprobada', market + ': ' + JSON.stringify(per['1']));
}
// Con market por defecto sigue siendo +0,5 1T con goles al descanso.
const ht = T.rollingBacktest(games, {});
assert(ht.rows.every(r => r.y === 0 || r.y === 1));

// Liquidación de mercados de 90 minutos.
const fx = (st, ht, ft) => ({ fixture: { status: { short: st } }, score: { halftime: ht || {}, fulltime: ft || {} } });
assert.deepEqual(V.settleFromFixture(fx('FT', { home: 0, away: 0 }, { home: 1, away: 1 }), 'btts'), { status: 'settled', y: 1, ft: [1, 1], source: 'api' });
assert.equal(V.settleFromFixture(fx('FT', {}, { home: 2, away: 0 }), 'btts').y, 0);
assert.equal(V.settleFromFixture(fx('AET', {}, { home: 1, away: 1 }), 'over25').y, 0); // el alargue no cuenta
assert.equal(V.settleFromFixture(fx('FT', {}, { home: 2, away: 1 }), 'over25').y, 1);
assert.equal(V.settleFromFixture(fx('FT', {}, {}), 'over25').status, 'unverified');
assert.equal(V.settleFromFixture(fx('PST'), 'btts').status, 'void');
// +0,5 1T no cambia.
assert.equal(V.settleFromFixture(fx('FT', { home: 1, away: 0 }, { home: 1, away: 0 })).y, 1);
console.log('mercados-ft: ok');
