'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const model = require('../modelo-poisson.js');

test('rejects missing histories and invalid league baselines', () => {
  assert.equal(model.calculate({}).ok, false);
  assert.equal(model.calculate({homeHistory:[{scoredHT:1,concededHT:0}],awayHistory:[{scoredHT:1,concededHT:0}],leagueHomeGoalsHT:0,leagueAwayGoalsHT:0}).ok, false);
});

test('calculates Over 0.5 HT as 1 - exp(-total lambda)', () => {
  const input = {
    homeHistory: Array.from({length:20}, () => ({scoredHT:1,concededHT:0.5})),
    awayHistory: Array.from({length:20}, () => ({scoredHT:0.5,concededHT:1})),
    leagueHomeGoalsHT: 1,
    leagueAwayGoalsHT: 1,
    priorMatches: 8
  };
  const result = model.calculate(input);
  assert.equal(result.ok, true);
  assert.ok(Math.abs(result.probability - (1 - Math.exp(-result.lambdas.totalHT))) < 0.0001);
  assert.ok(Math.abs(result.fairOdds - 1/result.probability) < 0.001);
});

test('EV uses probability times decimal odds minus one', () => {
  const input = {
    homeHistory: Array.from({length:10}, () => ({scoredHT:1,concededHT:1})),
    awayHistory: Array.from({length:10}, () => ({scoredHT:1,concededHT:1})),
    leagueHomeGoalsHT: 1,
    leagueAwayGoalsHT: 1,
    marketOdds: 1 / (1 - Math.exp(-2))
  };
  const result = model.calculate(input);
  assert.equal(result.ok, true);
  assert.ok(Math.abs(result.ev) < 0.000002);
  assert.ok(Math.abs(result.evPercent) < 0.001);
});

test('ignores invalid negative or non-numeric HT observations', () => {
  const summary = model.summarizeTeam([
    {scoredHT:1,concededHT:0},
    {scoredHT:-1,concededHT:0},
    {scoredHT:'2',concededHT:0}
  ], 1, 8);
  assert.equal(summary.matches, 1);
  assert.equal(summary.scoredHT, 1);
});
