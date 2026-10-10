// Solo se ejecuta en lapizverde.com: recibe las notas que el profesor quiere pasar
// («📤 Pasar notas» → «Enviar a la extensión») y las guarda en este navegador.
// No envía nada a ningún sitio.
(() => {
  const ORIGEN = location.origin;
  const CADUCAN_MS = 12 * 60 * 60 * 1000;
  const avisar = (tipo, extra = {}) => window.postMessage({ tipo, ...extra }, ORIGEN);

  const texto = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

  /* Solo lo que hace falta y con límites: nombre, nota y comentario de cada alumno */
  function limpiar(d) {
    if (!d || typeof d !== 'object' || !Array.isArray(d.alumnos) || !d.alumnos.length || d.alumnos.length > 300) return null;
    const alumnos = d.alumnos.map((a) => ({
      nombre: texto(a?.nombre, 100),
      apellidos: texto(a?.apellidos, 150),
      nota: typeof a?.nota === 'number' && a.nota >= 0 && a.nota <= 10 ? a.nota : null,
      comentario: texto(a?.comentario, 5000),
    })).filter((a) => a.nombre);
    if (!alumnos.length) return null;
    return { titulo: texto(d.titulo, 200), grupo: texto(d.grupo, 120), alumnos, creado: Date.now() };
  }

  window.addEventListener('message', async (ev) => {
    if (ev.source !== window || ev.origin !== ORIGEN) return;
    const m = ev.data;
    if (m?.tipo === 'lapiz-verde/hola') return avisar('lapiz-verde/extension', { version: chrome.runtime.getManifest().version });
    if (m?.tipo !== 'lapiz-verde/notas') return;
    const datos = limpiar(m.datos);
    if (!datos) return avisar('lapiz-verde/notas-error');
    await chrome.storage.local.set({ notas: datos });
    avisar('lapiz-verde/notas-recibidas', { alumnos: datos.alumnos.length });
  });

  /* Por si el navegador estuvo cerrado cuando tocaba borrarlas */
  chrome.storage.local.get('notas').then(({ notas }) => {
    if (notas && Date.now() - notas.creado > CADUCAN_MS) chrome.storage.local.remove('notas');
  });

  avisar('lapiz-verde/extension', { version: chrome.runtime.getManifest().version });
})();
