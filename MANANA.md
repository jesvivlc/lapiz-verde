# Para Bruno — lo que te toca a ti

Todo el código está en la rama **`fase-1`**. Producción (`main`) sigue intacta y funcionando como ayer.
Tiempo total estimado: **45-60 minutos**, casi todo esperando a que Stripe active la cuenta.

Hazlo **en este orden**. Algunos pasos rompen producción si se hacen antes que otros.

---

## 0. Conectar lapizverde.com (10 min de clics + hasta unas horas de espera)

Hazlo ya, aunque todavía no publiques: el DNS y el certificado tardan en estar listos, y así no hay que esperar luego.
Mientras no fusiones la rama, lapizverde.com mostrará la versión antigua; no pasa nada, nadie conoce aún la dirección.

**En Vercel** → proyecto lapiz-verde → Settings → **Domains**:
1. Add → `lapizverde.com` → elige que sea el dominio principal.
2. Add → `www.lapizverde.com` → que **redirija** a `lapizverde.com`.
3. Vercel te enseñará los registros DNS que necesita. Apúntalos tal cual: suelen ser un registro **A** para `@` y un **CNAME** para `www`, pero usa los valores exactos que te dé.

**En DonDominio** (o donde lo compraras) → lapizverde.com → **Zona DNS**:
1. Borra los registros A y CNAME que vengan por defecto para `@` y `www` (los de "aparcado").
2. Crea los dos que te ha dado Vercel.
3. Vuelve a Vercel: cuando los dos dominios salgan en verde ("Valid Configuration"), ya está.

> Si te lo compraste en otro sitio, el procedimiento es el mismo: buscar la "zona DNS" del dominio.

## 1. Mirar la versión de prueba (5 min)

**https://lapiz-verde-git-fase-1-brunos-projects-94a4248c.vercel.app** (siempre apunta a lo último de la rama).
Está protegida con el login de Vercel: ábrela con la sesión de Vercel iniciada en el navegador. Ahí verás la página de entrada nueva. **Todavía no podrás entrar ni corregir**: faltan los pasos 2-4.

## 2. Supabase: permitir el login (3 min)

Panel de Supabase → **Authentication → URL Configuration**:

- **Site URL**: `https://lapizverde.com`
- **Redirect URLs**, añade:
  - `https://lapizverde.com/**`
  - `https://antescorregia.vercel.app/**` (por si entras por la dirección antigua)
  - `https://antescorregia-*-brunos-projects-94a4248c.vercel.app/**` (versiones de prueba)

Y en **Authentication → Providers → Email**: que esté activado.

> El envío de correos de Supabase por defecto tiene un límite bajo (unos pocos por hora). Para probar vale. Antes de abrir a desconocidos, configura un SMTP propio (Authentication → SMTP Settings; Resend sirve).

## 3. Vercel: variables de entorno (5 min)

Vercel → lapiz-verde → Settings → **Environment Variables**. Añade para Production y Preview:

| Variable | Dónde se saca |
|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API → `service_role` (**la secreta**, no la `anon`) |

Con esa ya funciona corregir. Las de Stripe y Resend van en los pasos 6 y 7.
Después de añadir variables hay que **redesplegar** (Deployments → la de `fase-1` → ⋯ → Redeploy).

## 4. Fusionar y migrar la base de datos (10 min) — ⚠️ el orden importa

La migración activa la seguridad por usuario: a partir de ese momento, **la app antigua sin login deja de ver datos**. Por eso se hace a la vez que se publica la nueva.

1. En GitHub, fusiona `fase-1` en `main` (o `git checkout main && git merge fase-1 && git push`). Espera a que Vercel publique.
2. Supabase → **SQL Editor** → pega `supabase/migrations/001_multiusuario.sql` entero → **Run**.
3. Entra en https://lapizverde.com con tu correo y abre el enlace que te llega.
4. Abre `supabase/migrations/002_asignar_datos_existentes.sql`, cambia `TU_EMAIL_AQUI` (sale dos veces: en el comentario y en la consulta) por tu correo, pégalo en el SQL Editor → **Run**. Esto te asigna tus grupos antiguos y te pone 1.000 correcciones.
5. Recarga la app: deberías ver tus grupos en el Cuaderno.

**Si algo va mal** en el paso 2 o 4, mándame el mensaje de error exacto. Las migraciones se pueden ejecutar dos veces sin romper nada.

> No pude conectarme a tu Supabase desde aquí, así que escribí el SQL a partir del esquema de CLAUDE.md y lo probé contra una réplica (26 pruebas, todas bien). Lo único que puede fallar es alguna diferencia con tu esquema real — por ejemplo, si `mejoras_ia` es de tipo lista en lugar de texto. Si falla, el error lo dirá.

## 5. Prueba real (10 min)

1. Crea un grupo en el Cuaderno (o usa uno tuyo), importa alumnos, crea una tarea.
2. Corrige un ZIP pequeño (3-4 alumnos).
3. **Las 20 fotos de libretas**: esta es la prueba de verdad. Mete fotos malas de libretas en un ZIP, con una carpeta por alumno, y córrelas. Mira qué pasa con la letra infantil. Las que no lea bien deberían salir marcadas con ⚠️ en lugar de inventadas.
4. Aprueba algunas y comprueba que las notas aparecen en el Cuaderno (en verde claro = vienen del corrector).

## 6. Stripe (20 min, más la espera de activación)

1. Crea la cuenta en https://dashboard.stripe.com y rellena los datos de activación (puede tardar un día). En Settings → Public details, pon como descriptor del extracto **LAPIZ VERDE** y como web `https://lapizverde.com`.
2. Mientras tanto, en **modo prueba**: Developers → API keys → copia la `Secret key` (`sk_test_…`) → variable `STRIPE_SECRET_KEY` en Vercel.
3. Developers → **Webhooks** → Add endpoint:
   - URL: `https://lapizverde.com/api/stripe-webhook`
   - Eventos: `checkout.session.completed` y `checkout.session.async_payment_succeeded`
   - Copia el `Signing secret` (`whsec_…`) → variable `STRIPE_WEBHOOK_SECRET` en Vercel.
4. Redespliega. Pulsa "Comprar" en la app y paga con la tarjeta de prueba `4242 4242 4242 4242` (cualquier fecha futura y CVC). Deberían sumarse 100 correcciones.
5. Cuando la cuenta esté activada, repite 2 y 3 con las claves reales (`sk_live_…`).

## 7. Correo del feedback (opcional, 15 min)

Sin esto, el botón "Enviar" avisa y el profesor usa "Copiar". Para activarlo:

1. En Resend → Domains → Add → `lapizverde.com`. Te dará unos registros DNS (TXT y MX); créalos en la zona DNS de DonDominio, igual que en el paso 0. Con esto también puedes usar Resend como SMTP de Supabase (paso 2).
2. Variables en Vercel: `RESEND_API_KEY` y `FROM_EMAIL` = `feedback@lapizverde.com`.

## 8. Antes de dejar entrar a desconocidos

- [ ] Rellenar los `[HUECOS]` de `privacidad.html` (nombre, NIF, dirección, correo, región de Supabase) y que lo revise alguien que sepa de protección de datos.
- [x] Nombre (Lápiz Verde) y dominio (lapizverde.com).
- [ ] Comprobar la marca en la OEPM (clases 9, 41 y 42).
- [ ] SMTP propio en Supabase (paso 2).
- [ ] Si eres funcionario: autorización de compatibilidad antes de cobrar.

---

## Lo que he hecho esta noche

Resumen en el último mensaje de la conversación y en `git log fase-1`. En corto:

- **Roadmap** completo en `ROADMAP.md`.
- **Login** por correo, **créditos** (20 gratis, 1 por corrección, se devuelven si falla), **pagos** con Stripe, **aislamiento** entre profesores con RLS.
- **Revisión**: nota y comentario editables, aprobar uno a uno o todos; las ilegibles se marcan y van primero.
- **Paso 3 cerrado**: lo aprobado va a `notas` con `origen='markmate'`.
- **Cuaderno**: crear grupos, importar alumnos de Excel, crear tareas. La rúbrica se guarda en la tarea.
- **Rúbrica con IA** a partir de una frase.
- **Modelo** `claude-sonnet-5`, rúbrica cacheada, fotos reducidas antes de enviar, 3 correcciones a la vez.
- **ZIP de Aules/Moodle** además del de Teams.
- **Bugs arreglados** que ya existían: las fotos JPG/PNG nunca se corregían; en un ZIP con varias tareas se corregía el trabajo de otra tarea; el frontend llamaba siempre a producción.
- **Tests**: 22 de API, 26 de base de datos, 30 de navegador. Todos pasan.

Rompe compatibilidad con algo: **la API ya no se puede llamar sin login** (el flujo de Power Automate del README antiguo deja de funcionar). Si lo usabas, dímelo y le hago una clave de acceso.
