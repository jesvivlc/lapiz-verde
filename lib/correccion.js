// Corrección con IA compartida por todos los canales: ZIP, enlace de entrega,
// escaneo con QR, buzón de correo y corrección nocturna (Batch API).
import Anthropic from '@anthropic-ai/sdk';
import { ErrorHttp, sbAdmin } from './servidor.js';

export const MODELO = 'claude-sonnet-5';
export const MAX_TOKENS = 16000;
export const MAX_ARCHIVOS = 10;

export const CURSOS_VALIDOS = ['1PRI', '2PRI', '3PRI', '4PRI', '5PRI', '6PRI', '1ESO', '2ESO', '3ESO', '4ESO'];
export const TIPOS_ARCHIVO_VALIDOS = ['pdf', 'jpeg', 'jpg', 'png', 'gif', 'webp'];

/** MIME → tipo_archivo ('application/pdf' → 'pdf'); null si no se admite */
export function tipoDeMime(mime) {
  const t = { 'application/pdf': 'pdf', 'image/jpeg': 'jpeg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' }[mime];
  return t ?? null;
}

export const SYSTEM_PROMPT = `Eres un profesor/a corrector/a de tareas de alumnos de Primaria y ESO en España. \
Tu misión es evaluar el trabajo del alumno según la rúbrica proporcionada y ofrecer un feedback \
constructivo, detallado y motivador, adaptado a su edad y nivel. Tu corrección es una propuesta: \
el profesor la revisará antes de que llegue al alumno.

Directrices:
- Sé justo/a y riguroso/a: aplica la rúbrica con criterio
- Adapta el lenguaje a la edad: 1PRI-2PRI (6-7 años), 3PRI-4PRI (8-9), 5PRI-6PRI (10-11), 1ESO-2ESO (12-13), 3ESO-4ESO (14-15)
- En el comentario, cita partes concretas del trabajo del alumno. No inventes citas: si no puedes leer bien el trabajo \
(foto borrosa, letra ilegible, páginas cortadas), dilo claramente en el comentario
- Las propuestas de mejora deben ser específicas, accionables y ordenadas por importancia
- El mensaje motivador debe ser auténtico, cálido y realista — evita frases vacías

Escala de calificaciones:
- Sobresaliente: 9.0 - 10
- Notable: 7.0 - 8.9
- Bien: 6.0 - 6.9
- Suficiente: 5.0 - 5.9
- Insuficiente: 0 - 4.9`;

export const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    nota: {
      type: 'number',
      description: 'Nota numérica entre 0 y 10, con un decimal de precisión',
    },
    nota_texto: {
      type: 'string',
      enum: ['Sobresaliente', 'Notable', 'Bien', 'Suficiente', 'Insuficiente'],
    },
    comentario: {
      type: 'string',
      description:
        'Análisis detallado del trabajo según cada criterio de la rúbrica. ' +
        'Menciona aciertos y puntos débiles con ejemplos concretos del trabajo.',
    },
    propuestas_mejora: {
      type: 'array',
      items: { type: 'string' },
      description: 'Exactamente 3 propuestas de mejora concretas y accionables',
    },
    mensaje_motivador: {
      type: 'string',
      description:
        'Mensaje breve (2-3 frases) dirigido directamente al alumno, cálido y adaptado a su edad.',
    },
    legible: {
      type: 'boolean',
      description: 'false si no se ha podido leer bien el trabajo (foto borrosa, ilegible, incompleta)',
    },
  },
  required: ['nota', 'nota_texto', 'comentario', 'propuestas_mejora', 'mensaje_motivador', 'legible'],
  additionalProperties: false,
};

export function bloqueDeArchivo(base64, tipo) {
  if (tipo === 'pdf') {
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } };
  }
  return {
    type: 'image',
    source: { type: 'base64', media_type: tipo === 'jpg' ? 'image/jpeg' : `image/${tipo}`, data: base64 },
  };
}

/**
 * Parámetros de messages.create para corregir el trabajo de un alumno.
 * `trabajo` es una lista de bloques (uno por archivo o página, en orden).
 */
export function peticionCorreccion({ nombre_alumno, curso, nombre_tarea, rubrica, trabajo }) {
  // Bloque estable para toda la clase (tarea + rúbrica): va primero y se cachea.
  // Lo que cambia por alumno va detrás, para no romper el prefijo cacheado.
  const bloqueRubrica = {
    type: 'text',
    text:
      `**Nombre de la tarea:** ${nombre_tarea}\n` +
      `**Curso:** ${curso}\n\n` +
      `**Rúbrica de corrección:**\n${rubrica}`,
    cache_control: { type: 'ephemeral' },
  };
  const varios = trabajo.length > 1 ? ` (${trabajo.length} archivos o páginas, en orden)` : '';
  const bloqueAlumno = { type: 'text', text: `Corrige la tarea de **${nombre_alumno}**. Su trabajo${varios}:` };
  return {
    model: MODELO,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    output_config: { format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
    messages: [{ role: 'user', content: [bloqueRubrica, bloqueAlumno, ...trabajo] }],
  };
}

/** Saca la corrección de la respuesta del modelo, o lanza un error comprensible */
export function leerCorreccion(message) {
  if (message.stop_reason === 'refusal') {
    throw new ErrorHttp(422, 'El modelo no pudo procesar esta corrección. Revisa el contenido enviado.');
  }
  if (message.stop_reason === 'max_tokens') {
    throw new ErrorHttp(502, 'La corrección salió demasiado larga y se cortó. Inténtalo de nuevo.');
  }
  const textBlock = message.content.find((b) => b.type === 'text');
  if (!textBlock) throw new Error('Respuesta inesperada del modelo: sin bloque de texto');
  return JSON.parse(textBlock.text);
}

/** Cobra una corrección. Devuelve el saldo restante o lanza 402 si no queda. */
export async function cobrarCredito(userId) {
  const { data: restantes, error } = await sbAdmin().rpc('consumir_credito', { p_user: userId });
  if (error) throw error;
  if (restantes === null) {
    throw new ErrorHttp(402, 'No te quedan correcciones. Compra un bono para seguir.', 'SIN_CREDITOS');
  }
  return restantes;
}

export async function devolverCredito(userId, contexto) {
  const { error } = await sbAdmin().rpc('devolver_credito', { p_user: userId });
  if (error) console.error(`[${contexto}] No se pudo devolver el crédito:`, error.message);
}

/** Errores del SDK de Anthropic → respuesta para el profesor. Devuelve true si ha respondido. */
export function responderErrorIA(res, error, contexto) {
  if (error instanceof Anthropic.RateLimitError) {
    res.status(429).json({ error: 'Demasiadas correcciones a la vez. Espera unos segundos.' });
    return true;
  }
  if (error instanceof Anthropic.BadRequestError) {
    console.error(`[${contexto}] BadRequest:`, error.message);
    res.status(400).json({ error: 'El archivo no se pudo procesar (¿formato o tamaño?).' });
    return true;
  }
  if (error instanceof Anthropic.AuthenticationError) {
    console.error(`[${contexto}] Clave de Anthropic inválida`);
    res.status(500).json({ error: 'Error de configuración del servidor.' });
    return true;
  }
  return false;
}

