# Lápiz Verde

Repositorio: https://github.com/jesvivlc/lapiz-verde (antes `antescorregIA`).

Corrección de tareas escolares (Primaria y ESO) con IA. El profesor sube las entregas de su clase, recibe una propuesta de nota y feedback por alumno, la revisa, la aprueba y la nota va a su cuaderno.

- Producción: https://lapizverde.com (antes https://antescorregia.vercel.app)
- Plan de producto: [ROADMAP.md](ROADMAP.md)

## Cómo funciona

1. El profesor entra con su correo (enlace mágico de Supabase, sin contraseña). Recibe 20 correcciones gratis.
2. Elige grupo y tarea de su cuaderno (o usa un Excel de alumnos) y recoge los trabajos por cualquiera de estos canales:
   - **ZIP** de Teams o de Aules/Moodle, tal cual se descarga.
   - **Enlace de entrega** de la tarea: el alumno elige su nombre y sube fotos o PDF desde el móvil (`entregar.html`).
   - **Escaneo de libretas** con **pegatinas QR** por alumno (se imprimen desde el Cuaderno; se leen en el navegador).
   - **Buzón de correo** del grupo: el alumno envía el trabajo como adjunto.

   Y escribe o genera la rúbrica. Lo que llega por enlace o correo puede corregirse solo por la noche (Batch API, mitad de coste).
3. Cada entrega se corrige con Claude (`claude-sonnet-5`) en **modo anónimo**: la IA no recibe el nombre del alumno. Cuesta 1 corrección; si falla, se devuelve.
4. El profesor revisa, edita nota y comentario, y aprueba. Lo aprobado se guarda en `notas` con `origen='markmate'`.
5. Puede enviar el feedback por correo (firmado con su nombre, respuesta a su correo) o copiarlo.
6. Desde el cuaderno, «📤 Pasar notas» lleva las notas (y los comentarios) a su plataforma sin conectarse a ella:
   - **Moodle** (Aules y las autonómicas): rellena la hoja de calificaciones que el profe descarga de la tarea, para volver a subirla.
   - **Extensión de Chrome** (`extension/`): rellena la página de calificaciones abierta (Classroom, ITACA, Séneca…); el profe revisa y guarda.
   - **Copiar y pegar** en columnas.
7. Cuando se queda sin correcciones, compra un bono con Stripe.

## Estructura

```
index.html                 app completa (entrada + corrector + cuaderno). En la raíz: no mover
privacidad.html            política de privacidad y aviso legal (borrador con huecos)
api/
  corregir.js              POST: corrige el trabajo de un alumno (una o varias páginas). Exige sesión, cobra 1 crédito
  corregir-entregas.js     POST: corrige lo que un alumno entregó por enlace o correo
  entrega.js               GET/POST públicos con token: página de entrega del alumno, subida firmada al almacén
  correo-entrante.js       webhook de Resend (email.received): adjuntos del buzón del grupo → entregas
  cron-nocturno.js         Vercel Cron: enviar (lote a la Batch API) y recoger (resultados + limpieza)
  rubrica.js               POST: propone una rúbrica a partir de una descripción
  checkout.js              POST: crea la sesión de pago de Stripe
  stripe-webhook.js        Stripe avisa del pago → suma créditos (idempotente)
  enviar-feedback.js       POST: envía el feedback por correo con Resend
entregar.html              página del alumno para entregar (sin cuenta)
pasar-notas.js             hoja de calificaciones de Moodle y copiar/pegar (navegador; se prueba en Node)
extension/                 extensión de Chrome «Pasar notas» (manifest v3, sin permisos de host)
lib/servidor.js            utilidades del servidor (Supabase service_role, sesión, errores)
lib/correccion.js          corrección con IA común a todos los canales
lib/entregas.js            leer del almacén lo entregado y guardar la propuesta
supabase/migrations/       SQL a ejecutar en el panel de Supabase, en orden
supabase/tests/            test de las migraciones y del aislamiento entre usuarios
tests/                     tests de la API (red simulada) y de extremo a extremo (navegador)
```

## Variables de entorno (Vercel)

Ver [.env.example](.env.example): `ANTHROPIC_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `RESEND_API_KEY`, `FROM_EMAIL`, y opcionales `RESEND_WEBHOOK_SECRET` + `DOMINIO_ENTREGAS` (buzón) y `CRON_SECRET` (corrección nocturna).

## Tests

```bash
npm install
npm test                   # API con red simulada + hoja de Moodle + migraciones y RLS en PGlite
npm i --no-save playwright@1.63.0 jszip && npx playwright install chromium
node tests/e2e.mjs         # frontend en Chromium con Supabase y API simulados
```

## API `/api/corregir`

Requiere `Authorization: Bearer <access_token de Supabase>`.

```json
{
  "nombre_alumno": "María García",
  "curso": "3ESO",
  "nombre_tarea": "Comentario de texto tema 3",
  "rubrica": "- Comprensión (3 pts): ...",
  "archivo_base64": "...",
  "tipo_archivo": "pdf"
}
```

- `curso`: `1PRI`…`6PRI`, `1ESO`…`4ESO`
- En lugar de `archivo_base64` + `tipo_archivo` (`pdf`, `jpeg`, `jpg`, `png`, `gif`, `webp`) se puede mandar `texto_tarea`.

Respuesta: `nota`, `nota_texto`, `comentario`, `propuestas_mejora` (3), `mensaje_motivador`, `legible`, `creditos_restantes`.
Errores: `401` sin sesión, `402` sin créditos (`codigo: "SIN_CREDITOS"`), `400` datos o archivo no válidos.
