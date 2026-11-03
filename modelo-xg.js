/**
 * TANOapp — lectura conservadora de xG explícito.
 * No convierte tiros/posesión/goles en xG y no asume que xG de partido completo
 * equivale a xG de primer tiempo. API-Football no documenta xG entre sus
 * estadísticas estándar de fixtures; esta capa solo acepta un campo explícito
 * de una fuente que realmente lo proporcione.
 */
'use strict';

function numeric(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)) && Number(value) >= 0) return Number(value);
  return null;
}

function labelIsXg(label) {
  return /^(xg|expected goals|expected goal|goles esperados)$/i.test(String(label || '').trim());
}

function extractExplicitXg(statistics) {
  if (!Array.isArray(statistics)) return {available:false,value:null,scope:null,reason:'No hay estadísticas disponibles.'};
  for (const teamBlock of statistics) {
    const values = Array.isArray(teamBlock && teamBlock.statistics) ? teamBlock.statistics : [];
    for (const stat of values) {
      if (!labelIsXg(stat && stat.type)) continue;
      const value = numeric(stat.value);
      if (value !== null) return {available:true,value,scope:'unspecified',reason:null};
    }
  }
  return {available:false,value:null,scope:null,reason:'La fuente no entregó un campo xG explícito; no se infiere desde tiros ni goles.'};
}

function extractFirstHalfXg(firstHalfStatistics) {
  const result = extractExplicitXg(firstHalfStatistics);
  if (!result.available) return result;
  return {...result,scope:'first_half'};
}

module.exports = {extractExplicitXg, extractFirstHalfXg};
