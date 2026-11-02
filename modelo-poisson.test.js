const assert = require('node:assert/strict');
const model = require('./modelo-poisson.js');

const history = Array.from({ length: 20 }, () => ({ scoredHT: 1, concededHT: 1 }));
const result = model.calculate({
  homeHistory: history,
  awayHistory: history,
  leagueHomeGoalsHT: 0.7,
  leagueAwayGoalsHT: 0.5,
  marketOdds: 1.6
});

assert.equal(result.ok, true);
assert.ok(result.probability > 0 && result.probability < 1);
assert.ok(result.fairOdds > 1);
assert.equal(result.marketOdds, 1.6);
assert.equal(result.evPercent, Math.round((result.probability * 1.6 - 1) * 10000) / 100);
assert.equal(model.calculate({ homeHistory: [], awayHistory: history, leagueHomeGoalsHT: 0.7, leagueAwayGoalsHT: 0.5 }).ok, false);
assert.equal(model.calculate({ homeHistory: history, awayHistory: history, leagueHomeGoalsHT: 0, leagueAwayGoalsHT: 0.5 }).ok, false);

console.log('OK: cálculo Poisson HT, cuota justa, EV y validación de datos.');
