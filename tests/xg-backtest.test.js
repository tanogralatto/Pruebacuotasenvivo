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

function sampleMatches(count=70) {
  const teams=[11,22,33,44,55,66];
  return Array.from({length:count},(_,i)=>{
    const home=teams[i%teams.length];
    let away=teams[(i*3+1)%teams.length];
    if(away===home)away=teams[(i+1)%teams.length];
    return {
      fixtureId:i+1,date:new Date(Date.UTC(2025,0,1+i)).toISOString(),
      leagueId:39,season:2025,homeTeamId:home,awayTeamId:away,
      homeHT:i%3===0?1:0,awayHT:i%4===0?1:0
    };
  });
}

test('backtest removes duplicate ids and orders chronologically', () => {
  const ordered=backtest.uniqueChronological([
    {...sampleMatches(2)[1]},
    {...sampleMatches(2)[0]},
    {...sampleMatches(2)[0]}
  ]);
  assert.deepEqual(ordered.map(m=>m.fixtureId),[1,2]);
});

test('prediction ignores future fixtures even if caller includes them in history', () => {
  const matches=sampleMatches(45);
  const target=matches[35];
  const prediction=backtest.buildPrediction(target,matches,{minLeagueMatches:20,minTeamMatches:3});
  assert.ok(prediction);
  assert.equal(prediction.leagueMatches,35);
});

test('rolling backtest reports Brier, Log Loss and same-sample league baseline', () => {
  const result=backtest.runBacktest(sampleMatches(70),{minLeagueMatches:20,minTeamMatches:3});
  assert.ok(result.scored>0);
  assert.equal(result.metrics.poisson.count,result.scored);
  assert.equal(result.metrics.baselineLiga.count,result.scored);
  assert.ok(Number.isFinite(result.metrics.poisson.brierScore));
  assert.ok(Number.isFinite(result.metrics.poisson.logLoss));
  assert.ok(Number.isFinite(result.metrics.baselineLiga.brierScore));
  assert.ok(result.predictions.every(p=>p.probability>0&&p.probability<1&&p.baselineProbability>0&&p.baselineProbability<1));
});

test('ROI is calculated only for records with real decimal odds', () => {
  const metrics=backtest.scorePredictions([
    {probability:.8,outcome:1,odds:1.5},
    {probability:.6,outcome:0,odds:null}
  ]);
  assert.equal(metrics.count,2);
  assert.ok(Math.abs(metrics.brierScore-.20)<1e-10);
  assert.equal(metrics.oddsCount,1);
  assert.equal(metrics.profitUnits,.5);
  assert.equal(metrics.roi,.5);
  const noOdds=backtest.scorePredictions([{probability:.7,outcome:1,odds:null}]);
  assert.equal(noOdds.roi,null);
});

test('invalid HT values and duplicate fixtures are excluded', () => {
  const valid=sampleMatches(35);
  const invalid={...valid[34],fixtureId:999,homeHT:null};
  const result=backtest.runBacktest([...valid,invalid,valid[0]],{minLeagueMatches:20,minTeamMatches:3});
  assert.equal(result.skipped.invalidOrDuplicate,2);
});

test('insufficient history is explicitly skipped', () => {
  const result=backtest.runBacktest(sampleMatches(10));
  assert.equal(result.scored,0);
  assert.equal(result.skipped.insufficientHistory,10);
  assert.equal(result.metrics.poisson.brierScore,null);
});
