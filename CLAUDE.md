# Notas para Claude

## Modo video (vivos de TikTok)

En `index-v2.html` existe un **modo video** ya configurado. Cuando el usuario diga
"oculta para el modo video", "activá el modo video" o algo parecido, NO hay que
volver a preguntar qué ocultar: solo hay que **encenderlo**. Cuando diga que
terminó el vivo / "volvé todo como estaba", hay que **apagarlo**.

- **Encender:** línea 2 de `index-v2.html` → `<html lang="es" class="demo-mode">`
- **Apagar:** línea 2 de `index-v2.html` → `<html lang="es">`

No tocar el CSS ni el JS del modo video: quedan siempre en el archivo.

Qué oculta el modo video (reglas CSS `html.demo-mode ...` en el `<style>`, comentario "MODO VIDEO"):
- Pestaña y vista **Favoritos VIP** (y botones/textos VIP: `.vip-only`, destinos VIP, etc.)
- Pestaña y vista **Estrategia AEG**
- Pestaña y vista **Configuración Telegram VIP**
- En **Historial Telegram** solo queda la pestaña **⭐ Favoritos** (se ocultan AEG,
  dataGol, AEG prueba y VIP anteriores, y en "Agregar alerta" solo el grupo Favoritos).

Si el usuario pide ocultar algo más en el modo video, agregarlo a esas reglas CSS
y a esta lista.

Después de encender/apagar: commit, push y avisar que hay que pasarlo a `main`
para que se vea en GitHub Pages.
