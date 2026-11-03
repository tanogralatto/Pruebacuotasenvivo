# Auditoría Poisson, xG y backtest

## xG
`modelo-xg.js` solo lee valores etiquetados explícitamente como `xG`, `Expected Goals` o `Goles esperados`. No transforma tiros, posesión ni goles en xG. `extractExplicitXg` deja el período como no especificado; `extractFirstHalfXg` debe usarse únicamente si el objeto de origen corresponde inequívocamente a estadísticas del primer tiempo. No se añadieron llamadas API nuevas. La documentación de API-Football enumera tiros, posesión y pases en `fixtures/statistics`, pero no xG como estadística estándar: https://www.api-football.com/documentation_v3

## Backtest
`backtest-poisson.js` recibe un array histórico ya descargado o exportado; no consulta APIs. Campos requeridos por partido:
- `fixtureId`, `date` (ISO parseable), `leagueId`, `season`
- `homeTeamId`, `awayTeamId`
- `homeHT`, `awayHT` (goles al descanso, validados)
- `oddsOver05HT` opcional: cuota decimal histórica real de Over 0.5 1T, capturada antes del inicio.

Ejemplo de ejecución con Node:
`node --test tests/xg-backtest.test.js tests/modelo-poisson.test.js`

El backtest es rolling-origin: cada partido se predice únicamente con partidos anteriores de la misma liga y temporada. Requiere por defecto 20 partidos previos de liga y 5 por equipo. Calcula Brier score, tasa de acierto, calibración por bandas y ROI solo en partidos con cuota histórica real. Sin cuotas prepartido no calcula ROI. No usa cuotas actuales para simular apuestas pasadas.

## Límites
Los resultados no serán válidos si el historial no tiene puntuación al descanso verificada, IDs consistentes o cuotas prepartido reales. No se deben cargar estadísticas finales como si fueran del descanso. El backtest necesita datos históricos completos: el módulo no inventa ni descarga esos datos. Una vez exportado un dataset de fixtures, se puede llamar a `runBacktest(matches)`.
