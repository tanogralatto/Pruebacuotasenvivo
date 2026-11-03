'use strict';
const assert = require('node:assert/strict');
const {test} = require('node:test');
const xg = require('../modelo-xg.js');
const backtest = require('../backtest-poisson.js');

test('xG parser accepts only explicitly labelled nonnegative xG', () => {
  assert.equal(xg.extractExplicitXg([{statistics:[{type:'Total Shots',value:12}]}]).available,false);
  assert.equal(xg.extractExplicitXg([{statistics:[{type:'expected_goals',value:1.2}]}]).available,false);
  assert.equal(xg.extractExplicitXg([{statistics:[{type:'Expected Goals',value:'1.2'}]}]).value,1.2);
});
test('first-half xG is only labelled first-half when supplied in first-half dataset', () => {
  assert.equal(xg.extractFirstHalfXg([{statistics:[{type:'xG',value:0.8}]}]).scope,'first_half');
});
test('backtest removes duplicate fixture ids and orders chronologically', () => {
  const ordered=backtest.uniqueChronological([
    {fixtureId:2,date:'2026-01-02',leagueId:1,season:2026,homeTeamId:1,awayTeamId:2,homeHT:0,awayHT:0},
    {fixtureId:1,date:'2026-01-01',leagueId:1,season:2026,homeTeamId:1,awayTeamId:2,homeHT:1,awayHT:0},
    {fixtureId:1,date:'2026-01-01',leagueId:1,season:2026,homeTeamId:1,awayTeamId:2,homeHT:1,awayHT:0}
  ]);
  assert.deepEqual(ordered.map(m=>m.fixtureId),[1,2]);
});
test('metrics use Brier score and only calculate ROI where real odds exist', () => {
  const metrics=backtest.scorePredictions([
    {probability:.8,outcome:1,odds:1.5},
    {probability:.6,outcome:0,odds:null}
  ]);
  assert.equal(metrics.count,2);
  assert.ok(Math.abs(metrics.brierScore-.32)<1e-10);
  assert.equal(metrics.oddsCount,1);
  assert.equal(metrics.profitUnits,.5);
  assert.equal(metrics.roi,.5);
});
