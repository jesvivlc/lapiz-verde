// Envía el feedback de una corrección al alumno desde el servidor (Resend).
// El profesor ya no necesita clave propia: responde a su correo (reply-to).
import {
  ErrorHttp, prepararRespuesta, registrarUso, responderError, usoReciente, usuarioDeLaPeticion,
} from '../lib/servidor.js';

const MAX_POR_HORA = 120;
const EMAIL_VALIDO = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

function esc(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function colorNota(nota) {
  if (nota >= 9) return '#D97706';
  if (nota >= 7) return '#15803D';
  if (nota >= 6) return '#0891B2';
  if (nota >= 5) return '#EA580C';
  return '#DC2626';
}

export function construirEmailHtml({ nombre, tarea, resultado: r, firma }) {
  const color = colorNota(Number(r.nota));
  const mejoras = (r.propuestas_mejora || []).map((m, i) =>
    `<li style="margin-bottom:8px;padding:9px 14px;background:#F8FAFC;border-left:3px solid #16A34A;border-radius:6px;font-size:14px;">
      <strong>${i + 1}.</strong> ${esc(m)}</li>`).join('');
  return `<!DOCTYPE html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#F1F5F9;margin:0;padding:24px;">
    <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08);">
      <div style="background:linear-gradient(135deg,#15803D,#0F766E);padding:32px 40px;color:white;">
        <h1 style="margin:0;font-size:22px;font-weight:800;">Feedback de tu tarea</h1>
        <p style="margin:8px 0 0;opacity:.85;font-size:15px;">${esc(tarea)}</p>
      </div>
      <div style="padding:32px 40px;">
        <p style="font-size:16px;color:#0F172A;margin-bottom:6px;">Hola, <strong>${esc(nombre)}</strong>,</p>
        <p style="color:#64748B;font-size:14px;">He revisado tu tarea. Aquí tienes mis comentarios:</p>
        <div style="text-align:center;padding:24px 0;margin:24px 0;background:#F8FAFC;border-radius:12px;">
          <div style="font-size:56px;font-weight:900;color:${color};line-height:1;">${Number(r.nota).toFixed(1)}</div>
          <div style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:${color};margin-top:6px;">${esc(r.nota_texto)}</div>
        </div>
        <h3 style="font-size:12px;text-transform:uppercase;letter-spacing:1px;color:#64748B;margin-bottom:10px;">Comentario</h3>
        <p style="color:#0F172A;line-height:1.8;margin-bottom:24px;font-size:14px;white-space:pre-line;">${esc(r.comentario)}</p>
        <h3 style="font-size:12px;text-transform:uppercase;letter-spacing:1px;color:#64748B;margin-bottom:10px;">Para mejorar</h3>
        <ul style="list-style:none;padding:0;margin:0 0 24px;">${mejoras}</ul>
        <div style="background:linear-gradient(135deg,#F0FDF4,#ECFDF5);border:1px solid #BBF7D0;border-radius:12px;padding:16px 20px;">
          <p style="color:#166534;font-style:italic;margin:0;font-size:14px;line-height:1.7;">✨ ${esc(r.mensaje_motivador)}</p>
        </div>
        ${firma ? `<p style="margin-top:24px;color:#0F172A;font-size:14px;">${esc(firma)}</p>` : ''}
      </div>
    </div></body></html>`;
}

export default async function handler(req, res) {
  if (prepararRespuesta(req, res)) return;
  try {
    const user = await usuarioDeLaPeticion(req);
    if (!process.env.RESEND_API_KEY || !process.env.FROM_EMAIL) {
      throw new ErrorHttp(503, 'El envío de correos todavía no está activado. Usa "Copiar feedback".', 'EMAIL_SIN_CONFIGURAR');
    }

    const { para, nombre_alumno, tarea, resultado, firma } = req.body ?? {};
    if (!para || !EMAIL_VALIDO.test(para)) throw new ErrorHttp(400, `Correo del alumno no válido: ${para || '(vacío)'}`);
    if (!nombre_alumno || !tarea || !resultado || resultado.nota == null) {
      throw new ErrorHttp(400, 'Faltan datos de la corrección.');
    }
    if (await usoReciente(user.id, 'email', 60) >= MAX_POR_HORA) {
      throw new ErrorHttp(429, 'Has enviado muchos correos en la última hora. Inténtalo más tarde.');
    }

    const nombreRemitente = String(firma || '').replace(/[<>"]/g, '').slice(0, 60);
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: nombreRemitente ? `${nombreRemitente} <${process.env.FROM_EMAIL}>` : process.env.FROM_EMAIL,
        to: para,
        reply_to: user.email,
        subject: `Feedback de tu tarea: ${String(tarea).slice(0, 120)}`,
        html: construirEmailHtml({ nombre: nombre_alumno, tarea, resultado, firma }),
      }),
    });
    if (!resp.ok) {
      const e = await resp.json().catch(() => ({}));
      console.error('[enviar-feedback] Resend:', resp.status, e.message);
      throw new ErrorHttp(502, 'El servicio de correo rechazó el envío. Inténtalo de nuevo.');
    }

    await registrarUso(user.id, 'email', null, null, true);
    return res.status(200).json({ enviado: true });
  } catch (error) {
    return responderError(res, error, 'enviar-feedback');
  }
}
