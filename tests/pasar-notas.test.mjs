// Pruebas de pasar-notas.js: hoja de calificaciones de Moodle y copiar/pegar.
// Las hojas imitan las que descarga Moodle 4.x («Descargar hoja de calificaciones»).
await import('../pasar-notas.js');
const { rellenarHojaMoodle, leerCsv, emparejar, textoComentario, tablaParaCopiar, comentarioHtml } = globalThis.PasarNotas;

let fallos = 0;
const ok = (c, m) => { console.log((c ? '  OK  ' : '  FAIL') + ' ' + m); if (!c) fallos++; };
const lanza = (fn, re) => { try { fn(); return false; } catch (e) { return re.test(e.message); } };

const notas = [
  { nombre: 'Ana', apellidos: 'López García', email: 'ana@alumnos.es', nota: 7.5, comentario: 'Buen trabajo.\n\nPara mejorar:\n1. Ortografía\n2. Orden' },
  { nombre: 'Luis', apellidos: 'Pérez', email: '', nota: 4, comentario: 'Hay que repasar <b>esto</b> & lo otro "ya"' },
  { nombre: 'Marta', apellidos: 'Ruiz', email: '', nota: null, comentario: '' },
  { nombre: 'Ana', apellidos: 'Lucas', email: '', nota: 9, comentario: 'Excelente' },
];

console.log('== Hoja en castellano (Aules), sobre 10, con comentarios ==');
const ES = '﻿' + [
  '"Identificador","Nombre completo","Dirección de correo","Estado","Calificación","Calificación máxima","La calificación puede ser cambiada","Última modificación (entrega)","Última modificación (calificación)","Comentarios de retroalimentación"',
  '"Participante 101","Ana López García","ana@alumnos.es","Enviado para calificar","","10,00","Sí","lunes, 5 de octubre de 2026, 10:00","-",""',
  '"Participante 102","Luis Pérez Martín","luis@alumnos.es","Enviado para calificar","","10,00","Sí","lunes, 5 de octubre de 2026, 10:05","-",""',
  '"Participante 103","Marta Ruiz","marta@alumnos.es","Sin entrega","","10,00","Sí","-","-",""',
  '"Participante 104","Ana Lucas","","Enviado para calificar","","10,00","Sí","-","-",""',
  '"Participante 105","Pedro Gil","pedro@alumnos.es","Sin entrega","","10,00","Sí","-","-",""',
].join('\n') + '\n';
let r = rellenarHojaMoodle(ES, notas);
let h = leerCsv(r.csv);
ok(r.csv.startsWith('﻿') && h.sep === ',' && h.filas[0].length === 10, 'mantiene BOM, separador y columnas');
ok(h.filas[0].join('|') === leerCsv(ES).filas[0].join('|'), 'cabecera intacta (Moodle la usa para reconocer las columnas)');
ok(h.filas[1][4] === '7,50' && h.filas[2][4] === '4,00' && h.filas[4][4] === '9,00', 'notas con coma y 2 decimales, como la hoja');
ok(h.filas[1][0] === 'Participante 101' && h.filas[1][8] === '-', 'no toca identificador ni fechas');
ok(h.filas[1][9] === '<p>Buen trabajo.</p><p>Para mejorar:<br>1. Ortografía<br>2. Orden</p>', 'comentario en HTML con párrafos');
ok(h.filas[2][9] === '<p>Hay que repasar &lt;b&gt;esto&lt;/b&gt; &amp; lo otro &quot;ya&quot;</p>', 'el comentario se escapa (sin HTML inyectado)');
ok(r.rellenadas === 3, `3 rellenadas (${r.rellenadas})`);
ok(r.sinNota.join() === 'Marta Ruiz', 'Marta sin nota: se deja en blanco');
ok(r.noEncontrados.join() === 'Pedro Gil', 'Pedro no está en el cuaderno');
ok(h.filas[3][4] === '' && h.filas[5][4] === '', 'las filas sin nota o sin alumno quedan en blanco');
ok(!r.csv.includes('Participante 101","Ana López García","ana@alumnos.es","Enviado para calificar","",'), 'la fila de Ana ya no tiene la nota vacía');

console.log('== Hoja en valenciano, sobre 100, sin comentarios activados ==');
const VA = [
  'Identificador,Nom complet,Adreça electrònica,Estat,Qualificació,Qualificació màxima,La qualificació es pot canviar,Darrera modificació (tramesa),Darrera modificació (qualificació)',
  'Participant 7,LÓPEZ GARCÍA ANA,ana@alumnos.es,Tramés,,"100,00",Sí,-,-',
].join('\r\n');
r = rellenarHojaMoodle(VA, notas);
h = leerCsv(r.csv);
ok(h.filas[1][4] === '75,00', 'escala la nota a 100 (7,5 → 75,00)');
ok(r.sinComentarios === true, 'avisa de que la tarea no tiene comentarios de retroalimentación');
ok(r.csv.includes('\r\n'), 'mantiene los saltos de línea CRLF');

console.log('== Hoja en inglés con punto decimal, y solo nota ==');
const EN = [
  'Identifier,Full name,Email address,Status,Grade,Maximum Grade,Grade can be changed,Last modified (submission),Last modified (grade),Feedback comments',
  'Participant 9,Luis Pérez,,Submitted,,10.00,Yes,-,-,',
].join('\n');
r = rellenarHojaMoodle(EN, notas, { conComentario: false });
h = leerCsv(r.csv);
ok(h.filas[1][4] === '4.00' && h.filas[1][9] === '', 'punto decimal y sin comentario si no se pide');

console.log('== Errores comprensibles ==');
ok(lanza(() => rellenarHojaMoodle('Nombre;Nota\nAna;7', notas), /no parece una hoja/i), 'un CSV cualquiera → explica cómo descargar la hoja');
ok(lanza(() => rellenarHojaMoodle('Identificador,Nombre completo,Estado\nParticipante 1,Ana López García,-', notas), /Hoja de calificaciones fuera de línea/), 'sin columna de calificación → explica qué activar');
ok(lanza(() => rellenarHojaMoodle('Identificador,Nombre completo,Calificación,Calificación máxima\nParticipante 1,Ana López García,,Apto', notas), /escala/), 'calificación con escala → lo explica');

console.log('== Emparejar nombres ==');
ok(emparejar('Ana López', notas)?.alumno?.apellidos === 'López García', '«Ana López» (sin segundo apellido) → Ana López García');
ok(emparejar('Ana', notas)?.alumno === undefined, '«Ana» sola no se asigna a nadie');
ok(emparejar('LOPEZ GARCIA, ANA', notas)?.alumno?.nombre === 'Ana', 'formato «APELLIDOS, NOMBRE» en mayúsculas y sin tildes');
ok(emparejar('Otra Persona', notas, 'ana@alumnos.es')?.alumno?.apellidos === 'López García', 'por correo si coincide');
ok(emparejar('Ana López', [{ nombre: 'Ana', apellidos: 'López García' }, { nombre: 'Ana', apellidos: 'López' }])?.alumno?.apellidos === 'López', '«Ana López» es Ana López, no Ana López García');
const gemelos = [{ nombre: 'Ana', apellidos: 'López' }, { nombre: 'Ana', apellidos: 'López' }];
ok(emparejar('Ana López', gemelos)?.ambiguo === true, 'dos alumnos con el mismo nombre → ambiguo, no se rellena');

console.log('== Nombres parecidos y correo ==');
const cab = 'Identificador,Nombre completo,Dirección de correo,Calificación,Calificación máxima\n';
const soloAna = [{ nombre: 'Ana', apellidos: 'López García', email: '', nota: 8 }];
r = rellenarHojaMoodle(cab + 'Participante 1,Ana López Pérez,,,10\nParticipante 2,Ana López García,,,10\n', soloAna);
h = leerCsv(r.csv);
ok(h.filas[2][3] === '8.00' && h.filas[1][3] === '' && r.ambiguos.join() === 'Ana López Pérez', 'una tocaya (mismo nombre y primer apellido) no se lleva la nota de la verdadera');
r = rellenarHojaMoodle(cab + 'Participante 1,Ana López,,,10\nParticipante 2,Ana López,,,10\n', soloAna);
ok(r.rellenadas === 0 && r.ambiguos.length === 2, 'dos filas igual de dudosas para la misma alumna → ninguna');
r = rellenarHojaMoodle(cab + 'Participante 1,Ana López Pérez,,,10\n', soloAna);
ok(r.rellenadas === 1 && r.parciales.join() === 'Ana López Pérez', 'si solo está la parecida, se pone pero se avisa para comprobarla');
r = rellenarHojaMoodle(cab + 'Participante 1,Ana López García,otra@x.es,,10\n', [{ ...soloAna[0], email: 'ana@x.es' }]);
ok(r.rellenadas === 0 && r.noEncontrados.length === 1, 'mismo nombre pero otro correo → es otra persona');

console.log('== Comentario y copiar ==');
const t = textoComentario({ comentario_ia: 'Bien', mejoras_ia: 'uno\ndos', mensaje_motivador: '¡Ánimo!' }, 'Bruno');
ok(t === 'Bien\n\nPara mejorar:\n1. uno\n2. dos\n\n¡Ánimo!\n\nBruno', 'compone el comentario como el feedback');
ok(textoComentario({ nota: 5 }) === '', 'nota manual sin comentario → vacío');
ok(tablaParaCopiar(notas.slice(0, 3)) === 'López García, Ana\t7,5\nPérez, Luis\t4\nRuiz, Marta\t', 'tabla para pegar con coma decimal');
ok(tablaParaCopiar([notas[0]], { conComentario: true }).split('\t')[2] === 'Buen trabajo. Para mejorar: 1. Ortografía 2. Orden', 'comentario en una línea al copiar');
ok(comentarioHtml('a\nb') === '<p>a<br>b</p>', 'saltos de línea simples → <br>');
ok(tablaParaCopiar([{ nombre: 'X', apellidos: '=HYPERLINK("http://x")', nota: 5, comentario: '+SUMA(A1)' }], { conComentario: true }) === `'=HYPERLINK("http://x"), X\t5\t'+SUMA(A1)`, 'al copiar, lo que parece fórmula se neutraliza');

console.log(fallos ? `\n${fallos} FALLOS` : '\nTodo correcto');
process.exit(fallos ? 1 : 0);
