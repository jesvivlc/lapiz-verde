# Lápiz Verde — Contexto del proyecto

## Qué es
App web para corrección automática de tareas de alumnos de Primaria y ESO con IA (Claude API).
Empezó como herramienta personal de un profesor; se está convirtiendo en producto de pago para profesores (bonos de correcciones). Plan completo en ROADMAP.md.

## Estructura
lapiz-verde/
├── index.html            ← frontend completo (en la raíz, NO mover)
├── entregar.html         ← página pública del alumno (enlace de entrega, sin cuenta)
├── privacidad.html       ← privacidad y aviso legal (borrador con [HUECOS])
├── pasar-notas.js        ← hoja de calificaciones de Moodle y copiar/pegar (lo usa index.html; se prueba en Node)
├── extension/            ← extensión de Chrome «Pasar notas» (la app la descarga como ZIP)
├── api/                  ← funciones de Vercel: corregir, corregir-entregas, entrega (pública), correo-entrante,
│                           cron-nocturno, rubrica, checkout, stripe-webhook, enviar-feedback
├── lib/                  ← servidor.js (Supabase, sesión, errores), correccion.js (IA), entregas.js (almacén)
├── supabase/migrations/  ← SQL que se ejecuta a mano en el panel de Supabase, en orden
├── supabase/tests/       ← test de migraciones y RLS (PGlite)
├── tests/                ← tests de API (red simulada) y e2e (Playwright)
├── ROADMAP.md
├── vercel.json
└── CLAUDE.md

## Stack
- Frontend: HTML/JS vanilla, una sola página
- Librerías: JSZip, SheetJS, Supabase JS v2 (todas vía CDN)
- Backend: Vercel serverless (api/*.js), módulos ES
- IA: `claude-sonnet-5` (elegido por coste; ver ROADMAP)
- Base de datos y login: Supabase (Auth con enlace mágico, RLS activada)
- Pagos: Stripe Checkout (bonos 100 / 500). Correo: Resend desde el servidor
- Deploy: Vercel (proyecto `lapiz-verde`) → https://lapizverde.com (dominio comprado el 7/10/2026; DNS en el registrador)

## Supabase — tablas
- `grupos` (id, owner_id, nombre, nivel, anio_academico, created_at)
- `alumnos` (id, grupo_id, owner_id, nombre, apellidos, email, activo, created_at)
- `tareas` (id, grupo_id, owner_id, titulo, descripcion, rubrica, evaluacion, fecha_entrega, peso_nota, created_at)
- `notas` (id, alumno_id, tarea_id, owner_id, nota, faltas, comentario_ia, mejoras_ia, mensaje_motivador, comentario_profesor, origen, corregido_at, created_at)
- `perfiles` (id = auth.users.id, email, nombre, creditos) — se crea sola al registrarse
- `pagos` (user_id, stripe_session_id único, creditos, importe_cents)
- `uso_ia` (user_id, tipo, modelo, tokens…) — coste real por corrección
- `entregas` (owner_id, tarea_id, alumno_id o null, canal 'enlace'|'correo', ruta en el almacén, estado, resultado de la IA…) — lo recibido; solo la crea el servidor
- `lotes_ia` — lotes de la corrección nocturna (solo servidor)
- `tareas` añade token_entrega, entrega_abierta, correccion_auto · `grupos` añade buzon
- Almacén (Storage) privado `entregas`: `<owner_id>/<tarea_id>/<entrega_id>.<ext>`; se borra al aprobar o a los 60 días
- Vistas: `v_media_alumno_evaluacion`, `v_resumen_grupo` (con security_invoker)
- UNIQUE en notas: (alumno_id, tarea_id)
- Campo origen: 'manual' | 'markmate' ('markmate' = corrección de la IA aprobada por el profesor)
- `owner_id` tiene default `auth.uid()`: el frontend no lo rellena
- Funciones de créditos (`consumir_credito`, `devolver_credito`, `acreditar_pago`): solo service_role

## Reglas importantes
- El index.html está en la raíz del repo — NO moverlo nunca
- No tocar el vercel.json sin avisar
- No subir node_modules ni .env a git
- La URL y la clave anónima de Supabase van en el JS del index.html (es pública por diseño; la seguridad la da la RLS). La clave service_role solo en variables de Vercel
- Cualquier cambio de esquema: nueva migración numerada en supabase/migrations/, idempotente, y ampliar supabase/tests/rls.test.mjs
- Pasar `npm test` antes de hacer commit
- El profe usa la app sin decirlo en su centro: ninguna integración que pida permiso al centro o deje rastro en su plataforma (ver ROADMAP, «Regla de integraciones»). La IA nunca recibe el nombre del alumno
- Siempre hacer git add + commit + push al terminar. Push a `main` publica en producción: para cambios grandes, trabajar en rama y que Bruno fusione

## Próximos pasos
Ver ROADMAP.md. En curso: activar la fase 1 (rama `fase-1`, instrucciones en MANANA.md).
