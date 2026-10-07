// Utilidades compartidas por las funciones de /api (no es un endpoint).
import { createClient } from '@supabase/supabase-js';

// Mismo proyecto que el frontend. La clave de servicio solo existe en Vercel.
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://fyoyyvzyoohsczceeyde.supabase.co';

let _admin = null;

/** Cliente con service_role: ignora la RLS. Solo en el servidor. */
export function sbAdmin() {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new ErrorHttp(503, 'Servidor sin configurar: falta SUPABASE_SERVICE_ROLE_KEY en Vercel.');
  }
  if (!_admin) {
    _admin = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return _admin;
}

export class ErrorHttp extends Error {
  constructor(status, message, codigo) {
    super(message);
    this.status = status;
    this.codigo = codigo;
  }
}

/** Devuelve el usuario de Supabase a partir de "Authorization: Bearer <token>". */
export async function usuarioDeLaPeticion(req) {
  const cabecera = req.headers.authorization || '';
  const token = cabecera.startsWith('Bearer ') ? cabecera.slice(7) : null;
  if (!token) throw new ErrorHttp(401, 'Inicia sesión para continuar.', 'SIN_SESION');

  const { data, error } = await sbAdmin().auth.getUser(token);
  if (error || !data?.user) throw new ErrorHttp(401, 'La sesión ha caducado. Vuelve a entrar.', 'SIN_SESION');
  return data.user;
}

/** Cabeceras comunes y respuesta a OPTIONS. Devuelve true si la petición ya está respondida. */
export function prepararRespuesta(req, res, metodos = 'POST') {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', `${metodos}, OPTIONS`);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return true;
  }
  if (!metodos.split(',').map((m) => m.trim()).includes(req.method)) {
    res.status(405).json({ error: `Método no permitido. Usa ${metodos}.` });
    return true;
  }
  return false;
}

export function responderError(res, error, contexto) {
  if (error instanceof ErrorHttp) {
    return res.status(error.status).json({ error: error.message, codigo: error.codigo });
  }
  console.error(`[${contexto}] Error:`, error?.message ?? error);
  return res.status(500).json({ error: 'Error interno. Inténtalo de nuevo en unos segundos.' });
}

/** Guarda el consumo de tokens. Nunca rompe la petición si falla. */
export async function registrarUso(userId, tipo, modelo, usage, ok = true) {
  try {
    await sbAdmin().from('uso_ia').insert({
      user_id: userId,
      tipo,
      modelo,
      input_tokens: usage?.input_tokens ?? null,
      output_tokens: usage?.output_tokens ?? null,
      cache_read_tokens: usage?.cache_read_input_tokens ?? null,
      cache_creation_tokens: usage?.cache_creation_input_tokens ?? null,
      ok,
    });
  } catch (e) {
    console.error('[uso_ia] No se pudo registrar:', e?.message ?? e);
  }
}

/** Cuenta registros recientes de un tipo (límite anti-abuso sencillo). */
export async function usoReciente(userId, tipo, minutos) {
  const desde = new Date(Date.now() - minutos * 60_000).toISOString();
  const { count } = await sbAdmin()
    .from('uso_ia')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('tipo', tipo)
    .gte('created_at', desde);
  return count ?? 0;
}

export function origenDeLaPeticion(req) {
  if (req.headers.origin) return req.headers.origin;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return `${proto}://${req.headers.host}`;
}
