# Auditoría Poisson, xG y backtest

## xG
`modelo-xg.js` solo lee valores etiquetados explícitamente como `xG`, `Expected Goals` o `Goles esperados`. No transforma tiros, posesión ni goles en xG. No se añadieron llamadas API nuevas. La documentación de API-Football enumera tiros, posesión y pases en `fixtures/statistics`, pero no xG como estadística estándar: https://www.api-football.com/documentation_v3

## Backtest Poisson 1T

### Ejecución desde TANOapp
En la pestaña Escáner aparece el panel **Validación histórica · Poisson 1T**. El botón **Ejecutar backtesting con datos guardados** lee únicamente las entradas vigentes de la caché local del navegador (`o05:v2:league:`), que se generan al analizar partidos. No hace llamadas a API-Football ni descarga datos nuevos. Si no hay historial guardado, primero hay que analizar partidos de las ligas que se quieran evaluar.

El backtest procesa fixtures con HT explícito y validado por la API. Los registros heredados sin trazabilidad de HT, HT inferidos desde el 0-0 final, marcadores inválidos y duplicados se excluyen.

### Método
- Rolling-origin cronológico: cada partido evaluado usa solo fixtures anteriores a su fecha/hora; partidos con el mismo timestamp no se usan entre sí.
- Se exige por defecto un mínimo de 20 partidos previos de liga/temporada y 5 apariciones previas de cada equipo.
- Se reutiliza exactamente `modelo-poisson.js`; no se retocan sus parámetros.
- Se compara contra un baseline Poisson de liga: probabilidad calculada con la suma de los promedios de goles HT local y visitante, sin ajustes de fuerza por equipo.
- Se informan Brier Score y Log Loss (menor es mejor), probabilidad media, frecuencia observada y calibración por bandas 0–50%, 50–60%, 60–70%, 70–80%, 80–90% y 90–100%.
- ROI solo se calcula si cada registro evaluado tiene una cuota decimal histórica real en `oddsOver05HT`. La caché de fixtures de la app no guarda esas cuotas históricas, por lo que el ROI normalmente aparecerá como no disponible. Nunca se usan cuotas actuales como sustituto.

### Ejecutar pruebas con Node
`node --test tests/xg-backtest.test.js tests/modelo-poisson.test.js`

Las pruebas cubren orden cronológico, duplicados, exclusión de información futura, métricas, baseline, ROI solo con cuotas reales y muestras insuficientes.

### Límites importantes
- La app carga hasta 99 partidos recientes por liga/temporada y guarda la caché local durante 12 horas. El resultado representa solo ese conjunto disponible, no un archivo histórico completo.
- El backtest puede devolver pocas predicciones o ninguna si no hay suficientes partidos anteriores y HT explícitos validados.
- Las métricas de una muestra pequeña son exploratorias. No demuestran rentabilidad ni calibración estable.
- No se han incorporado cuotas históricas ni se estima ROI sin ellas.
- El backtest no modifica el Escáner, Favoritos, Telegram ni el cálculo Poisson de producción.
