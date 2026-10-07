# Lápiz Verde

Repositorio: https://github.com/jesvivlc/lapiz-verde (antes `antescorregIA`).

Corrección de tareas escolares (Primaria y ESO) con IA. El profesor sube las entregas de su clase, recibe una propuesta de nota y feedback por alumno, la revisa, la aprueba y la nota va a su cuaderno.

- Producción: https://lapizverde.com (antes https://antescorregia.vercel.app)
- Plan de producto: [ROADMAP.md](ROADMAP.md)

## Cómo funciona

1. El profesor entra con su correo (enlace mágico de Supabase, sin contraseña). Recibe 20 correcciones gratis.
2. Elige grupo y tarea de su cuaderno (o usa un Excel de alumnos), sube el ZIP de entregas de Teams o de Aules/Moodle y escribe o genera la rúbrica.
3. Cada entrega se corrige con Claude (`claude-sonnet-5`). Cuesta 1 corrección; si falla, se devuelve.
4. El profesor revisa, edita nota y comentario, y aprueba. Lo aprobado se guarda en `notas` con `origen='markmate'`.
5. Puede enviar el feedback por correo (firmado con su nombre, respuesta a su correo) o copiarlo.
6. Cuando se queda sin correcciones, compra un bono con Stripe.

## Estructura

```
index.html                 app completa (entrada + corrector + cuaderno). En la raíz: no mover
privacidad.html            política de privacidad y aviso legal (borrador con huecos)
api/
  corregir.js              POST: corrige una entrega. Exige sesión, cobra 1 crédito
  rubrica.js               POST: propone una rúbrica a partir de una descripción
  checkout.js              POST: crea la sesión de pago de Stripe
  stripe-webhook.js        Stripe avisa del pago → suma créditos (idempotente)
  enviar-feedback.js       POST: envía el feedback por correo con Resend
lib/servidor.js            utilidades del servidor (Supabase service_role, sesión, errores)
supabase/migrations/       SQL a ejecutar en el panel de Supabase, en orden
supabase/tests/            test de las migraciones y del aislamiento entre usuarios
tests/                     tests de la API (red simulada) y de extremo a extremo (navegador)
```

## Variables de entorno (Vercel)

Ver [.env.example](.env.example): `ANTHROPIC_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `RESEND_API_KEY`, `FROM_EMAIL`.

## Tests

```bash
npm install
npm test                   # API con red simulada + migraciones y RLS en PGlite
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
