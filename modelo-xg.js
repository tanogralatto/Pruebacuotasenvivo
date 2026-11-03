/**
 * TANOapp — lectura conservadora de xG explícito de API-Football (/fixtures/statistics).
 *
 * No convierte tiros/posesión/goles en xG. Solo acepta un campo etiquetado como xG
 * por la fuente. El xG de /fixtures/statistics es del PARTIDO COMPLETO; el modelo lo
 * traslada al primer tiempo con la proporción de goles del 1T de cada liga, y solo se usa
 * si el backtest demuestra que mejora el Brier (ver la pestaña de validación de la app).
 *
 * Funciona en navegador (window.TanoXg) y en Node (module.exports).
 */
(function (root) {
  'use strict';

  function numeric(value) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)) && Number(value) >= 0) return Number(value);
    return null;
  }

  // Acepta "expected_goals" (nombre habitual en API-Football) además de las etiquetas legibles.
  function labelIsXg(label) {
    return /^(xg|expected[ _]goals?|goles esperados)$/i.test(String(label || '').trim());
  }

  function extractExplicitXg(statistics) {
    if (!Array.isArray(statistics)) return { available: false, value: null, scope: null, reason: 'No hay estadísticas disponibles.' };
    for (const teamBlock of statistics) {
      const values = Array.isArray(teamBlock && teamBlock.statistics) ? teamBlock.statistics : [];
      for (const stat of values) {
        if (!labelIsXg(stat && stat.type)) continue;
        const value = numeric(stat.value);
        if (value !== null) return { available: true, value, scope: 'unspecified', reason: null };
      }
    }
    return { available: false, value: null, scope: null, reason: 'La fuente no entregó un campo xG explícito; no se infiere desde tiros ni goles.' };
  }

  function extractFirstHalfXg(firstHalfStatistics) {
    const result = extractExplicitXg(firstHalfStatistics);
    if (!result.available) return result;
    return Object.assign({}, result, { scope: 'first_half' });
  }

  // Devuelve el xG de cada equipo del partido completo, asignado por id de equipo.
  function extractMatchXg(response, homeId, awayId) {
    if (!Array.isArray(response) || response.length < 2) {
      return { available: false, home: null, away: null, reason: 'La respuesta no trae estadísticas de ambos equipos.' };
    }
    let home = null, away = null;
    for (const block of response) {
      const id = block && block.team && block.team.id;
      const one = extractExplicitXg([block]);
      if (!one.available) continue;
      if (String(id) === String(homeId)) home = one.value;
      else if (String(id) === String(awayId)) away = one.value;
    }
    if (home === null || away === null) {
      return { available: false, home, away, reason: 'La fuente no entregó xG para ambos equipos de este partido.' };
    }
    return { available: true, home, away, scope: 'full_match', reason: null };
  }

  const api = { extractExplicitXg, extractFirstHalfXg, extractMatchXg, labelIsXg };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.TanoXg = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
