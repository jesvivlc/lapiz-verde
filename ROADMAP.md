# Roadmap — Lápiz Verde

Plan de producto derivado de las conversaciones de septiembre de 2026.
Estado de cada punto: ✅ hecho · 🔧 hecho en la rama `fase-1`, pendiente de activar · ⬜ pendiente.

---

## La tesis, en cuatro líneas

1. **El producto no es la corrección, es la tubería.** La llamada a la IA es barata y cualquiera la tiene; lo valioso es recoger → saber de quién es → corregir → guardar la nota → avisar, sin que el profesor haga nada por alumno.
2. **Una acción por clase, sí; una acción por alumno, no.** Bajarse un ZIP y soltarlo es aceptable. Pegar 25 trabajos en ChatGPT, no.
3. **La IA propone, el profesor firma.** Toda corrección es un borrador hasta que el profesor la aprueba. Es lo que le da defensa legal (RGPD art. 22, Reglamento europeo de IA) y lo que hace el producto defendible en público.
4. **Mercado privado.** Ningún centro lo contratará al principio y nadie lo recomendará en público. Se vende a profesores sueltos que buscan a solas, por bonos, con un nombre discreto.

## Números de referencia

| Concepto | Valor |
|---|---|
| Coste por corrección (Sonnet 5, 2 fotos de página) | ~1,8 céntimos; ~0,9 con Batch API |
| Profesor de primaria típico | ~100 correcciones/mes → 1-2 € de coste |
| Profesores pagando para 2.000 €/mes | ~200 (0,03% de los docentes de España) |
| Margen bruto esperado | 75-90% |

Medirlo en real: la tabla `uso_ia` guarda los tokens de cada corrección desde la fase 1.

---

## Fase 0 — Validar la tesis (antes de invertir más)

| | Tarea | Quién |
|---|---|---|
| ⬜ | **Prueba de OCR**: 20 fotos de libretas reales, de las malas, por el corrector. Si no lee manuscrito infantil, primaria no existe como mercado. | Bruno |
| ⬜ | **Prueba de los 10 profesores**: que diez compañeros lo usen gratis. Si no se consiguen diez gratis, no habrá doscientos pagando. | Bruno |
| ⬜ | **Prueba de pago**: página + bono de 9 € + 150 € de anuncios de búsqueda. 300 visitas, ¿cuántos pagan? | Bruno + código de fase 1 |

## Fase 1 — Hito: "un desconocido se registra, paga, corrige una clase y no ve datos de nadie"

| | Tarea | Notas |
|---|---|---|
| 🔧 | Limpieza: duplicado `antescorregIA-app/`, `console.log`, `.gitignore` | |
| 🔧 | Arreglo: las imágenes JPG/PNG nunca se corregían (el frontend mandaba `tipo_archivo: 'imagen'`, que el backend rechaza) | Bug real encontrado |
| 🔧 | Arreglo: el frontend llamaba a la URL de producción fija | Ahora ruta relativa |
| 🔧 | Modelo `claude-sonnet-5`, `max_tokens` suficiente, caché de sistema + rúbrica | |
| 🔧 | Login con enlace mágico por correo (sin contraseñas) | Supabase Auth |
| 🔧 | Créditos: 20 gratis al registrarse, 1 por corrección, se devuelve si falla | `perfiles.creditos` |
| 🔧 | Aislamiento multiusuario: `owner_id` + RLS en todas las tablas y vistas | SQL en `supabase/migrations/` |
| 🔧 | Cobro con Stripe Checkout (bono 100 por 9 €, bono 500 por 35 €) + webhook idempotente | |
| 🔧 | Correo de feedback desde el servidor (el profesor ya no necesita clave de Resend) + botón "copiar" | |
| 🔧 | **Paso 3 de CLAUDE.md**: las correcciones se aprueban y se guardan en `notas` con `origen='markmate'` | Pantalla de revisión básica |
| 🔧 | Crear grupos, importar alumnos desde Excel y crear tareas desde la interfaz | Sin esto un usuario nuevo no puede usar el cuaderno |
| 🔧 | La rúbrica se guarda en la tarea y se reutiliza; botón "que la escriba la IA" | Quita la mayor fricción del alta |
| 🔧 | Página de entrada para quien no ha iniciado sesión | |
| 🔧 | Registro de uso (`uso_ia`) para medir coste real por corrección | |
| ✅ | Nombre: **Lápiz Verde** (guiño a "corregir en verde"; sin "IA"; vale para toda Latinoamérica) | Decidido el 7/10/2026 |
| ✅ | Dominio lapizverde.com comprado | 7/10/2026 |
| ⬜ | Comprobar la marca en la OEPM (clases 9, 41, 42); valorar comprar también lapizverde.es | Bruno |
| ⬜ | Conectar el dominio en Vercel y en Supabase; descriptor "LAPIZ VERDE" en el extracto de Stripe | Tras comprar el dominio |
| ⬜ | Política de privacidad y aviso legal | Antes de cobrar a desconocidos |

## Fase 2 — Cumplimiento como producto

| | Tarea |
|---|---|
| ⬜ | Revisión completa: aceptar / ajustar nota / editar texto / rechazar, con "aceptar todas" |
| ⬜ | Ordenar la bandeja por "necesita tu atención": nota muy distinta a la media del alumno, entrega muy corta, fichero ilegible, baja confianza |
| ⬜ | Registro de auditoría: quién aprobó qué y cuándo |
| ⬜ | Plantilla de contrato de encargado de tratamiento para centros |
| ⬜ | Verificar el calendario vigente del Reglamento europeo de IA para sistemas de evaluación educativa (anexo III, alto riesgo) |

## Fase 3 — Recepción automática de trabajos

Principio: **todos los canales escriben en la misma tabla `entregas`** (grupo, tarea, alumno o nulo, fichero, canal, estado). La tubería se construye una vez; cada canal es un enchufe.

La clave: **las plataformas ya dejan las entregas en carpetas con el nombre del alumno**, sin necesidad de API.

| Plataforma | Dónde están las entregas | Identidad del alumno |
|---|---|---|
| Teams | SharePoint del equipo: *Student Work → Submitted files → [Alumno] → [Tarea]* | Nombre de la carpeta |
| Classroom | Drive del profesor: *Classroom → [Clase] → [Tarea]* | Nombre del fichero (tareas "copia por alumno") |
| Moodle / Aules | "Descargar todas las entregas": ZIP con carpeta por alumno | Nombre de la carpeta |
| Papel | App de OneDrive/Drive → "Escanear" → PDF en una carpeta | QR de la portada, leído en el servidor |

| | Tarea | Permisos necesarios |
|---|---|---|
| ✅ | Arrastrar ZIP / ficheros a la página | Ninguno |
| ⬜ | Tabla `entregas` + ingestor genérico "fichero + ruta → alumno + tarea" | — |
| ⬜ | Bandeja "¿de quién es esto?" para entregas sin identificar | — |
| ⬜ | Enlace de entrega por tarea: el alumno sube su trabajo directamente | Ninguno |
| ⬜ | Buzón de correo por grupo (`grupo-x7k2@entregas.dominio`), identificación por remitente contra `alumnos.email` | Ninguno. Necesita proveedor con correo entrante (Mailgun, Postmark, SendGrid) |
| ⬜ | Pegatinas QR por alumno (PDF imprimible) + lectura de QR en el servidor | Ninguno |
| ⬜ | Peldaño A: el profesor comparte la carpeta con `corrector@dominio` (cuenta propia) | Que el centro permita compartir fuera |
| ⬜ | Peldaño C: carpeta sincronizada leída desde el navegador (File System Access API) | Ninguno |
| ⬜ | Peldaño B: OAuth de ficheros (no de tareas educativas) | Consentimiento de usuario |
| ⬜ | Carpeta nueva → aviso "¿qué rúbrica?" → corrección nocturna con Batch API (-50%) | — |
| ⬜ | Exportar notas: CSV para ITACA y hoja de calificación externa de Moodle | Ninguno |

**Verificar antes de construir** (Bruno):
- ¿Permiten los dominios de los centros compartir carpetas con cuentas externas?
- ¿Cómo nombra Classroom las subidas libres?
- ¿La función Escanear de OneDrive/Drive deja elegir carpeta de destino?

## Fase 4 — Valor que no se copia con un prompt

| | Tarea |
|---|---|
| ⬜ | Resumen de grupo: qué han fallado todos (decisión didáctica para el lunes) |
| ⬜ | Feedback con memoria: referencia a la tarea anterior del mismo alumno |
| ⬜ | Biblioteca de rúbricas por criterios de evaluación LOMLOE, por materia y curso, en castellano y valenciano |
| ⬜ | Microsoft Graph / LTI 1.3 / Classroom API — solo al vender a centros (requiere administrador) |
| ⬜ | Latinoamérica |

---

## Monetización

| Plan | Precio | Correcciones | Estado |
|---|---|---|---|
| Gratis | 0 € | 20 al registrarse | 🔧 |
| Bono 100 | 9 € | 100, sin caducidad | 🔧 |
| Bono 500 | 35 € | 500, sin caducidad | 🔧 |
| Curso escolar | 99 € (sept-jun) | 300/mes | ⬜ para quien ya compró 3 bonos |

Bonos antes que suscripción: comprar una herramienta pesa menos que "ser suscriptor", no hay cargo mensual que explicar, encaja con el uso a picos, y es más simple de operar.

## Marketing

- **Búsqueda** (SEO + anuncios): el profesor que busca a solas a las once de la noche. Canal principal.
- **Recomendación privada**: "invita a un compañero, 50 correcciones para los dos".
- **Debate en redes, como fundador y a cara descubierta**: el debate es "¿debe el profesor usar IA para el feedback?", nunca "¿debe la IA sustituir al profesor?". Formatos: experimento con datos reales, prueba ciega, encuestas, vídeo de la pantalla de revisión.
- **Antes de dar la cara**: si eres funcionario, autorización de compatibilidad; y la política de privacidad publicada.
- **Línea roja**: nada de cuentas falsas para agitar debates.
- **Producto discreto**: nombre neutro, cargo discreto en la tarjeta, feedback firmado por el profesor, sin funciones sociales.
