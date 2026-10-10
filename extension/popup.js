// Ventana de la extensión: rellena la página abierta con las notas preparadas en el cuaderno.
const CADUCAN_MS = 12 * 60 * 60 * 1000;   // las notas no se quedan en el navegador más de 12 horas
const $ = (id) => document.getElementById(id);
let datos = null;

function hace(ms) {
  const min = Math.round((Date.now() - ms) / 60000);
  if (min < 1) return 'ahora mismo';
  if (min < 60) return `hace ${min} min`;
  return `hace ${Math.round(min / 60)} h`;
}

function lista(titulo, nombres, clase = '') {
  if (!nombres.length) return '';
  const p = document.createElement('p');
  p.className = clase;
  p.textContent = titulo;
  const ul = document.createElement('ul');
  for (const n of nombres) { const li = document.createElement('li'); li.textContent = n; ul.appendChild(li); }
  return [p, ul];
}

async function cargar() {
  const { notas } = await chrome.storage.local.get('notas');
  if (notas && Date.now() - notas.creado > CADUCAN_MS) await chrome.storage.local.remove('notas');
  datos = notas && Date.now() - notas.creado <= CADUCAN_MS ? notas : null;
  $('vacio').classList.toggle('hidden', !!datos);
  $('lleno').classList.toggle('hidden', !datos);
  if (!datos) return;
  const conNota = datos.alumnos.filter((a) => a.nota != null).length;
  $('titulo').textContent = datos.titulo || 'Notas';
  $('version').textContent = 'v' + chrome.runtime.getManifest().version;
  $('resumen').textContent = `${datos.grupo ? datos.grupo + ' · ' : ''}${conNota} alumnos con nota · preparadas ${hace(datos.creado)}`;
}

async function rellenar() {
  const boton = $('rellenar');
  const res = $('resultado');
  boton.disabled = true;
  res.replaceChildren();
  try {
    await cargar();   // por si han caducado mientras la ventana estaba abierta
    if (!datos) return;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const opciones = { comentarios: $('comentarios').checked, entero: $('entero').checked, coma: $('coma').checked };
    await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['rellenar.js'] });
    const marcos = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: (d, o) => globalThis.__pasarNotas ? globalThis.__pasarNotas(d, o) : null,
      args: [datos, opciones],
    });
    const hechos = new Set(), incompatibles = new Set(), parciales = new Set();
    let comentarios = 0, ambiguos = 0;
    for (const { result: r } of marcos) {
      if (!r) continue;
      r.hechos.forEach((i) => hechos.add(i));
      r.incompatibles.forEach((i) => incompatibles.add(i));
      (r.parciales || []).forEach((i) => parciales.add(i));
      comentarios += r.comentarios;
      ambiguos += r.ambiguos;
    }
    const nombre = (a) => [a.nombre, a.apellidos].filter(Boolean).join(' ');
    const conNota = datos.alumnos.map((a, i) => ({ a, i })).filter(({ a }) => a.nota != null);
    const faltan = conNota.filter(({ i }) => !hechos.has(i) && !incompatibles.has(i)).map(({ a }) => nombre(a));
    const parecidos = [...parciales].map((i) => nombre(datos.alumnos[i]));
    const raras = conNota.filter(({ i }) => !hechos.has(i) && incompatibles.has(i)).map(({ a }) => nombre(a));

    const ok = document.createElement('p');
    if (hechos.size) {
      ok.className = 'ok';
      ok.textContent = `✔ ${hechos.size} ${hechos.size === 1 ? 'nota puesta' : 'notas puestas'}` +
        (comentarios ? ` y ${comentarios} comentarios` : '') + '. Están marcadas en verde.';
    } else {
      ok.className = 'aviso';
      ok.textContent = 'No he encontrado dónde poner las notas en esta página. Abre la pantalla donde se ven los alumnos con su casilla de nota.';
    }
    res.append(ok);
    if (hechos.size) {
      res.append(...(lista('No los he encontrado en esta página:', faltan, 'aviso') || []));
      res.append(...(lista('La casilla no admite su nota (ponla a mano):', raras, 'aviso') || []));
      res.append(...(lista('Comprueba que es la persona correcta (en la página su nombre no es idéntico):', parecidos, 'aviso') || []));
      if (ambiguos) {
        const p = document.createElement('p');
        p.className = 'muted';
        p.textContent = 'Algunas filas eran dudosas (nombres repetidos o varias casillas de nota en la misma fila) y no las he tocado: ponlas a mano.';
        res.append(p);
      }
    }
  } catch (e) {
    const p = document.createElement('p');
    p.className = 'aviso';
    p.textContent = 'No puedo escribir en esta página. ' + (e?.message || '');
    res.append(p);
  } finally {
    boton.disabled = false;
  }
}

$('rellenar').addEventListener('click', rellenar);
$('borrar').addEventListener('click', async () => { await chrome.storage.local.remove('notas'); cargar(); });
cargar();
