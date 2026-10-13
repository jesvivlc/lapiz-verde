/* Leer los trabajos que el profe suelta en la página: de quién es cada archivo y qué dice.

   - emparejarEntregas: reparte las rutas de un ZIP (Teams, Moodle/Aules, Drive de Classroom,
     OneDrive) entre los alumnos de la lista. Nunca adivina: lo que encaja a medias, con
     varios alumnos o con nadie va a «porRevisar» para que el profe elija.
   - resolverEntregas: aplica lo que el profe ha elegido y devuelve los archivos de cada alumno.
   - tipoArchivo: qué hacer con cada archivo según su extensión.
   - textoDeDocx / textoDePptx / textoDeOdf / textoDeHtml: el texto de Word, PowerPoint,
     LibreOffice (Writer e Impress) y HTML (el «texto en línea» de Moodle), sin librerías:
     son XML dentro de un ZIP que ya abre JSZip.
   - anonimizar: quita del texto el nombre del alumno antes de mandarlo a la IA.

   Script clásico (index.html lo carga con <script>) que también se puede importar
   en Node para las pruebas: lo expone todo en globalThis.LeerTrabajos. */
(function (global) {
  'use strict';

  /* ── Nombres ── */
  function norm(str) {
    return String(str ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  }
  function palabras(str) {
    return norm(str).split(/[^a-z0-9ñç]+/).filter(p => p.length > 1);
  }

  /* Palabras de una ruta que no dicen de quién es: plataformas, versiones, extensiones… */
  const RUIDO = new Set(('assignsubmission file onlinetext feedback version student work submitted files ' +
    'foto fotos imagen img image pagina pag page hoja hojas parte trabajo tarea entrega scan escaneo ' +
    'escaneado documento doc docx pdf jpg jpeg png gif webp heic odt odp ods pptx ppt html htm txt rtf pages ' +
    'copia copy de del la el los las y final definitivo nuevo sin titulo untitled whatsapp camscanner').split(' '));
  /* Partículas de nombres y apellidos («María de la Fuente»): no identifican a nadie por sí solas */
  const PARTICULAS = new Set(['de', 'del', 'la', 'las', 'los', 'y', 'i', 'da', 'van', 'von', 'el']);

  /* ── Tipos de archivo ── */
  const TIPOS = {
    pdf: 'pdf',
    jpg: 'imagen', jpeg: 'imagen', png: 'imagen', webp: 'imagen', gif: 'imagen',
    docx: 'docx', docm: 'docx',
    pptx: 'pptx',
    odt: 'odf', odp: 'odf',
    html: 'html', htm: 'html',
    txt: 'txt',
  };

  /** 'pdf' | 'imagen' | 'docx' | 'pptx' | 'odf' | 'html' | 'txt' | 'ignorar' (basura del
      sistema) | null (no se sabe leer: .doc, .pages, .heic…) */
  function tipoArchivo(ruta) {
    const nombre = String(ruta).split('/').pop();
    if (/(^|\/)__MACOSX\//.test(ruta) || /^(\.|~\$)/.test(nombre) || /^(thumbs\.db|desktop\.ini)$/i.test(nombre)) return 'ignorar';
    const ext = (nombre.match(/\.([a-z0-9]+)$/i) || [])[1];
    return (ext && TIPOS[ext.toLowerCase()]) || null;
  }

  /* ══════════════════════════════════════
     Emparejar archivos y alumnos
  ══════════════════════════════════════ */

  function trozos(ruta) {
    const partes = String(ruta).split('/');
    partes[partes.length - 1] = partes[partes.length - 1].replace(/\.[a-z0-9]+$/i, '');
    return partes;
  }

  /* Lo que queda de un trozo de ruta al quitarle el nombre del alumno, números y ruido */
  function sobrante(trozo, delAlumno, deTarea) {
    return [...new Set(palabras(trozo).filter(p => !/^\d+$/.test(p) && !RUIDO.has(p) && !delAlumno.has(p) && !deTarea.has(p)))].sort().join(' ');
  }

  /* Nombre legible de un trozo: sin el sufijo de Moodle ni la extensión */
  function etiqueta(trozo) {
    return String(trozo).replace(/_\d+_assignsubmission_.*$/i, '').replace(/_+$/, '').trim() || String(trozo);
  }

  /**
   * Reparte `rutas` entre `alumnos` ([{ nombre }], el nombre completo).
   * Devuelve { asignados: { [índice]: rutas[] }, porRevisar: [{ id, etiqueta, rutas, sugerido, candidatos, motivo }], sinEntrega: [índices] }
   *  - asignados: el nombre completo del alumno está en la ruta, sin palabras de más, y no encaja mejor con nadie.
   *  - porRevisar: a medias (sugerido), con varios alumnos, varias entregas distintas que encajan
   *    con el mismo alumno («Ana García» y en el ZIP «Ana García Pérez» y «Ana García López»), o con nadie.
   */
  function emparejarEntregas(rutas, alumnos, { tarea = '' } = {}) {
    const deTarea = new Set(palabras(tarea));
    const delAlumno = alumnos.map(a => [...new Set(palabras(a.nombre))]);
    const setAlumno = delAlumno.map(p => new Set(p));

    const porRuta = rutas.map(ruta => {
      const ts = trozos(ruta);
      const enTrozo = ts.map(t => new Set(palabras(t)));
      const completos = [], parciales = [];
      delAlumno.forEach((ps, i) => {
        if (!ps.length) return;
        let mejor = -1, aciertosMax = 0;
        enTrozo.forEach((set, j) => {
          const aciertos = ps.filter(p => set.has(p)).length;
          if (aciertos > aciertosMax) { aciertosMax = aciertos; mejor = j; }
        });
        if (aciertosMax === ps.length) completos.push({ i, j: mejor, peso: ps.length });
        else if (ps.length >= 3 && aciertosMax >= 2) parciales.push({ i, j: mejor, peso: aciertosMax });
      });
      return { ruta, ts, completos, parciales };
    });

    // Cada ruta, a lo sumo a un alumno: el que encaja entero y con más palabras («Ana García López» gana a «Ana García»)
    const grupos = new Map();   // clave → { rutas, alumno, sugerido, candidatos, motivo, etiqueta }
    const meter = (clave, datos, ruta) => {
      if (!grupos.has(clave)) grupos.set(clave, { ...datos, rutas: [] });
      grupos.get(clave).rutas.push(ruta);
    };
    const carpetasConDueno = new Set();
    const sinDueno = [];
    for (const r of porRuta) {
      const elegir = lista => {
        const max = Math.max(...lista.map(c => c.peso));
        return lista.filter(c => c.peso === max);
      };
      if (r.completos.length) {
        const top = elegir(r.completos);
        carpetasConDueno.add(r.ts.slice(0, -1).join('/'));
        if (top.length === 1) {
          const { i, j } = top[0];
          const resto = sobrante(r.ts[j], setAlumno[i], deTarea);
          meter(`a${i}|${resto}`, { alumno: i, resto, etiqueta: etiqueta(r.ts[j]) }, r.ruta);
        } else {
          const cand = top.map(c => c.i).sort((a, b) => a - b);
          meter(`v${cand.join(',')}|${r.ts.slice(0, -1).join('/')}`, { motivo: 'varios', candidatos: cand, sugerido: null, etiqueta: etiqueta(r.ts[top[0].j]) }, r.ruta);
        }
      } else if (r.parciales.length) {
        const top = elegir(r.parciales);
        carpetasConDueno.add(r.ts.slice(0, -1).join('/'));
        const cand = top.map(c => c.i).sort((a, b) => a - b);
        meter(`p${cand.join(',')}|${etiqueta(r.ts[top[0].j])}`, {
          motivo: cand.length === 1 ? 'parcial' : 'varios', candidatos: cand,
          sugerido: cand.length === 1 ? cand[0] : null, etiqueta: etiqueta(r.ts[top[0].j]),
        }, r.ruta);
      } else {
        sinDueno.push(r);
      }
    }
    // Lo que no es de nadie: por carpeta (Moodle, Teams) o, si comparte carpeta con otros alumnos (Drive), archivo a archivo
    for (const r of sinDueno) {
      const carpeta = r.ts.slice(0, -1).join('/');
      const suelto = !carpeta || carpetasConDueno.has(carpeta);
      const clave = suelto ? `x|${r.ruta}` : `x|${carpeta}/`;
      meter(clave, { motivo: 'desconocido', candidatos: [], sugerido: null, etiqueta: suelto ? r.ruta.split('/').pop() : etiqueta(r.ts[r.ts.length - 2]) }, r.ruta);
    }

    // Un alumno con entregas distintas («Ana García Pérez» y «Ana García López»): el profe elige.
    // Si una de ellas no tiene nada de más en el nombre, esa es la suya; las otras quedan sin elegir.
    const asignados = {}, porRevisar = [];
    const porAlumno = new Map();
    for (const [clave, g] of grupos) {
      if (g.alumno === undefined) continue;
      if (!porAlumno.has(g.alumno)) porAlumno.set(g.alumno, []);
      porAlumno.get(g.alumno).push({ clave, g });
    }
    for (const [i, lista] of porAlumno) {
      if (lista.length === 1 && !lista[0].g.resto) { asignados[i] = lista[0].g.rutas.slice(); continue; }
      // En la ruta hay palabras de más («María López Martín» para «María López»): puede ser otra persona
      if (lista.length === 1) {
        const { clave, g } = lista[0];
        porRevisar.push({ id: clave, etiqueta: g.etiqueta, rutas: g.rutas, motivo: 'extra', candidatos: [i], sugerido: i });
        continue;
      }
      const limpias = lista.filter(({ g }) => !g.resto);
      for (const { clave, g } of lista) {
        porRevisar.push({ id: clave, etiqueta: g.etiqueta, rutas: g.rutas, motivo: 'repetido', candidatos: [i],
          sugerido: limpias.length === 1 && limpias[0].g === g ? i : null });
      }
    }
    for (const [clave, g] of grupos) {
      if (g.alumno !== undefined) continue;
      // «Ana García Pérez» encaja a medias con «Ana García López», pero si ella ya tiene su entrega, no se sugiere
      const sugerido = g.sugerido !== null && porAlumno.has(g.sugerido) ? null : g.sugerido;
      porRevisar.push({ id: clave, etiqueta: g.etiqueta, rutas: g.rutas, motivo: g.motivo, candidatos: g.candidatos, sugerido });
    }
    const conAlgo = new Set([...Object.keys(asignados).map(Number), ...porRevisar.flatMap(p => p.candidatos)]);
    const sinEntrega = alumnos.map((_, i) => i).filter(i => !conAlgo.has(i));
    return { asignados, porRevisar, sinEntrega };
  }

  /** Archivos de cada alumno tras lo que el profe ha elegido ({ [id de porRevisar]: índice | null }) */
  function resolverEntregas({ asignados, porRevisar }, elecciones = {}) {
    const final = {};
    for (const [i, rs] of Object.entries(asignados)) final[i] = rs.slice();
    for (const p of porRevisar) {
      const i = p.id in elecciones ? elecciones[p.id] : p.sugerido;
      if (i === null || i === undefined || i === '') continue;
      (final[i] ||= []).push(...p.rutas);
    }
    return final;
  }

  /* ══════════════════════════════════════
     Texto de documentos (XML dentro de un ZIP)
     El alumno controla el documento: nada de expresiones regulares que puedan atascarse.
     El XML se recorre una sola vez buscando «<» y «>» con indexOf.
  ══════════════════════════════════════ */

  const MAX_XML = 8 * 1024 * 1024;   // caracteres de XML o HTML que se procesan como mucho

  function decodificar(s) {
    return String(s).replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,6});/gi, (m, e) => {
      if (e[0] === '#') {
        const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '';
      }
      return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }[e.toLowerCase()] ?? m;
    });
  }

  /* Sin espacios al final de línea ni más de una línea en blanco seguida */
  function ordenar(texto) {
    const salida = [];
    let blancas = 0;
    for (const linea of String(texto).split('\n')) {
      const l = linea.trimEnd();
      blancas = l ? 0 : blancas + 1;
      if (blancas < 2) salida.push(l);
    }
    return salida.join('\n').trim();
  }

  /** Recorre XML o HTML: alEtiqueta(nombre, cierre, sola, dentro) y alTexto(texto). Lineal. */
  function recorrer(xml, alEtiqueta, alTexto) {
    const s = String(xml).slice(0, MAX_XML);
    let i = 0;
    while (i < s.length) {
      const a = s.indexOf('<', i);
      if (a < 0) { alTexto(s.slice(i)); break; }
      if (a > i) alTexto(s.slice(i, a));
      if (s.startsWith('<!--', a)) {
        const f = s.indexOf('-->', a + 4);
        i = f < 0 ? s.length : f + 3;
        continue;
      }
      const b = s.indexOf('>', a + 1);
      if (b < 0) break;
      const dentro = s.slice(a + 1, b);
      const m = /^\/?\s*([^\s/>]+)/.exec(dentro);
      if (m) alEtiqueta(m[1].toLowerCase(), dentro[0] === '/', dentro.endsWith('/'), dentro);
      i = b + 1;
    }
  }

  /** word/document.xml → texto. Solo <w:t> (lo escrito); lo borrado con control de cambios (<w:delText>) no cuenta */
  function textoDeDocx(xml) {
    const salida = [];
    let dentro = false, enTabs = 0;
    recorrer(xml, (n, cierre, sola) => {
      if (n === 'w:t') { dentro = !cierre && !sola; return; }
      if (n === 'w:tabs') { if (!sola) enTabs += cierre ? -1 : 1; return; }   // posiciones de tabulación, no tabuladores
      if (enTabs > 0) return;
      if (n === 'w:tab' && !cierre) salida.push('\t');
      else if ((n === 'w:br' || n === 'w:cr') && !cierre) salida.push('\n');
      else if (n === 'w:p' && (cierre || sola)) salida.push('\n');
      else if (n === 'w:tc' && cierre) salida.push('\t');
      else if (n === 'w:tr' && cierre) salida.push('\n');
    }, t => { if (dentro) salida.push(decodificar(t)); });
    return ordenar(salida.join(''));
  }

  /** [xml de cada diapositiva, en orden] → texto, con «Diapositiva N» delante */
  function textoDePptx(diapositivas) {
    return ordenar(diapositivas.map((xml, k) => {
      const salida = [];
      let dentro = false;
      recorrer(xml, (n, cierre, sola) => {
        if (n === 'a:t') dentro = !cierre && !sola;
        else if (n === 'a:br' && !cierre) salida.push('\n');
        else if (n === 'a:p' && (cierre || sola)) salida.push('\n');
      }, t => { if (dentro) salida.push(decodificar(t)); });
      return `Diapositiva ${k + 1}:\n${ordenar(salida.join(''))}`;
    }).join('\n\n'));
  }

  /** content.xml de LibreOffice (Writer o Impress) → texto. Sin comentarios, estilos ni cambios rechazados */
  const ODF_FUERA = new Set(['office:annotation', 'text:tracked-changes', 'office:automatic-styles', 'office:font-face-decls', 'office:styles']);
  function textoDeOdf(xml) {
    const salida = [];
    let fuera = 0;
    recorrer(xml, (n, cierre, sola, dentro) => {
      if (ODF_FUERA.has(n)) { if (!sola) fuera = Math.max(0, fuera + (cierre ? -1 : 1)); return; }
      if (fuera) return;
      if (n === 'text:s' && !cierre) {
        const c = /text:c="(\d{1,4})"/.exec(dentro);
        salida.push(' '.repeat(Math.min(c ? Number(c[1]) : 1, 20)));
      } else if (n === 'text:tab' && !cierre) salida.push('\t');
      else if (n === 'text:line-break' && !cierre) salida.push('\n');
      else if ((n === 'text:p' || n === 'text:h' || n === 'draw:page' || n === 'table:table-row') && (cierre || sola)) salida.push('\n');
      else if (n === 'table:table-cell' && cierre) salida.push('\t');
    }, t => { if (!fuera) salida.push(decodificar(t)); });
    return ordenar(salida.join(''));
  }

  /** HTML (texto en línea de Moodle, páginas guardadas) → texto */
  const HTML_FUERA = new Set(['script', 'style', 'head', 'template']);
  const HTML_SALTO = new Set(['p', 'div', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'tr', 'blockquote', 'pre']);
  function textoDeHtml(html) {
    const salida = [];
    let fuera = 0;
    recorrer(html, (n, cierre, sola) => {
      if (HTML_FUERA.has(n)) { if (!sola) fuera = Math.max(0, fuera + (cierre ? -1 : 1)); return; }
      if (fuera) return;
      if (n === 'br') salida.push('\n');
      else if (cierre && HTML_SALTO.has(n)) salida.push('\n');
      else if (cierre && (n === 'td' || n === 'th')) salida.push('\t');
    }, t => { if (!fuera) salida.push(decodificar(t)); });
    return ordenar(salida.join(''));
  }

  /* ══════════════════════════════════════
     Anonimizar: la IA nunca recibe el nombre del alumno
  ══════════════════════════════════════ */

  const MARCA = '[nombre del alumno]';
  /* Líneas de cabecera: «Nombre:», «Nombre y apellidos:», «Nom i cognoms:», «Alumno/a:», «Fdo.:»… */
  const CABECERA = /^([ \t]*(?:nombre|nom|apellidos?|cognoms?|alumn[oae]s?|estudiante?|fdo|firmado|firma|signat)\b[^\n:]{0,40}:[ \t]*).*$/gim;

  function palabrasDeNombre(nombre) {
    return String(nombre ?? '').split(/[^\p{L}\p{N}]+/u).map(norm).filter(p => p.length >= 2 && !PARTICULAS.has(p));
  }

  /**
   * Quita del texto el nombre del alumno: las líneas de cabecera («Nombre: …»), cualquier palabra
   * de su nombre escrita en mayúscula (también suelta: «Me llamo Lucía»; «su» o «mar» en minúscula
   * no, para no estropear el texto), dos o más palabras de nombres seguidas en cualquier forma, hasta
   * 2 palabras en mayúscula justo detrás (sus apellidos aunque la lista no los tenga) y los nombres
   * de compañeros (`otros`): seguidos, o sueltos en mayúscula en mitad de una frase.
   * Tapa de más antes que de menos: el profe ve el trabajo original.
   */
  function anonimizar(texto, nombre, otros = []) {
    const t = String(texto ?? '').replace(CABECERA, `$1${MARCA}`);
    const suyas = new Set(palabrasDeNombre(nombre));
    const deOtros = new Set(otros.flatMap(palabrasDeNombre));
    if (!suyas.size && !deOtros.size) return t;
    const ps = t.split(/([^\p{L}\p{N}'’]+)/u);   // palabra, separador, palabra…
    const tipo = ps.map((p, k) => {
      if (k % 2 || !p) return '';
      const partes = norm(p).split(/['’]/);
      if (partes.some(x => suyas.has(x))) return 'suya';
      return partes.some(x => deOtros.has(x)) ? 'otro' : '';
    });
    const junto = sep => sep.length <= 3 && /^[ \t,.\-\n]+$/.test(sep);
    const mayuscula = k => /^\p{Lu}/u.test(ps[k]);
    const enMitadDeFrase = k => k > 0 && !/[.!?:\n]/.test(ps[k - 1]);
    const tapar = ps.map((_, k) => (tipo[k] === 'suya' && mayuscula(k)) || (tipo[k] === 'otro' && mayuscula(k) && enMitadDeFrase(k)));
    // Dos o más palabras de nombres seguidas (también de compañeros: «con Pedro Sanz»)
    for (let k = 0; k + 2 < ps.length; k += 2) {
      if (tipo[k] && tipo[k + 2] && junto(ps[k + 1])) tapar[k] = tapar[k + 2] = true;
    }
    // Apellidos que no están en la lista: hasta 2 palabras en mayúscula justo detrás
    const antes = tapar.slice();
    for (let k = 0; k < ps.length; k += 2) {
      if (!antes[k] || antes[k + 2]) continue;
      for (let j = k, extra = 0; extra < 2 && j + 2 < ps.length && /^[ \t]+$/.test(ps[j + 1]) && /^\p{Lu}/u.test(ps[j + 2]); extra++) {
        j += 2;
        tapar[j] = true;
      }
    }
    // «María de la Fuente»: las partículas entre dos palabras tapadas, también
    for (let k = 0; k < ps.length; k += 2) {
      if (!tapar[k]) continue;
      let j = k + 2;
      while (j < ps.length && j - k <= 6 && !tapar[j] && PARTICULAS.has(norm(ps[j])) && junto(ps[j - 1])) j += 2;
      if (j > k + 2 && j < ps.length && tapar[j] && junto(ps[j - 1])) for (let x = k + 2; x < j; x += 2) tapar[x] = true;
    }
    let salida = '';
    for (let k = 0; k < ps.length; k++) {
      if (k % 2 === 0 && tapar[k]) {
        while (k + 2 < ps.length && tapar[k + 2] && /^[ \t,]{1,3}$/.test(ps[k + 1])) k += 2;
        salida += MARCA;
      } else {
        salida += ps[k];
      }
    }
    return salida;
  }

  global.LeerTrabajos = {
    norm, palabras, tipoArchivo, emparejarEntregas, resolverEntregas,
    textoDeDocx, textoDePptx, textoDeOdf, textoDeHtml, anonimizar, MARCA,
  };
})(typeof window !== 'undefined' ? window : globalThis);
