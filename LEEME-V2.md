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
