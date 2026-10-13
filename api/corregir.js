// Corrige el trabajo de un alumno que el navegador del profesor envía directamente
// (ZIP de Teams/Moodle, escaneo con QR o texto). Cobra 1 corrección; si falla, la devuelve.
import Anthropic from '@anthropic-ai/sdk';
import {
  ErrorHttp, prepararRespuesta, registrarUso, responderError, usuarioDeLaPeticion,
} from '../lib/servidor.js';
import {
  CURSOS_VALIDOS, MAX_ARCHIVOS, MODELO, TIPOS_ARCHIVO_VALIDOS,
  bloqueDeArchivo, cobrarCredito, devolverCredito, leerCorreccion, peticionCorreccion, responderErrorIA,
} from '../lib/correccion.js';

const client = new Anthropic();

// Límites para que una sola corrección no cueste mucho más de lo que se cobra
const LIMITES = { nombre_tarea: 200, rubrica: 6000, texto_tarea: 40000 };
const MAX_TEXTO_CON_ARCHIVOS = 20000;

/** Bloques del trabajo a partir del cuerpo: `texto_tarea` (p. ej. el texto de un Word) y/o
    `archivos` (varios: PDF, fotos o las imágenes de ese Word) o `archivo_base64` (uno) */
function trabajoDelCuerpo(body) {
  const { texto_tarea, archivo_base64, tipo_archivo } = body;
  let archivos = Array.isArray(body.archivos) ? body.archivos : [];
  if (!archivos.length && archivo_base64 && String(archivo_base64).trim() !== '') {
    archivos = [{ base64: archivo_base64, tipo: tipo_archivo }];
  }
  if (archivos.length > MAX_ARCHIVOS) {
    throw new ErrorHttp(400, `Como máximo ${MAX_ARCHIVOS} archivos o páginas por alumno.`);
  }
  for (const a of archivos) {
    if (!a || typeof a.base64 !== 'string' || !a.base64.trim()) throw new ErrorHttp(400, 'Hay un archivo vacío.');
    if (!TIPOS_ARCHIVO_VALIDOS.includes(a.tipo)) {
      throw new ErrorHttp(400, `El campo "tipo_archivo" debe ser uno de: ${TIPOS_ARCHIVO_VALIDOS.join(', ')}`);
    }
  }
  if (texto_tarea !== undefined && texto_tarea !== null && typeof texto_tarea !== 'string') {
    throw new ErrorHttp(400, 'El campo "texto_tarea" debe ser texto.');
  }
  // Texto y archivos en la misma corrección (un Word con imágenes): presupuesto conjunto
  if (archivos.length && texto_tarea && texto_tarea.length > MAX_TEXTO_CON_ARCHIVOS) {
    throw new ErrorHttp(400, `Con archivos, el texto puede tener como máximo ${MAX_TEXTO_CON_ARCHIVOS} caracteres.`);
  }
  const bloques = [];
  if (texto_tarea && texto_tarea.trim() !== '') bloques.push({ type: 'text', text: texto_tarea });
  bloques.push(...archivos.map((a) => bloqueDeArchivo(a.base64, a.tipo)));
  if (!bloques.length) throw new ErrorHttp(400, 'Debes enviar texto_tarea o archivo_base64 (con tipo_archivo).');
  return bloques;
}

export default async function handler(req, res) {
  if (prepararRespuesta(req, res)) return;

  let user = null;
  let creditoConsumido = false;

  try {
    user = await usuarioDeLaPeticion(req);

    const body = req.body ?? {};
    const { curso, nombre_tarea, rubrica } = body;   // sin nombre del alumno: la IA no lo necesita

    const camposFaltantes = ['curso', 'nombre_tarea', 'rubrica']
      .filter((campo) => !body[campo] || String(body[campo]).trim() === '');
    if (camposFaltantes.length > 0) {
      throw new ErrorHttp(400, `Faltan campos obligatorios: ${camposFaltantes.join(', ')}`);
    }
    const demasiadoLargo = Object.entries(LIMITES).find(([campo, max]) => String(body[campo] ?? '').length > max);
    if (demasiadoLargo) {
      throw new ErrorHttp(400, `El campo "${demasiadoLargo[0]}" es demasiado largo (máximo ${demasiadoLargo[1]} caracteres).`);
    }
    const trabajo = trabajoDelCuerpo(body);
    if (!CURSOS_VALIDOS.includes(curso)) {
      throw new ErrorHttp(400, `El campo "curso" debe ser uno de: ${CURSOS_VALIDOS.join(', ')}`);
    }

    // Cobrar antes de llamar a la IA; se devuelve si algo falla.
    const restantes = await cobrarCredito(user.id);
    creditoConsumido = true;

    const response = await client.messages.create(
      peticionCorreccion({ curso, nombre_tarea, rubrica, trabajo }));
    await registrarUso(user.id, 'correccion', MODELO, response.usage, true);
    if (['refusal', 'max_tokens'].includes(response.stop_reason)) creditoConsumido = false;   // la IA trabajó: no se devuelve
    const resultado = leerCorreccion(response);
    return res.status(200).json({ ...resultado, creditos_restantes: restantes });
  } catch (error) {
    if (creditoConsumido) {
      await devolverCredito(user.id, 'corregir');
      await registrarUso(user.id, 'correccion', MODELO, null, false);
    }
    if (responderErrorIA(res, error, 'corregir')) return;
    return responderError(res, error, 'corregir');
  }
}
