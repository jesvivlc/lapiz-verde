// Pruebas de leer-trabajos.js: de quién es cada archivo del ZIP y el texto de Word, LibreOffice y HTML.
// Los nombres son ficticios.
await import('../leer-trabajos.js');
const {
  tipoArchivo, emparejarEntregas, resolverEntregas,
  textoDeDocx, textoDePptx, textoDeOdf, textoDeHtml, anonimizar, MARCA,
} = globalThis.LeerTrabajos;

let fallos = 0;
const ok = (c, m) => { console.log((c ? '  OK  ' : '  FAIL') + ' ' + m); if (!c) fallos++; };
const nombres = (r, alumnos) => Object.fromEntries(Object.entries(r).map(([i, rs]) => [alumnos[i].nombre, rs]));

console.log('== Tipos de archivo ==');
ok(tipoArchivo('a/b/redaccion.PDF') === 'pdf' && tipoArchivo('x/foto.JPG') === 'imagen', 'PDF y fotos');
ok(tipoArchivo('x/trabajo.docx') === 'docx' && tipoArchivo('x/t.odt') === 'odf' && tipoArchivo('x/t.odp') === 'odf' && tipoArchivo('x/t.pptx') === 'pptx', 'Word, LibreOffice y PowerPoint');
ok(tipoArchivo('Ana_1_assignsubmission_onlinetext_/onlinetext.html') === 'html' && tipoArchivo('x/notas.txt') === 'txt', 'texto en línea de Moodle y .txt');
ok(tipoArchivo('x/viejo.doc') === null && tipoArchivo('x/t.pages') === null && tipoArchivo('x/sin-extension') === null, '.doc antiguo, .pages y sin extensión: no se saben leer');
ok(['__MACOSX/x/._a.pdf', 'x/.DS_Store', 'x/~$trabajo.docx', 'x/Thumbs.db'].every(r => tipoArchivo(r) === 'ignorar'), 'basura del sistema: se ignora');

console.log('== Emparejar: los casos de siempre ==');
{
  const alumnos = [{ nombre: 'Ana López García' }, { nombre: 'Luis Pérez' }, { nombre: 'Marta Ruiz' }];
  const teams = ['Comentario tema 3/Ana López García/Versión 1/trabajo.pdf', 'Comentario tema 3/Ana López García/Versión 2/trabajo.pdf',
    'Comentario tema 3/Luis Pérez/foto.png'];
  const r = emparejarEntregas(teams, alumnos, { tarea: 'Comentario tema 3' });
  ok(r.asignados[0]?.length === 2 && r.asignados[1]?.length === 1 && !r.porRevisar.length, 'Teams: carpeta por alumno, con versiones');
  ok(r.sinEntrega.join() === '2', 'Marta, sin entrega');

  const moodle = ['Ana López García_1234_assignsubmission_file_/redaccion.pdf', 'Ana López García_1234_assignsubmission_onlinetext_/onlinetext.html',
    'Luis Pérez_77_assignsubmission_file_/p1.jpg', 'Luis Pérez_77_assignsubmission_file_/p2.jpg'];
  const m = emparejarEntregas(moodle, alumnos);
  ok(m.asignados[0]?.length === 2 && m.asignados[1]?.length === 2 && !m.porRevisar.length, 'Moodle: archivo y texto en línea del mismo alumno van juntos');

  const drive = ['Comentario tema 3/Ana López García - Comentario tema 3.docx', 'Comentario tema 3/Luis Pérez - foto 1.jpg', 'Comentario tema 3/Luis Pérez - foto 2.jpg'];
  const d = emparejarEntregas(drive, alumnos, { tarea: 'Comentario tema 3' });
  ok(d.asignados[0]?.length === 1 && d.asignados[1]?.length === 2 && !d.porRevisar.length, 'Drive (Classroom): nombre del alumno en el archivo, varias fotos');

  const onedrive = ['Student Work/Submitted files/López García, Ana/Comentario tema 3/trabajo.pdf'];
  ok(emparejarEntregas(onedrive, alumnos).asignados[0]?.length === 1, 'OneDrive: carpeta «Apellidos, Nombre»');
}

console.log('== Emparejar: nunca da a un alumno el trabajo de otro ==');
{
  // Ana García López no entrega; Ana García Pérez sí (antes, a López le corregía el de Pérez)
  const alumnos = [{ nombre: 'Ana García López' }, { nombre: 'Ana García Pérez' }];
  const r = emparejarEntregas(['Ana García Pérez_123_assignsubmission_file_/redaccion.pdf'], alumnos);
  ok(r.asignados[1]?.length === 1 && !r.asignados[0] && !r.porRevisar.length, 'el trabajo de Pérez es solo de Pérez');
  ok(r.sinEntrega.join() === '0', 'López, sin entrega');
}
{
  // En la lista solo «Ana García», en el ZIP dos Anas (antes juntaba los dos trabajos en una corrección)
  const alumnos = [{ nombre: 'Ana García' }, { nombre: 'Luis Pérez' }];
  const rutas = ['Ana García Pérez_1_assignsubmission_file_/a.pdf', 'Ana García López_2_assignsubmission_file_/b.pdf', 'Luis Pérez_3_assignsubmission_file_/c.pdf'];
  const r = emparejarEntregas(rutas, alumnos);
  ok(!r.asignados[0] && r.porRevisar.length === 2 && r.porRevisar.every(p => p.motivo === 'repetido' && p.sugerido === null), 'dos entregas que encajan con la misma Ana: el profe elige, nada preseleccionado');
  ok(r.porRevisar.map(p => p.etiqueta).sort().join('|') === 'Ana García López|Ana García Pérez', 'se enseñan con el nombre de la plataforma, sin el sufijo de Moodle');
  ok(r.asignados[1]?.length === 1, 'Luis, sin problema');
  const final = resolverEntregas(r, { [r.porRevisar.find(p => p.etiqueta === 'Ana García Pérez').id]: 0 });
  ok(final[0]?.join() === 'Ana García Pérez_1_assignsubmission_file_/a.pdf', 'tras elegir, Ana solo tiene la entrega elegida');
}
{
  // En la lista «Ana García» y «Ana García López»: el nombre más completo gana
  const alumnos = [{ nombre: 'Ana García' }, { nombre: 'Ana García López' }];
  const r = emparejarEntregas(['Ana García López/x.pdf', 'Ana García/y.pdf'], alumnos);
  ok(r.asignados[1]?.join() === 'Ana García López/x.pdf' && r.asignados[0]?.join() === 'Ana García/y.pdf', 'cada Ana con lo suyo');
}
{
  // Nombre largo que la plataforma acorta: se sugiere, pero no se da por hecho
  const alumnos = [{ nombre: 'María José Sanz Gil' }];
  const r = emparejarEntregas(['María José Sanz_9_assignsubmission_file_/t.pdf'], alumnos);
  ok(!r.asignados[0] && r.porRevisar[0]?.motivo === 'parcial' && r.porRevisar[0].sugerido === 0, 'a medias: va a revisar con la sugerencia puesta');
  ok(resolverEntregas(r)[0]?.length === 1, 'si el profe no cambia nada, se queda la sugerencia');
  ok(!r.sinEntrega.length, 'no sale como «sin entrega»');
}
{
  // A medias con alguien que ya tiene su entrega completa: no se sugiere
  const alumnos = [{ nombre: 'Ana García López' }];
  const r = emparejarEntregas(['Ana García López/a.pdf', 'Ana García Pérez/b.pdf'], alumnos);
  ok(r.asignados[0]?.join() === 'Ana García López/a.pdf', 'la suya, asignada');
  ok(r.porRevisar.length === 1 && r.porRevisar[0].sugerido === null, 'la de otra Ana García: a revisar y sin sugerencia');
}
{
  // Homónimos en la lista
  const alumnos = [{ nombre: 'Pablo Martí' }, { nombre: 'Pablo Martí' }];
  const r = emparejarEntregas(['Pablo Martí/a.pdf'], alumnos);
  ok(r.porRevisar[0]?.motivo === 'varios' && r.porRevisar[0].candidatos.join() === '0,1' && r.porRevisar[0].sugerido === null, 'dos alumnos con el mismo nombre: el profe elige');
}
{
  // Archivos de nadie
  const alumnos = [{ nombre: 'Luis Pérez' }];
  const r = emparejarEntregas(['Tarea/Luis Pérez - p1.jpg', 'Tarea/IMG_2041.jpg', 'Sergio Vidal_5_assignsubmission_file_/a.pdf', 'Sergio Vidal_5_assignsubmission_file_/b.pdf'], alumnos);
  const x = r.porRevisar.filter(p => p.motivo === 'desconocido');
  ok(x.length === 2, 'lo que no es de nadie va a revisar');
  ok(x.some(p => p.etiqueta === 'IMG_2041.jpg' && p.rutas.length === 1), 'foto suelta en una carpeta compartida (Drive): archivo a archivo');
  ok(x.some(p => p.etiqueta === 'Sergio Vidal' && p.rutas.length === 2), 'carpeta de alguien que no está en la lista (Moodle): junta');
  ok(Object.keys(resolverEntregas(r)).join() === '0', 'si el profe no elige, no se corrige');
}
{
  // Foto con un nombre distinto al de las demás del mismo alumno: la «limpia» se queda sugerida
  const alumnos = [{ nombre: 'Luis Pérez' }];
  const r = emparejarEntregas(['T/Luis Pérez.jpg', 'T/Luis Pérez portada.jpg'], alumnos, { tarea: 'T' });
  ok(r.porRevisar.length === 2 && r.porRevisar.find(p => p.etiqueta === 'Luis Pérez')?.sugerido === 0 && r.porRevisar.find(p => p.etiqueta === 'Luis Pérez portada')?.sugerido === null,
    'dos entregas distintas del mismo alumno: el profe confirma');
}

{
  // Palabras de más en el nombre de la ruta: puede ser otra persona
  const alumnos = [{ nombre: 'María López' }];
  const r = emparejarEntregas(['María López Martín_4_assignsubmission_file_/a.pdf'], alumnos);
  ok(!r.asignados[0] && r.porRevisar[0]?.motivo === 'extra' && r.porRevisar[0].sugerido === 0, '«María López Martín» para «María López»: a revisar, con la sugerencia');
  const d = emparejarEntregas(['Comentario de Ana sobre García Lorca.docx'], [{ nombre: 'Ana García' }]);
  ok(!d.asignados[0] && d.porRevisar[0]?.motivo === 'extra', 'un archivo que menciona el nombre en otra frase no se da por hecho');
}

console.log('== Documentos manipulados: no atascan la página ==');
{
  const medir = fn => { const t = Date.now(); fn(); return Date.now() - t; };
  const n = 2_000_000;
  const casos = [
    ['espacios sin salto', () => textoDeDocx('<w:t>' + ' '.repeat(n) + 'x</w:t>')],
    ['etiquetas sin cerrar', () => textoDeDocx('<w:t'.repeat(n / 4))],
    ['comentarios sin cerrar', () => textoDeOdf('<office:annotation>'.repeat(n / 20))],
    ['HTML con scripts sin cerrar', () => textoDeHtml('<script>'.repeat(n / 8) + '<!--'.repeat(1000))],
    ['espacios en LibreOffice', () => textoDeOdf('<text:s ' + 'a'.repeat(n) + '/>')],
    ['una palabra larguísima', () => anonimizar('a'.repeat(n), 'Ana García')],
    ['muchas palabras', () => anonimizar('Ana García '.repeat(n / 10), 'Ana García')],
  ];
  for (const [nombre, fn] of casos) {
    const ms = medir(fn);
    ok(ms < 1500, `${nombre}: ${ms} ms`);
  }
}

console.log('== Texto de Word ==');
{
  const xml = '<?xml version="1.0"?><w:document xmlns:w="x"><w:body>' +
    '<w:p><w:pPr><w:pStyle w:val="Titulo"/></w:pPr><w:r><w:t>Mi redacción</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t xml:space="preserve">Fui a la playa </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>con mi</w:t></w:r><w:r><w:tab/><w:t>perro &amp; mi gato</w:t></w:r></w:p>' +
    '<w:p><w:r><w:delText>texto borrado</w:delText></w:r><w:ins><w:r><w:t>añadido</w:t></w:r></w:ins></w:p>' +
    '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>A1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B1</w:t></w:r></w:p></w:tc></w:tr></w:tbl>' +
    '<w:p><w:r><w:instrText> PAGE </w:instrText><w:t>Fin</w:t><w:br/><w:t>línea 2</w:t></w:r></w:p>' +
    '</w:body></w:document>';
  const t = textoDeDocx(xml);
  ok(t.startsWith('Mi redacción\nFui a la playa con mi\tperro & mi gato'), 'párrafos, negritas, tabuladores y entidades');
  ok(!t.includes('borrado') && t.includes('añadido'), 'control de cambios: cuenta lo añadido, no lo borrado');
  ok(t.includes('A1') && t.includes('B1') && !t.includes('PAGE') && t.includes('Fin\nlínea 2'), 'tablas, saltos de línea y sin códigos de campo');
}

console.log('== Texto de PowerPoint ==');
{
  const d1 = '<p:sld><a:p><a:r><a:t>Los volcanes</a:t></a:r></a:p></p:sld>';
  const d2 = '<p:sld><a:p><a:r><a:t>Partes:</a:t></a:r></a:p><a:p><a:r><a:t>cráter</a:t></a:r><a:br/><a:r><a:t>chimenea</a:t></a:r></a:p></p:sld>';
  ok(textoDePptx([d1, d2]) === 'Diapositiva 1:\nLos volcanes\n\nDiapositiva 2:\nPartes:\ncráter\nchimenea', 'una sección por diapositiva, en orden');
}

console.log('== Texto de LibreOffice ==');
{
  const xml = '<office:document-content><office:automatic-styles><style:style style:name="P1"/></office:automatic-styles><office:body><office:text>' +
    '<text:h text:outline-level="1">El otoño</text:h><text:p>Las hojas<text:s text:c="2"/>caen <text:span text:style-name="T1">despacio</text:span>.<text:line-break/>Fin</text:p>' +
    '<text:p>Hola<office:annotation><dc:creator>Profe</dc:creator><text:p>comentario</text:p></office:annotation> mundo</text:p>' +
    '<text:tracked-changes><text:changed-region><text:deletion><text:p>quitado</text:p></text:deletion></text:changed-region></text:tracked-changes>' +
    '</office:text></office:body></office:document-content>';
  const t = textoDeOdf(xml);
  ok(t === 'El otoño\nLas hojas  caen despacio.\nFin\nHola mundo', 'títulos, espacios, estilos y saltos; sin comentarios ni lo borrado');
}

console.log('== Texto en línea (HTML de Moodle) ==');
{
  const html = '<html><head><title>x</title><style>p{}</style></head><body><p>Primera&nbsp;frase.</p><p>Segunda<br>línea &lt;3</p><script>alert(1)</script><ul><li>uno</li><li>dos</li></ul></body></html>';
  ok(textoDeHtml(html) === 'Primera frase.\nSegunda\nlínea <3\nuno\ndos', 'párrafos, saltos y listas; sin scripts ni estilos');
}

console.log('== Anonimizar ==');
{
  const t = 'Nombre: Ana López García\nCurso: 3.º ESO\n\nMe llamo Ana López y este verano fui con García Márquez... Ana fue a la playa.\nAPELLIDOS: López García';
  const a = anonimizar(t, 'Ana López García');
  ok(!/López/.test(a), 'no queda ningún apellido junto al nombre');
  ok(a.startsWith(`Nombre: ${MARCA}\nCurso: 3.º ESO`), 'la línea «Nombre:» se vacía y el resto se respeta');
  ok(a.includes(`Me llamo ${MARCA} y este verano`), 'secuencias de nombre y apellido en medio del texto');
  ok(!a.includes('García') && a.includes(`${MARCA} fue a la playa`), 'también las palabras sueltas de su nombre: tapa de más antes que de menos');
  ok(a.endsWith(`APELLIDOS: ${MARCA}`), 'también en mayúsculas');
  ok(anonimizar('López, Ana: redacción', 'Ana López') === `${MARCA}: redacción`, 'formato «Apellidos, Nombre»');
  ok(anonimizar('Soy Ana García Pérez y tengo 14 años. Ana García. Fin', 'Ana García') === `Soy ${MARCA} y tengo 14 años. ${MARCA}. Fin`,
    'en la lista pone menos apellidos que en el trabajo: también se tapan');
  ok(anonimizar('Me llamo Lucía y me gusta leer. Hecho por Lucía', 'Lucía Martín') === `Me llamo ${MARCA} y me gusta leer. Hecho por ${MARCA}`, 'el nombre de pila, suelto');
  ok(anonimizar('Trabajo de Li Wang', 'Li Wang') === `Trabajo de ${MARCA}`, 'nombres de dos letras');
  ok(anonimizar('Autor: x\nŁukasz Nowak escribe', 'Łukasz Nowak') === `Autor: ${MARCA}\n${MARCA} escribe`, 'letras de otros alfabetos (ł)');
  ok(anonimizar("Soy Marco D'Angelo", "Marco D'Angelo") === `Soy ${MARCA}`, 'apellidos con apóstrofo');
  ok(anonimizar('Ana\nGarcía\n\nEl texto', 'Ana García') === `${MARCA}\n${MARCA}\n\nEl texto`, 'nombre y apellido en líneas distintas');
  ok(anonimizar('Nom i cognoms: Pau Ferrer\nNombre del alumno: Pau Ferrer', 'Pau Ferrer').split(MARCA).length === 3, 'cabeceras en valenciano y «Nombre del alumno:»');
  ok(anonimizar('María de la Fuente vive en la playa', 'María de la Fuente') === `${MARCA} vive en la playa`, 'las partículas («de la») no se tapan sueltas');
  const grupo = anonimizar('Lo hice con Pedro Sanz y con Pedro', 'Ana García', ['Pedro Sanz Ruiz']);
  ok(grupo === `Lo hice con ${MARCA} y con Pedro`, 'nombre completo de un compañero (trabajo en grupo)');
}

console.log(fallos ? `\n${fallos} prueba(s) fallida(s)` : '\nTodas las pruebas de leer-trabajos pasan');
process.exit(fallos ? 1 : 0);
