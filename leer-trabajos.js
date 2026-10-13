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
   *  - asignados: el nombre completo del alumno está en la ruta y no encaja mejor con nadie más.
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
      if (lista.length === 1) { asignados[i] = lista[0].g.rutas.slice(); continue; }
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
  ══════════════════════════════════════ */

  function decodificar(s) {
    return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') {
        const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '';
      }
      return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }[e.toLowerCase()] ?? m;
    });
  }

  function ordenar(texto) {
    return String(texto).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  /** word/document.xml → texto. Solo <w:t> (lo escrito); lo borrado con control de cambios (<w:delText>) no cuenta */
  function textoDeDocx(xml) {
    let salida = '', dentro = false;
    const re = /<(\/?)(w:t|w:p|w:tab|w:br|w:cr|w:tc|w:tr)\b[^>]*?(\/?)>|([^<]+)|<[^>]*>/g;
    let m;
    while ((m = re.exec(xml))) {
      const [, cierre, etiqueta, sola, texto] = m;
      if (texto !== undefined) { if (dentro) salida += decodificar(texto); continue; }
      if (!etiqueta) continue;
      if (etiqueta === 'w:t') { dentro = !cierre && !sola; continue; }
      if (etiqueta === 'w:tab' && !cierre) salida += '\t';
      else if ((etiqueta === 'w:br' || etiqueta === 'w:cr') && !cierre) salida += '\n';
      else if (etiqueta === 'w:p' && (cierre || sola)) salida += '\n';
      else if (etiqueta === 'w:tc' && cierre) salida += '\t';
      else if (etiqueta === 'w:tr' && cierre) salida += '\n';
    }
    return ordenar(salida);
  }

  /** [xml de cada diapositiva, en orden] → texto, con «Diapositiva N» delante */
  function textoDePptx(diapositivas) {
    return ordenar(diapositivas.map((xml, n) => {
      let salida = '', dentro = false;
      const re = /<(\/?)(a:t|a:p|a:br)\b[^>]*?(\/?)>|([^<]+)|<[^>]*>/g;
      let m;
      while ((m = re.exec(xml))) {
        const [, cierre, etiqueta, sola, texto] = m;
        if (texto !== undefined) { if (dentro) salida += decodificar(texto); continue; }
        if (!etiqueta) continue;
        if (etiqueta === 'a:t') dentro = !cierre && !sola;
        else if (etiqueta === 'a:br' && !cierre) salida += '\n';
        else if (etiqueta === 'a:p' && (cierre || sola)) salida += '\n';
      }
      return `Diapositiva ${n + 1}:\n${ordenar(salida)}`;
    }).join('\n\n'));
  }

  /** content.xml de LibreOffice (Writer o Impress) → texto. Sin comentarios ni cambios rechazados */
  function textoDeOdf(xml) {
    const cuerpo = String(xml)
      .replace(/<office:annotation\b[\s\S]*?<\/office:annotation>/g, '')
      .replace(/<text:tracked-changes\b[\s\S]*?<\/text:tracked-changes>/g, '')
      .replace(/<office:automatic-styles\b[\s\S]*?<\/office:automatic-styles>/g, '')
      .replace(/<text:s\b[^>]*?text:c="(\d+)"[^>]*\/>/g, (_, n) => ' '.repeat(Math.min(Number(n), 20)))
      .replace(/<text:s\b[^>]*\/>/g, ' ')
      .replace(/<text:tab\b[^>]*\/>/g, '\t')
      .replace(/<text:line-break\b[^>]*\/>/g, '\n')
      .replace(/<\/(text:p|text:h|draw:page|table:table-row)>/g, '\n')
      .replace(/<\/table:table-cell>/g, '\t')
      .replace(/<[^>]+>/g, '');
    return ordenar(decodificar(cuerpo));
  }

  /** HTML (texto en línea de Moodle, páginas guardadas) → texto */
  function textoDeHtml(html) {
    const cuerpo = String(html)
      .replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6]|tr|blockquote|pre)>/gi, '\n')
      .replace(/<\/t[dh]>/gi, '\t')
      .replace(/<[^>]+>/g, '');
    return ordenar(decodificar(cuerpo));
  }

  /* ══════════════════════════════════════
     Anonimizar: la IA nunca recibe el nombre del alumno
  ══════════════════════════════════════ */

  const MARCA = '[nombre del alumno]';

  /** Quita del texto las líneas «Nombre: …» y cualquier secuencia de 2 o más palabras de su nombre */
  function anonimizar(texto, nombre) {
    let t = String(texto ?? '');
    t = t.replace(/^([ \t]*(?:nombre(?: y apellidos)?|apellidos|alumno|alumna|alumno\/a|estudiante)[ \t]*[:.\-][ \t]*).*$/gim, `$1${MARCA}`);
    const suyas = new Set(palabras(nombre).filter(p => p.length > 2));
    if (!suyas.size) return t;
    // Secuencias de 2 o más palabras de su nombre (con espacios, comas o guiones entre ellas), y hasta
    // 2 palabras en mayúscula justo detrás: en la lista pone «Ana García» y ella firma «Ana García Pérez»
    return t.replace(/[\p{L}][\p{L}'’]*(?:[ \t,.\-]+[\p{L}][\p{L}'’]*)+/gu, trozo => {
      const ps = trozo.split(/([ \t,.\-]+)/);   // palabra, separador, palabra…
      const esSuya = k => suyas.has(norm(ps[k]));
      let salida = '', k = 0;
      while (k < ps.length) {
        if (k % 2 === 1 || !esSuya(k)) { salida += ps[k]; k++; continue; }
        let fin = k, n = 1;
        while (fin + 2 < ps.length && esSuya(fin + 2)) { fin += 2; n++; }
        if (n < 2) { salida += ps[k]; k++; continue; }
        for (let extra = 0; extra < 2 && fin + 2 < ps.length && /^[ \t]+$/.test(ps[fin + 1]) && /^\p{Lu}/u.test(ps[fin + 2]); extra++) fin += 2;
        salida += MARCA;
        k = fin + 1;
      }
      return salida;
    });
  }

  global.LeerTrabajos = {
    norm, palabras, tipoArchivo, emparejarEntregas, resolverEntregas,
    textoDeDocx, textoDePptx, textoDeOdf, textoDeHtml, anonimizar, MARCA,
  };
})(typeof window !== 'undefined' ? window : globalThis);
