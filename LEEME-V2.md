# TANOapp v2 — Poisson + xG validado

## Cómo subirlo (desde el iPhone)
1. En GitHub (Safari) abrí tu repo Pruebacuotasenvivo → Add file → Upload files.
2. Subí estos 5 archivos en la raíz: `index-v2.html`, `modelo-poisson.js`, `modelo-xg.js`, `backtest-poisson.js`, `validacion-v2.js`. (Reemplazan los 3 .js viejos; tu `index.html` actual NO se toca y sigue funcionando.)
3. Opcional: la carpeta `tests` con los 3 archivos de prueba.
4. Esperá 1-2 minutos y abrí https://tanogralatto.github.io/Pruebacuotasenvivo/index-v2.html
5. Cuando estés conforme, renombrá `index-v2.html` a `index.html`.

## Orden de uso
1. Escáner → Buscar partidos → marcá las ligas → Analizar. Cada predicción con cuota queda guardada ANTES del partido.
2. Sección 5 (Validación): tocá «Probar xG». Si la API trae xG, tocá «Bajar xG» (usa hasta 200 consultas; de las 7500 diarias es poco).
3. «Validar con las ligas marcadas»: backtest cronológico, elige parámetros, prueba xG y calibra. Dice si el modelo pasó o no.
4. Al día siguiente: «Liquidar registro» baja los resultados y mide Brier, calibración y ROI reales.
5. En Vivo: con el partido en el 1T y las cuotas consultadas, aparece la probabilidad y el EV de Over 0,5 / 1,0.

## Lectura de las señales
- «EV vs mercado (sin margen)» compara la cuota contra el precio justo de Pinnacle (o la mediana de casas). Es la señal más fiable.
- «EV+ sólido / posible» sale solo del modelo. Es provisorio hasta que el modelo pase la validación.
- Over 0,5 1T ocurre ~70% de las veces: hay poco margen para que un modelo le gane al mercado. Con cientos de apuestas registradas se sabe si hay ventaja; con pocas decenas, el ROI es ruido.

## Verificado
26 tests automáticos pasan, y se simuló la app completa con una API falsa (escáner, registro, xG, validación, liquidación, en vivo) sin errores de JavaScript.

## Stake sugerido (Kelly) y desglose del registro
- En la sección 5 cargá «Tu banca para apostar». Cada partido muestra «Stake sugerido (Kelly)»: % de la banca y monto en pesos.
- Cómo se calcula: Kelly completo = (p·(cuota−1) − (1−p)) / (cuota−1). En ligas aprobadas p = promedio entre el modelo y el mercado sin margen, y se apuesta ¼ de eso. En ligas sin aprobar p = solo el mercado sin margen (sin mercado no se apuesta), y se apuesta ⅛. Tope: 3% de la banca.
- El registro ahora muestra: Brier del modelo contra el del mercado sin margen (sobre las mismas predicciones), ROI por rango de EV, por EV vs mercado y por liga, y una simulación de la banca con ¼ Kelly contra stake plano del 1%.

## Validación más estricta (pestaña Validación)
- La validación ahora tiene su propia pestaña. Las ligas se siguen marcando en el Escáner (sección 2).
- Cada partido se juzga con parámetros y calibración elegidos solo con partidos anteriores (antes se elegían con todos, lo que inflaba un poco la «Mejora»).
- Nueva columna «Confianza»: si la mejora puede explicarse por suerte según la cantidad de partidos. Para aprobar hace falta confianza alta (mejora ≥ 1,64 errores estándar).
- Las ligas validadas antes muestran «¿?» hasta que se vuelvan a validar.

## Hándicap asiático (etapa 1, en prueba)
- `asiaticos.js` (puro, con tests en `tests/asiaticos.test.js`): distribución de la diferencia de goles con los goles esperados del partido completo, probabilidades por línea (ganar, ganar la mitad, devolver, perder la mitad, perder), lectura de las cuotas «Asian Handicap» de API-Football (detecta los dos formatos de línea del visitante) y precio sin margen por línea (Pinnacle o mediana).
- Cada tarjeta muestra la línea principal (la de cuotas más parejas), EV contra el mercado, stake (solo precio de las casas, ⅛ Kelly) y la escalera de líneas.
- Etapa 2 (hecha): al analizar se guarda la línea principal del lado con mejor precio; «Liquidar registro» la resuelve con el marcador de 90 minutos (ganada, media ganada, devuelta, media perdida, perdida) y el ROI usa esa ganancia real.
- Pendiente: etapa 3 (validación por liga). Al hacerla, corregir la tasa base de `scoreRows`, que arranca en 70% (pensada para +0,5 1T) y en los primeros partidos favorece un poco a Ambos marcan, +2,5 y hándicap.
