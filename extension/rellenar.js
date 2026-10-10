// Se inyecta en la página de calificaciones que el profesor tiene abierta (Classroom, Aules,
// ITACA, Séneca…) solo cuando pulsa «Rellenar esta página». Escribe cada nota en el campo
// de la fila del alumno, como si la tecleara él. Nunca pulsa Guardar.
(() => {
  /* ── Nombres (mismo criterio que pasar-notas.js de la web) ── */
  const norm = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const palabras = (s) => norm(s).split(/[^a-z0-9ñç]+/).filter((p) => p.length > 1);

  function nombraA(enTexto, a) {
    const nombre = palabras(a.nombre), apellidos = palabras(a.apellidos);
    if (!nombre.length) return false;
    if ([...nombre, ...apellidos].every((p) => enTexto.has(p))) return true;
    return apellidos.length > 1 && nombre.every((p) => enTexto.has(p)) && enTexto.has(apellidos[0]);
  }

  /* El único alumno nombrado en el texto. Si salen varios, solo se resuelve cuando unos
     nombres contienen a otros («Ana López» y «Ana López García»): gana el más largo.
     Un bloque con varios alumnos distintos (la tabla entera) es ambiguo y no se toca. */
  function quien(texto, alumnos) {
    const enTexto = new Set(palabras(texto));
    let cand = alumnos.filter((a) => nombraA(enTexto, a));
    const pal = (a) => palabras(`${a.nombre} ${a.apellidos}`);
    if (cand.length <= 1) return cand.length ? { alumno: cand[0], parcial: !pal(cand[0]).every((p) => enTexto.has(p)) } : null;
    /* Quien sale con todas sus palabras gana a quien solo coincide en nombre y primer apellido */
    const completos = cand.filter((a) => pal(a).every((p) => enTexto.has(p)));
    if (completos.length) cand = completos;
    const parcial = (a) => !pal(a).every((p) => enTexto.has(p));
    if (cand.length === 1) return { alumno: cand[0], parcial: parcial(cand[0]) };
    const contenido = (a, b) => pal(a).every((p) => pal(b).includes(p)) && pal(a).length < pal(b).length;
    const finales = cand.filter((a) => !cand.some((b) => b !== a && contenido(a, b)));
    return finales.length === 1 ? { alumno: finales[0], parcial: parcial(finales[0]) } : { ambiguo: true };
  }

  /* ── Campos ── */
  const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length) &&
    getComputedStyle(el).visibility !== 'hidden';
  const usable = (el) => !el.disabled && !el.readOnly && visible(el);

  function camposNota() {
    return [...document.querySelectorAll('input, select')].filter((el) => {
      if (!usable(el)) return false;
      if (el.tagName === 'SELECT') return el.options.length > 1;
      const tipo = (el.getAttribute('type') || 'text').toLowerCase();
      const pistas = `${el.name} ${el.id} ${el.placeholder} ${el.getAttribute('aria-label') || ''}`;
      return (tipo === 'text' || tipo === 'number') && !/search|buscar|busca|filtr|cerca|comment|coment/i.test(pistas);
    });
  }

  /* Texto de un bloque con cada trozo separado («García<br>ana@…» no es «garciaana») */
  function textoDe(el) {
    const trozos = [];
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    while (w.nextNode()) if (w.currentNode.parentElement?.closest('option, script, style') == null) trozos.push(w.currentNode.nodeValue);
    return trozos.join(' ');
  }

  /* La fila del alumno: el antepasado más cercano del campo que nombra a algún alumno,
     sin salir de su fila. Si la página tiene filas (tabla, lista), no se pasa de la del
     campo; si no, no se sube a un bloque que contenga otra casilla de nota. Así la casilla
     de un alumno ajeno nunca toma el nombre de la fila de al lado. */
  const FILA = 'tr, [role=row], [role=listitem], li';
  function filaDe(campo, alumnos, campos) {
    const tope = campo.closest(FILA);
    let el = campo.parentElement;
    for (let i = 0; el && el !== document.body && i < 12; i++, el = el.parentElement) {
      if (!tope && campos.some((c) => c !== campo && el.contains(c))) return null;
      const r = quien(textoDe(el), alumnos);
      if (r) return { ...r, fila: el };
      if (el === tope) return null;
    }
    return null;
  }

  /* «/ 100,00» junto al campo (Moodle, Classroom): la nota del cuaderno es sobre 10 */
  function maximoJunto(campo) {
    for (const el of [campo.parentElement, campo.parentElement?.parentElement]) {
      const m = el?.textContent.match(/\/\s*(\d+(?:[.,]\d+)?)/);
      if (m) return parseFloat(m[1].replace(',', '.'));
    }
    return 10;
  }

  const CALIFICACIONES = [
    [5, 'insuficiente', 'in'], [6, 'suficiente', 'su'], [7, 'bien', 'bi'], [9, 'notable', 'nt'], [Infinity, 'sobresaliente', 'sb'],
  ];

  /* A entero sin aprobar a nadie por redondeo: un 4,6 se queda en 4 */
  function redondear(nota, max) {
    const v = Math.round(nota * max / 10);
    return nota < 5 ? Math.max(Math.min(v, Math.ceil(max / 2) - 1), max === 10 && nota > 0 ? 1 : 0) : v;
  }

  function valorPara(campo, nota, op) {
    if (campo.tagName === 'SELECT') {
      /* Desplegables de notas: número entero o calificación (Notable, NT…) */
      const entero = String(redondear(nota, 10));
      const [, palabra, abrev] = CALIFICACIONES.find(([hasta]) => nota < hasta);
      const opcion = [...campo.options].find((o) => {
        const t = norm(o.textContent).trim(), v = norm(o.value).trim();
        return t === entero || v === entero || t.startsWith(palabra) || t === abrev || v === abrev ||
          new RegExp(`^${entero}\\b`).test(t);
      });
      return opcion ? opcion.value : null;
    }
    const max = maximoJunto(campo);
    const v = op.entero ? redondear(nota, max) : Math.round(nota * max / 10 * 100) / 100;
    const s = String(v);
    return op.coma && campo.type !== 'number' ? s.replace('.', ',') : s;
  }

  function poner(el, valor) {
    const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype
      : el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    el.focus();
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, valor);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.style.outline = '3px solid #16A34A';
    el.style.outlineOffset = '1px';
  }

  globalThis.__pasarNotas = function (datos, op = {}) {
    const alumnos = datos.alumnos.map((a, i) => ({ ...a, i }));
    const hechos = new Set(), incompatibles = new Set(), parciales = new Set();
    let ambiguos = 0;
    let comentarios = 0;
    /* Primera pasada: la fila de cada casilla. Un alumno que sale en dos filas distintas
       (dos «Ana López…») es dudoso y no se rellena en ninguna */
    const campos = camposNota();
    const asignados = campos.map((campo) => ({ campo, r: filaDe(campo, alumnos, campos) }))
      .filter(({ r }) => r && (r.ambiguo ? (ambiguos++, false) : true));
    /* Si una de esas filas lleva su nombre completo y las demás no, vale esa */
    const filasDe = new Map();
    for (const { r } of asignados) {
      if (!filasDe.has(r.alumno.i)) filasDe.set(r.alumno.i, new Map());
      const f = filasDe.get(r.alumno.i);
      f.set(r.fila, (f.get(r.fila) ?? true) && !r.parcial);
    }
    const filaValida = (r) => {
      const f = filasDe.get(r.alumno.i);
      if (f.size === 1) return true;
      const completas = [...f].filter(([, completa]) => completa);
      return completas.length === 1 && completas[0][0] === r.fila;
    };
    for (const { campo, r } of asignados) {
      const a = r.alumno;
      if (!filaValida(r)) { ambiguos++; continue; }
      if (hechos.has(a.i) || a.nota == null) continue;
      const valor = valorPara(campo, a.nota, op);
      if (valor == null) { incompatibles.add(a.i); continue; }
      poner(campo, valor);
      hechos.add(a.i);
      if (r.parcial) parciales.add(a.i);
      incompatibles.delete(a.i);
      if (op.comentarios && a.comentario) {
        const areas = [...r.fila.querySelectorAll('textarea')].filter(usable);
        if (areas.length === 1) { poner(areas[0], a.comentario); comentarios++; }
      }
    }
    return { hechos: [...hechos], ambiguos, incompatibles: [...incompatibles], parciales: [...parciales], comentarios };
  };
})();
