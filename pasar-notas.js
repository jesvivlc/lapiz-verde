/* Pasar las notas del cuaderno a otras plataformas sin pedir permiso a nadie:
   todo ocurre en el navegador del profesor, con ficheros que él descarga y sube.

   - rellenarHojaMoodle: la «hoja de calificaciones» de una tarea de Moodle (Aules,
     EducamosCLM, Moodle Centros, EducaMadrid…). El profe la descarga, la rellenamos
     con nota y comentario, y la sube con «Subir hoja de calificaciones».
   - tablaParaCopiar: texto con tabuladores para pegar en una hoja de cálculo.

   Script clásico (index.html lo carga con <script>) que también se puede importar
   en Node para las pruebas: lo expone todo en globalThis.PasarNotas. */
(function (global) {
  'use strict';

  /* ── Nombres ── */
  function norm(str) {
    return String(str ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  }
  function palabras(str) {
    return norm(str).split(/[^a-z0-9ñç]+/).filter(p => p.length > 1);
  }

  /* ¿Este texto nombra a este alumno? Todas las palabras de nombre y apellidos, o al
     menos el nombre y el primer apellido (las plataformas a veces omiten el segundo). */
  function nombraA(texto, alumno) {
    const enTexto = new Set(palabras(texto));
    const nombre = palabras(alumno.nombre);
    const apellidos = palabras(alumno.apellidos);
    if (!nombre.length) return false;
    const todas = [...nombre, ...apellidos];
    if (todas.every(p => enTexto.has(p))) return true;
    return apellidos.length > 1 && nombre.every(p => enTexto.has(p)) && enTexto.has(apellidos[0]);
  }

  /* El único alumno al que nombra el texto (o el del correo), o null si ninguno o varios */
  function emparejar(texto, alumnos, email) {
    const correo = norm(email).trim();
    if (correo) {
      const porCorreo = alumnos.filter(a => a.email && norm(a.email).trim() === correo);
      if (porCorreo.length === 1) return { alumno: porCorreo[0] };
    }
    const pal = a => palabras(`${a.nombre} ${a.apellidos ?? ''}`);
    const enTexto = new Set(palabras(texto));
    const parcial = a => !pal(a).every(p => enTexto.has(p));
    /* Si los dos tienen correo y no coincide, es otra persona aunque se llame igual */
    let candidatos = alumnos.filter(a => nombraA(texto, a) && !(correo && a.email && norm(a.email).trim() !== correo));
    if (!candidatos.length) return null;
    /* Quien sale con todas sus palabras gana a quien solo coincide en nombre y primer apellido */
    const completos = candidatos.filter(a => !parcial(a));
    if (completos.length) candidatos = completos;
    if (candidatos.length === 1) return { alumno: candidatos[0], parcial: parcial(candidatos[0]) };
    /* "Ana López" y "Ana López García": si unos nombres contienen a otros, gana el más
       largo; dos alumnos distintos (o dos iguales) son ambiguos */
    const contenido = (a, b) => pal(a).every(p => pal(b).includes(p)) && pal(a).length < pal(b).length;
    const finales = candidatos.filter(a => !candidatos.some(b => b !== a && contenido(a, b)));
    return finales.length === 1 ? { alumno: finales[0], parcial: parcial(finales[0]) } : { ambiguo: true };
  }

  /* Cuando a un alumno le corresponden varias filas, solo vale la que tiene su nombre
     completo si es la única así; si no, ninguna. Devuelve, por fila, si se puede usar. */
  function elegirFilas(rs) {
    const porAlumno = new Map();
    rs.forEach((r, k) => { if (r?.alumno) porAlumno.set(r.alumno, [...(porAlumno.get(r.alumno) || []), k]); });
    const valida = rs.map(() => false);
    for (const ks of porAlumno.values()) {
      const completas = ks.filter(k => !rs[k].parcial);
      if (ks.length === 1) valida[ks[0]] = true;
      else if (completas.length === 1) valida[completas[0]] = true;
    }
    return valida;
  }

  /* ── Texto del comentario ── */
  function textoComentario(n, firma) {
    if (!n) return '';
    const partes = [];
    if (n.comentario_ia) partes.push(n.comentario_ia.trim());
    const mejoras = String(n.mejoras_ia ?? '').split('\n').map(s => s.trim()).filter(Boolean);
    if (mejoras.length) partes.push('Para mejorar:\n' + mejoras.map((m, i) => `${i + 1}. ${m}`).join('\n'));
    if (n.mensaje_motivador) partes.push(n.mensaje_motivador.trim());
    if (partes.length && firma) partes.push(firma);
    return partes.join('\n\n');
  }

  function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  /* Moodle guarda los comentarios de retroalimentación como HTML */
  function comentarioHtml(texto) {
    return String(texto).split(/\n{2,}/).map(p => p.trim()).filter(Boolean)
      .map(p => `<p>${escHtml(p).replace(/\n/g, '<br>')}</p>`).join('');
  }

  /* ── CSV (RFC 4180, con comillas y saltos de línea dentro de los campos) ── */
  function leerCsv(texto) {
    let bom = false;
    if (texto.charCodeAt(0) === 0xFEFF) { bom = true; texto = texto.slice(1); }
    const primeraLinea = texto.slice(0, texto.search(/\r?\n|$/));
    const cuenta = c => (primeraLinea.match(new RegExp('\\' + c, 'g')) || []).length;
    const sep = [',', ';', '\t'].sort((a, b) => cuenta(b) - cuenta(a))[0];
    const eol = /\r\n/.test(texto) ? '\r\n' : '\n';
    const filas = [];
    let fila = [], campo = '', comillas = false;
    for (let i = 0; i < texto.length; i++) {
      const c = texto[i];
      if (comillas) {
        if (c === '"' && texto[i + 1] === '"') { campo += '"'; i++; }
        else if (c === '"') comillas = false;
        else campo += c;
      } else if (c === '"') comillas = true;
      else if (c === sep) { fila.push(campo); campo = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && texto[i + 1] === '\n') i++;
        fila.push(campo); filas.push(fila); fila = []; campo = '';
      } else campo += c;
    }
    if (campo !== '' || fila.length) { fila.push(campo); filas.push(fila); }
    return { filas: filas.filter(f => f.some(c => c !== '')), sep, eol, bom };
  }

  function escribirCsv({ filas, sep, eol, bom }) {
    const q = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
    return (bom ? '﻿' : '') + filas.map(f => f.map(q).join(sep)).join(eol) + eol;
  }

  /* ── Hoja de calificaciones de Moodle ──
     Cabeceras en los idiomas de las plataformas autonómicas (es, ca/va, gl, eu, en). */
  const COLUMNAS = {
    id: /^(identifier|identificador|identificatzailea)$/,
    nombre: /^(full name|nombre completo|nom complet|nome completo|izen osoa)$/,
    email: /(email|correo|adreca|enderezo|helbide)/,
    nota: /^(grade|calificacion|qualificacio|cualificacion|kalifikazioa)$/,
    max: /^(maximum grade|calificacion maxima|qualificacio maxima|cualificacion maxima|gehienezko kalifikazioa)$/,
    comentario: /(feedback comments|retroaliment|retroaccio|retroalimentacion|iruzkin)/,
  };

  function columnas(cabecera) {
    const h = cabecera.map(c => norm(c).trim());
    const buscar = re => h.findIndex(c => re.test(c));
    return {
      id: buscar(COLUMNAS.id), nombre: buscar(COLUMNAS.nombre), email: buscar(COLUMNAS.email),
      nota: buscar(COLUMNAS.nota), max: buscar(COLUMNAS.max), comentario: buscar(COLUMNAS.comentario),
    };
  }

  function leerNumero(s) {
    const t = String(s ?? '').trim().replace(/\s/g, '');
    if (!/^\d+([.,]\d+)?$/.test(t)) return null;
    return parseFloat(t.replace(',', '.'));
  }

  /**
   * notas: [{ nombre, apellidos, email, nota (0-10 o null), comentario (texto) }]
   * Devuelve { csv, rellenadas, sinNota, noEncontrados, ambiguos, sinComentarios } o lanza Error.
   */
  function rellenarHojaMoodle(texto, notas, { conComentario = true } = {}) {
    const hoja = leerCsv(texto);
    if (hoja.filas.length < 2) throw new Error('La hoja está vacía.');
    const col = columnas(hoja.filas[0]);
    if (col.id < 0 || col.nombre < 0) {
      throw new Error('No parece una hoja de calificaciones de Moodle. Descárgala desde la tarea: «Ver todas las entregas» → «Acción sobre las calificaciones» → «Descargar hoja de calificaciones».');
    }
    if (col.nota < 0) {
      throw new Error('La hoja no tiene la columna de calificación. En la tarea, activa «Hoja de calificaciones fuera de línea» (Configuración → Tipos de retroalimentación) y vuelve a descargarla.');
    }
    const ponerComentario = conComentario && col.comentario >= 0;
    const res = { rellenadas: 0, sinNota: [], noEncontrados: [], ambiguos: [], parciales: [], sinComentarios: conComentario && col.comentario < 0 };

    /* Primera pasada: a quién corresponde cada fila. Un alumno del cuaderno al que le
       corresponden dos filas es dudoso: no se rellena ninguna de las dos */
    const filas = hoja.filas.slice(1).map(fila => ({ fila, nombreHoja: fila[col.nombre] ?? '',
      r: emparejar(fila[col.nombre] ?? '', notas, col.email >= 0 ? fila[col.email] : null) }));
    const valida = elegirFilas(filas.map(f => f.r));

    for (const [k, { fila, nombreHoja, r }] of filas.entries()) {
      if (!r) { res.noEncontrados.push(nombreHoja); continue; }
      if (r.ambiguo || !valida[k]) { res.ambiguos.push(nombreHoja); continue; }
      const n = r.alumno;
      if (n.nota == null || n.nota === '' || isNaN(Number(n.nota))) { res.sinNota.push(nombreHoja); continue; }

      /* La nota del cuaderno es sobre 10: se pasa a la escala de la tarea, con el mismo
         separador decimal y los mismos decimales que usa la hoja */
      const maxTexto = col.max >= 0 ? fila[col.max] : '';
      const max = col.max >= 0 ? leerNumero(maxTexto) : 10;
      if (max == null) {
        throw new Error('La tarea se califica con una escala, no con números. Cámbiala a «Puntuación» en Moodle o pasa las notas a mano.');
      }
      const decimales = (String(maxTexto).match(/[.,](\d+)$/)?.[1].length) ?? 2;
      const coma = /,/.test(maxTexto) || (!/\./.test(maxTexto) && /,/.test(fila[col.nota] ?? ''));
      let valor = (Math.round(Number(n.nota) * max / 10 * 100) / 100).toFixed(decimales);
      if (coma) valor = valor.replace('.', ',');
      fila[col.nota] = valor;
      if (ponerComentario && n.comentario) fila[col.comentario] = comentarioHtml(n.comentario);
      res.rellenadas++;
      if (r.parcial) res.parciales.push(nombreHoja);
    }
    res.csv = escribirCsv(hoja);
    return res;
  }

  /* ── Copiar y pegar: "Apellidos, Nombre<TAB>Nota[<TAB>Comentario]" ── */
  function tablaParaCopiar(notas, { conComentario = false } = {}) {
    /* Lo que empieza por = + - @ sería una fórmula al pegarlo en una hoja de cálculo */
    const limpio = s => String(s ?? '').replace(/\s+/g, ' ').trim().replace(/^[=+\-@]/, "'$&");
    return notas.map(n => {
      const nombre = limpio(n.apellidos ? `${n.apellidos}, ${n.nombre}` : n.nombre);
      const nota = n.nota == null || n.nota === '' ? '' : String(Math.round(Number(n.nota) * 100) / 100).replace('.', ',');
      return [nombre, nota, ...(conComentario ? [limpio(n.comentario)] : [])].join('\t');
    }).join('\n');
  }

  global.PasarNotas = { norm, palabras, nombraA, emparejar, elegirFilas, textoComentario, comentarioHtml, leerCsv, escribirCsv, rellenarHojaMoodle, tablaParaCopiar };
})(typeof window !== 'undefined' ? window : globalThis);
