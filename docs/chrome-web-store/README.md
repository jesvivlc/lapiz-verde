# Publicar «Pasar notas» en la Chrome Web Store

Hoy la extensión se instala descargando un ZIP y activando el «modo de desarrollador» de Chrome, y eso echa para atrás a casi cualquiera. Publicada en la tienda como **oculta** («Unlisted»), se instala con un clic. No aparece en búsquedas: solo la encuentra quien tiene el enlace desde Lápiz Verde.

## Lo que te toca a ti

1. **Cuenta de desarrollador** en https://chrome.google.com/webstore/devconsole: pago único de 5 $, con tu cuenta de Google. Pide verificar el correo y, como publicas tú, datos de «trader» (UE): nombre, dirección y teléfono. Esa ficha es pública.
2. **Subir el ZIP**: en Lápiz Verde, Cuaderno → un grupo → «Pasar notas» → «Descargar la extensión». Descomprímelo y vuelve a comprimir **el contenido** de la carpeta `pasar-notas` (que `manifest.json` quede en la raíz del ZIP). Súbelo en «New item».
3. Rellenar la ficha con los textos de abajo y enviarla a revisión (suele tardar de unas horas a unos días).
4. Cuando esté publicada, pásame el enlace y lo pongo en `URL_EXTENSION_TIENDA` (`index.html`). Desde ese momento, el botón dirá «Instalar la extensión» y abrirá la tienda.

## Ficha («Store listing»)

- **Nombre**: Pasar notas
- **Resumen** (máx. 132 caracteres): Rellena las notas y comentarios de tu cuaderno en la página de calificaciones que tengas abierta. Tú revisas y guardas.
- **Descripción**:

  > Pasar notas copia las notas (y, si quieres, los comentarios) de tu cuaderno a la página de calificaciones que tengas abierta: Google Classroom, Aules y otros Moodle, ITACA, Séneca…
  >
  > Solo rellena las casillas, como si las teclearas tú: no pulsa Guardar ni envía nada. Revisas lo marcado en verde y guardas tú.
  >
  > Las notas se quedan en tu navegador: la extensión no las manda a ningún servidor y las borra sola a las 12 horas.
  >
  > Cómo se usa: en tu cuaderno, «Pasar notas» → «Enviar a la extensión»; abre la página de calificaciones y pulsa el icono → «Rellenar esta página».

- **Categoría**: Educación (Education)
- **Idioma**: Español
- **Icono**: `extension/iconos/icono-128.png`
- **Imagen promocional pequeña (440×280)**: `docs/chrome-web-store/promo-440x280.png`
- **Capturas (1280×800, al menos una)**: la tienda las exige. Haz una de una página de calificaciones de prueba con las casillas rellenas en verde, **sin datos de alumnos reales**.
- **Visibilidad**: **Unlisted** (oculta).

## Prácticas de privacidad («Privacy practices»)

- **Propósito único**: Rellenar en la página de calificaciones abierta las notas y comentarios que el profesor ha enviado desde su cuaderno de Lápiz Verde.
- **Justificación de permisos**:
  - `storage`: guardar en el navegador las notas enviadas desde el cuaderno hasta que se rellenan; se borran solas a las 12 horas.
  - `alarms`: programar ese borrado a las 12 horas.
  - `activeTab` y `scripting`: rellenar las casillas de la pestaña abierta solo cuando el profesor pulsa «Rellenar esta página».
  - Script de contenido en `lapizverde.com`: recibir del cuaderno las notas que el profesor envía a la extensión.
- **Código remoto**: No, la extensión no usa código remoto.
- **Datos que maneja**: marca «Información personal identificable» (nombres de alumnos) y «Contenido del sitio web» (notas y comentarios). Declara además que:
  - no se venden a terceros;
  - no se usan para nada distinto del propósito único;
  - no se usan para decidir créditos ni préstamos.
- **Política de privacidad**: `https://lapizverde.com/privacidad.html`. Ya explica qué hace la extensión. Antes de enviar, rellena los `[HUECOS]` de esa página.

## Cada vez que cambie la extensión

Sube la versión en `manifest.json` (`"version"`), genera el ZIP igual que arriba y súbelo en la consola («Package» → «Upload new package»). Las instalaciones se actualizan solas.
