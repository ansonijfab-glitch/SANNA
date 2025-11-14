import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import OpenAI from 'openai';
import QRCode from 'qrcode';
import fetch from 'node-fetch';
import { google } from 'googleapis';
import { DateTime } from 'luxon';
import pdf from 'pdf-parse';


// Baileys (WhatsApp QR)
import * as Baileys from '@whiskeysockets/baileys';
const {
  default: makeWASocket,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  downloadContentFromMessage,
  jidNormalizedUser,
} = Baileys;

import pino from 'pino';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Estado de WhatsApp para el panel
let waQRDataUrl = null;       // data:image/png;base64,....
let waQRUpdatedAt = 0;        // Date.now()
let waUserJid = null;         // '5731xxxxxxx@s.whatsapp.net'
let waUserName = null;        // nombre opcional del dispositivo
// ===== Logo (icono solo) como SVG servido por Express =====
const LOGO_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180" viewBox="0 0 900 900">
  <defs>
    <linearGradient id="g1" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#3C57C7"/>
      <stop offset="100%" stop-color="#64B5FF"/>
    </linearGradient>
    <linearGradient id="g2" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#F27AAE"/>
      <stop offset="50%" stop-color="#F03C99"/>
      <stop offset="100%" stop-color="#7B61FF"/>
    </linearGradient>
  </defs>
  <g transform="translate(50,50)">
    <circle cx="400" cy="380" r="260" fill="none" stroke="url(#g1)" stroke-width="22"/>
    <circle cx="400" cy="380" r="220" fill="none" stroke="url(#g2)" stroke-width="18"/>
    <rect x="370" y="240" width="60" height="120" rx="10" fill="#3C57C7"/>
    <rect x="340" y="270" width="120" height="60" rx="10" fill="#3C57C7"/>
    <path d="M240,470 C320,570 480,590 560,520" fill="none" stroke="url(#g2)" stroke-width="20" stroke-linecap="round"/>
    <circle cx="560" cy="520" r="20" fill="#F03C99"/>
  </g>
</svg>`;
// ESM dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(bodyParser.json());

// =================== ENV / CONFIG ===================
const ZONE = 'America/Bogota';
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID;
const MIN_BOOKING_DATE_ISO = '2025-11-12'; // desde el 12 de noviembre en adelante
//  // OJO: 99 “apaga” el bloqueo; también puedes eliminar su uso (ver paso 2)
 const _MONTH_CUTOFF_DAY = 20;
 // Amplía el rango por defecto (por ejemplo, 60-90 días)


const DEFAULT_RANGE_DAYS = Number(process.env.DEFAULT_RANGE_DAYS || 21);
const MAX_DAYS_TO_SHOW   = Number(process.env.MAX_DAYS_TO_SHOW   || 5);
const MAX_SLOTS_PER_DAY  = Number(process.env.MAX_SLOTS_PER_DAY  || 4);
// Fecha mínima SOLO para controles virtuales
const MIN_VIRTUAL_CONTROL_DATE_ISO = '2025-12-01';


const PRIORITY_LOCK_MINUTES = parseInt(process.env.PRIORITY_LOCK_MINUTES || '60', 10);

// ====== PRIORITY CONFIG (Isabel 3 : Deivis 1) ======
const STAFF_ISABEL_PHONE = process.env.STAFF_ISABEL_PHONE || '+57 3108611759'; // ← PÓN LA REAL
const STAFF_DEIVIS_PHONE = process.env.STAFF_DEIVIS_PHONE || '+57 3108611759'; // ya la tienes


// === Objetivo y tope: 30 días hábiles, dentro de 30 días calendario ===
const HABILES_TARGET          = Number(process.env.HABILES_TARGET || 30);
const CALENDAR_HORIZON_DAYS   = Number(process.env.CALENDAR_HORIZON_DAYS || 30);
const AVAIL_COOLDOWN_SEC      = 0; // evita silencios

function firstAllowedStartSafe(now = DateTime.now().setZone(ZONE)) {
  const base = now.startOf('day');
  if (typeof MIN_BOOKING_DATE_ISO === 'string' && MIN_BOOKING_DATE_ISO) {
    const min = DateTime.fromISO(MIN_BOOKING_DATE_ISO, { zone: ZONE }).startOf('day');
    return (min.isValid && min > base) ? min : base;
  }
  return base;
}

function phoneToJid(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  // Para staff siempre usar "s.whatsapp.net"
  return digits ? `${digits}@s.whatsapp.net` : null;
}
const STAFF = {
  isabel: { name: 'Isabel', phone: STAFF_ISABEL_PHONE, jid: phoneToJid(STAFF_ISABEL_PHONE) },
  deivis: { name: 'Deivis', phone: STAFF_DEIVIS_PHONE, jid: phoneToJid(STAFF_DEIVIS_PHONE) },
};

// ====== Helpers

// === Helper: extrae celular CO en formato E.164 (+57 3XXXXXXXXX) ===
function extractPhoneFromText(s = '') {
  if (!s) return null;
  // Quitamos separadores comunes
  const cleaned = String(s).replace(/[\s\-\(\)\.\u00A0]/g, '');
  // Acepta +57 3XXXXXXXXX, 57 3XXXXXXXXX, o 3XXXXXXXXX aislado.
  // Evita fechas/horas: exige 3 + 9 dígitos (móviles en CO)
  const re = /(?:\+57|57)?(3\d{9})(?!\d)/g;
  let m;
  while ((m = re.exec(cleaned))) {
    // Si vino sin prefijo, lo agregamos
    const local = m[1]; // 3XXXXXXXXX
    return `+57${local}`;
  }
  return null;
}

// Secuencia 3:1 → Isabel, Isabel, Isabel, Deivis
let priorityCounter = 0;
if (!process.env.OPENAI_API_KEY) console.warn('⚠️ Falta OPENAI_API_KEY');
if (!CALENDAR_ID) console.warn('⚠️ Falta GOOGLE_CALENDAR_ID (email del calendario)');

// OpenAIFF
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ====== Google Calendar auth (con path sanitizado) ======
function loadServiceAccount() {
  const jsonRaw = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (jsonRaw) {
    try { return JSON.parse(jsonRaw); } catch { console.error('❌ GOOGLE_APPLICATION_CREDENTIALS_JSON inválido'); }
  }
  const rawPath = (process.env.GOOGLE_APPLICATION_CREDENTIALS || '').replace(/[\r\n]/g, '').trim();
  if (!rawPath) return null;
  const credsPath = path.isAbsolute(rawPath) ? rawPath : path.resolve(process.cwd(), rawPath);
  if (!fs.existsSync(credsPath)) {
    console.error('❌ No encuentro el JSON de la cuenta de servicio en:', credsPath);
    return null;
  }
  return JSON.parse(fs.readFileSync(credsPath, 'utf8'));
}
const sa = loadServiceAccount();
if (!sa) console.warn('⚠️ No se pudieron cargar credenciales de Google (revisa GOOGLE_APPLICATION_CREDENTIALS o *_JSON).');

const auth = new google.auth.GoogleAuth({
  credentials: sa || undefined,
  keyFile: sa ? undefined : (process.env.GOOGLE_APPLICATION_CREDENTIALS || ''),
  scopes: ['https://www.googleapis.com/auth/calendar'],
});
const calendar = google.calendar({ version: 'v3', auth });

// ============== PROMPT MAESTRO ==============
const systemPrompt = `
Eres **Sana**, asistente virtual de la consulta de mastología del Dr. Juan Felipe Arias.


MISIÓN
- Recibir pacientes, hacer un triage clínico básico y ayudar a agendar o escalar al equipo humano.
- Cuando necesites interactuar con el sistema (disponibilidad, crear cita, guardar datos, cancelar), usa SIEMPRE un bloque de código:
  \`\`\`action
  {"action":"...","data":{...}}
  \`\`\`
  y además responde con texto natural para el paciente.
- **Nunca declares una cita como "confirmada" o "agendada" por tu cuenta**. Primero emite el bloque \`\`\`action\`\`\`, espera la respuesta del sistema (backend) y SOLO después entrega el resumen al paciente.

ESTILO
- Saluda con calidez y pide el **nombre completo** al inicio.
- Habla con claridad y brevedad, sin emojis ni adornos.
- Dirígete siempre al paciente por su **nombre**.
- Mantente en el tema clínico y de agenda; si el paciente se desvía, redirígelo con respeto.
- No mezcles datos de otros pacientes ni recuerdes conversaciones de otros chats.

PROTOCOLO PRIORITARIO — BI-RADS 4 o 5
- Si detectas por texto o porque el sistema te lo indica que el último estudio tiene **BI-RADS 4 o 5**:
  1) **No consultes horarios ni intentes agendar cita.**
  2) No ofrezcas “buscar disponibilidad”.
  3) Explica con lenguaje claro y sin alarmar que, por la categoría del estudio, se requiere una revisión prioritaria directa con el equipo humano.
  4) Indica de forma amable el número de contacto de nuestro asesor *Deivis* al \${STAFF_DEIVIS_PHONE}.
  5) No intentes seguir un flujo normal de agenda después de eso.

FLUJO GENERAL (cuando NO hay prioridad activa)
1) **Nombre completo.**
2) **Motivo de consulta** (elige una sola opción, no inventes más):
   - **Primera vez**
   - **Control presencial**
   - **Control de resultados virtual**
   - **Biopsia guiada por ecografía** (solo particular)
   - **Programación de cirugía** → explica brevemente que este tipo de caso lo maneja directamente el equipo humano y entrega el número de Deivis \${STAFF_DEIVIS_PHONE}.
   - **Actualización de órdenes** → también deriva a equipo humano con el número de Deivis.

3) *Seguro/entidad de salud*:
   - Atendemos pólizas y prepagadas: *Sudamericana, Colsanitas, Medplus, Bolívar, Allianz, Colmédica, Coomeva* y también *particular*.
   - *Solo debe rechazarse el plan “Coomeva Preferente”*.
   - Ejemplos que *SÍ se atienden* y NO deben rechazarse:
     - “Coomeva oro”
     - “Coomeva oro plus”
     - “Coomeva tradicional”
     - “Coomeva medicina prepagada”
   - Si el paciente solo dice “Coomeva” sin indicar el plan, pregunta:
     > “¿Tu plan con Coomeva es Preferente u otro tipo de plan?”
   - Si el paciente dice explícitamente que su plan es *Coomeva Preferente*, ahí SÍ debes indicar que no se atiende y remitir a Deivis.
   - *No confundas "oro", "oro plus" u otros planes con “Preferente”*. Solo la palabra “Preferente” significa que no se atiende.
   - *No atendemos EPS* (indícalo con cortesía; puedes orientar a particular).

4) **Estudios de imagen y síntomas**:
   - Pregunta si tiene estudios recientes (mamografía, ecografía, resonancia) y la **categoría BI-RADS**.
   - Si el paciente envía un PDF, el sistema puede informarte el resumen y la categoría BI-RADS: en ese caso, **no vuelvas a pedir BI-RADS**; úsala y continúa el flujo.
   - Si BI-RADS 1–2: mensaje tranquilizador y flujo de agenda normal.
   - Si BI-RADS 3: prioriza dentro de los próximos días válidos sin inventar urgencias extremas.
   - Si refiere **masa/nódulo < 3 meses** sin BI-RADS 4–5: considera el caso prioritario dentro de las ventanas reales, pero sin violar reglas de agenda.

5) **Datos obligatorios antes de CREAR una cita (núcleo)**:
   Para cualquier tipo de cita, antes de emitir un \`"action":"crear_cita"\` necesitas como mínimo:
   - **Nombre y apellido**
   - **Cédula**
   - **Entidad de salud** (o “particular”) — si es Coomeva Preferente, NO se agenda.
   - **Correo electrónico**
   - **Celular**
   - **Dirección**
   - **Ciudad**
   Está permitido consultar disponibilidad aunque falte alguno de estos datos, pero **NO debes generar \`crear_cita\` hasta que el núcleo esté completo**.

6) Datos para “Primera vez”:
   - Para la primera consulta (historia clínica inicial) debes PEDIR SIEMPRE, en un solo mensaje, TODOS estos datos:
     - Nombre completo
     - Cédula
     - Correo electrónico
     - Celular
     - Dirección
     - Ciudad
     - Fecha de nacimiento
     - Tipo de sangre
     - Estado civil
     - Antecedentes de estudios mas recientes (si tuvo, cuándo y dónde)
   - No digas que alguno de estos datos es “opcional”, ni uses frases como “si deseas”, “si quieres puedes incluir…”, “si es posible”.
   - Puedes seguir consultando disponibilidad aunque falten algunos campos, pero en tus mensajes al paciente SIEMPRE pide todos los datos de la lista.


7) **Disponibilidad y agendamiento**:
   - No inventes horarios ni supongas huecos.
   - No le preguntes al paciente “¿qué día prefieres?” ni “¿consulto un rango de fechas?”.
   - Cuando hables de disponibilidad, usa frases del estilo:
     - “Voy a revisar el próximo cupo disponible para tu tipo de consulta.”
   - El sistema (backend) se encargará de buscar **el primer cupo disponible más cercano** dentro de las ventanas reales. No necesitas construir listas de muchos días ni horarios.
   - Si el paciente pide explícitamente disponibilidad de un día concreto o “los próximos días”, puedes:
     - Responder en lenguaje natural que revisarás el próximo cupo disponible.
     - Y, SI Y SOLO SI el sistema te lo indicó en las instrucciones de sistema, usar:
       \`\`\`action
       {"action":"consultar_disponibilidad","data":{"tipo":"Control presencial","fecha":"2025-10-06"}}
       \`\`\`
       o
       \`\`\`action
       {"action":"consultar_disponibilidad_rango","data":{"tipo":"Control presencial","desde":"2025-10-01"}}
       \`\`\`
   - No ofrezcas varias horas ni varios días a la vez en tus propios textos. El sistema te devolverá un cupo cercano; tú solo debes ayudar al paciente a aceptarlo o rechazarlo.
   - Si el paciente rechaza el horario (“no quiero esa”, “no me sirve esa hora”, “¿no tienes otra?”), explícale que por ahora es el único cupo disponible y que puede escribir más adelante si desea revisar nuevamente.

8) **Creación de cita (crear_cita)**:
   - Para **Primera vez**:
     - Asegúrate de tener todos los datos del núcleo (nombre, cédula, entidad, correo, celular, dirección, ciudad).
     - Luego emite un bloque \`\`\`action\`\`\` con \`"action":"crear_cita"\` usando el horario que el sistema te haya dado (no lo inventes).
   - Para **Control presencial** o **Control de resultados virtual**:
     - Si ya tienes el núcleo completo, puedes emitir directamente \`"action":"crear_cita"\` cuando el paciente acepte la hora.
   - No confirmes la cita en texto hasta que el sistema responda que fue creada.

9) **Confirmación al paciente (DESPUÉS de la respuesta del sistema)**:
   - Cuando el sistema indique que la cita se creó correctamente, entrega un resumen breve:
     - Fecha (ej. “1 de diciembre”)
     - Hora (formato HH:mm, 24 horas)
     - Lugar: Clínica Portoazul, piso 7, consultorio 707, Barranquilla.
   - Añade recordatorios:
     - Llegar 15 minutos antes.
     - Llevar todos los estudios previos impresos.
     - No está permitido grabar audio o video durante la consulta sin autorización.

CANCELACIÓN / REPROGRAMACIÓN
- Por defecto, las cancelaciones y reprogramaciones se gestionan a través del equipo humano (Deivis). Puedes orientar al paciente a comunicarse al número +57 3108611759.
- Solo si el sistema te da instrucciones específicas (por ejemplo, con mensajes de sistema que describen el flujo de \`"cancelar_cita"\`), sigue ese flujo:
  1) Pide **cédula**.
  2) Pide **fecha (AAAA-MM-DD)** y **hora exacta (HH:mm)**.
  3) Emite SOLO un bloque:
     \`\`\`action
     {
       "action": "cancelar_cita",
       "data": { "cedula": "123...", "fecha": "2025-11-19", "hora": "15:15" }
     }
     \`\`\`
  - No mezcles texto y JSON en el mismo mensaje.
  - No confirmes cancelación en texto hasta que el sistema confirme o indique error.
  - Si el sistema indica que no se pudo cancelar, deriva de forma amable a Deivis con el número +57 3108611759.

AGENDA (VENTANAS Y LÍMITES DE HORARIO)
- **Lugar**: Clínica Portoazul, piso 7, consultorio 707, Barranquilla.
- **Duraciones**:
  - Primera vez: 20 minutos.
  - Control presencial: 15 minutos.
  - Control virtual (resultados): 10 minutos.
  - Biopsia guiada por ecografía: 30 minutos (solo particular).
- **Reglas de días y ventanas (no romper)**:
  - **Martes:** sin consulta (rechaza cortésmente y ofrece otro día válido).
  - **Lunes (presencial):** 08:00–11:30 y 14:00–17:30.
  - **Miércoles/Jueves (presencial):** 14:00–16:30.
  - **Viernes presencial:** 08:00–11:30 (no hay presencial en la tarde).
  - **Viernes virtual:** 14:00–16:30 (solo controles virtuales).
- **Límites adicionales**:
  - No agendar fechas **pasadas**.
  - No agendar en **martes**.
  - No agendar fuera de las ventanas de horario indicadas.

COSTOS (si el paciente pregunta)
- Consulta de mastología: 350.000 COP.
- Biopsia guiada por ecografía (solo particular): 800.000 COP (incluye patología; no incluye consulta de lectura de patología).
- Medios de pago: efectivo y transferencia.

HANDOFF HUMANO (hablar con doctor / secretaria / dudas complejas)
- Si el paciente pide explícitamente hablar con el **doctor**, la **secretaria**, “una persona real” o solicita aclaraciones que por seguridad es mejor manejar directamente (por ejemplo, detalles muy específicos de su historia clínica, dudas legales o administrativas complejas):
  - No intentes resolver todo por tu cuenta.
  - Explica con respeto que su caso será revisado por el equipo humano.
  - Entrega el número de contacto de *Deivis* +57 3108611759 y/o indica que un asesor se comunicará con él.

REGLAS DURAS (NO ROMPER)
- No confirmes citas ni cancelaciones en texto sin la respuesta del sistema.
- No inventes horarios ni rangos de fechas: la disponibilidad real viene SIEMPRE del sistema.
- No vuelvas a pedir la categoría BI-RADS si ya la conoces por texto o PDF.
- No agendes en martes, ni en fechas pasadas, ni fuera de las ventanas de horario.
- No mezcles texto del paciente con JSON en el mismo mensaje: los bloques \`\`\`action\`\`\` deben contener únicamente JSON.
- Respeta las reglas de Coomeva Preferente: no se agenda ni se promete atención con ese plan; deriva a Deivis.
`;


// ============== SESIONES POR USUARIO ==============
// Map<fromJid, {history, lastSystemNote, updatedAtISO, priority, cancelGuard, birads}>
const sessions = new Map();
const SESSION_TTL_MIN = 60;
const CANCEL_ATTEMPT_WINDOW_MIN = 60;
const CANCEL_ATTEMPT_MAX = 3;

function getSession(userId) {
  const now = DateTime.now().setZone(ZONE);
  let s = sessions.get(userId);
  const expired =
    s && now.diff(DateTime.fromISO(s.updatedAtISO || now.toISO())).as('minutes') > SESSION_TTL_MIN;

  if (!s || expired) {
    s = {
      history: [{ role: 'system', content: systemPrompt }],
      lastSystemNote: null,
      updatedAtISO: now.toISO(),
      priority: null,
      cancelGuard: { windowStartISO: now.toISO(), attempts: 0 },
      birads: null,
      tipoActual: null,
      // NUEVO:
      jid: userId,
      rangeLockHabiles: HABILES_TARGET, // objetivo fijo p/ todos los JID
    };
    sessions.set(userId, s);
  }

  // Asegura el lock también para sesiones viejas ya existentes
  if (!s.rangeLockHabiles || s.rangeLockHabiles !== HABILES_TARGET) {
    s.rangeLockHabiles = HABILES_TARGET;
  }

  return s;
}


function touchSession(session) {
  // Refresca tiempo de expiración a 30 minutos
  const TTL_MINUTES = 30;
  session.expiresAt = Date.now() + TTL_MINUTES * 60 * 1000;
}

function isSessionExpired(session) {
  return session.expiresAt && Date.now() > session.expiresAt;
}

function capHistory(session, max = 40) {
  if (session.history.length > max) {
    const firstSystem = session.history.findIndex(m => m.role === 'system');
    const base = firstSystem >= 0 ? [session.history[firstSystem]] : [];
    session.history = base.concat(session.history.slice(-(max - base.length)));
  }
}
function resetCancelGuardIfWindowExpired(session) {
  const now = DateTime.now().setZone(ZONE);
  const start = DateTime.fromISO(session.cancelGuard?.windowStartISO || now.toISO());
  if (now.diff(start, 'minutes').minutes >= CANCEL_ATTEMPT_WINDOW_MIN) {
    session.cancelGuard = { windowStartISO: now.toISO(), attempts: 0 };
  }
}

// ============== HELPERS (agenda) ==============
const norm = (s = '') => String(s || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim();

function duracionPorTipo(tipo = '') {
  const t = norm(tipo);
  if (t.includes('primera')) return 20;
  if (t.includes('control presencial')) return 15;
  if (t.includes('control virtual')) return 15;
  if (t.includes('biopsia')) return 30;
  return 15;
}
// ↓ Debajo de: const norm = (...) => { ... }

// Detecta tipo explícito por texto del usuario
function guessTipo(text = '') {
  const s = norm(text);
  if (!s) return null;

  // Biopsia
  if (/(biops)/.test(s)) return 'Biopsia guiada por ecografía';

  // Control virtual
  if (/(virtual|en\s*linea|en\s*l[ií]nea|online)/.test(s)) return 'Control virtual';

  // Primera vez / primera consulta
  if (/(primera\s*vez|primer[ao]\s*consulta|nueva\s*(cita|consulta))/i.test(s)) {
    return 'Primera vez';
  }

  // Control presencial (solo si dicen "control" y no “virtual”)
  if (/\bcontrol\b/.test(s) && !/virtual/.test(s)) return 'Control presencial';

  return null;
}

// ====== PRIORIDAD: configuración y helpers ======
// Mensaje que verá el paciente mientras el chat está bloqueado
const PRIORITY_LOCK_MESSAGE = '🔴 Estamos gestionando tu atención prioritaria. Un asesor te contactará en breve.';
const priorityMuteTimers = new Map(); 
function choosePrimaryContact() {
  const t = PRIORITY_TARGETS[priorityCounter % PRIORITY_TARGETS.length];
  priorityCounter++;
  return t;
}

function pickRandom(arr) { return arr[Math.floor(Math.random()*arr.length)]; }

// Plantillas para el staff (varía texto, mantén corto y con datos útiles)
const PRIORITY_ALERT_TEMPLATES = [
  '🚨 Prioridad BI-RADS {birads}\nPaciente: {paciente}\nJID: {jid}\n{fechaHora}\nFuente: {fuente}',
  '🔴 Alerta BI-RADS {birads}\nPaciente: {paciente}\nJID: {jid}\n{fechaHora}\nFuente: {fuente}',
  '⚠️ Caso prioritario (BI-RADS {birads})\nPaciente: {paciente}\nJID: {jid}\n{fechaHora}\nFuente: {fuente}',
];

function renderPriorityAlert(tpl, ctx) {
  const map = {
    birads: ctx.birads ?? '?',
    paciente: ctx.paciente ?? '',
    jid: ctx.jid ?? '',
    fechaHora: ctx.fechaHora ?? '',
    fuente: ctx.fuente ?? '',
  };
  return String(tpl || '').replace(/\{(birads|paciente|jid|fechaHora|fuente)\}/g, (_, k) => map[k] ?? '');
}

async function showAvailabilityNow(session, now, firstAllowedStartFn, monthPolicyFromFn) {
  // 0) Asegurar objeto paciente
  const p = ensurePatient(session);

  
  // 🔐 Re-normalizar entidad por si había quedado algo raro (ej: "Hola")
  const entidadCanon = normalizeEntidadSalud(p.entidad_salud);
  if (!entidadCanon) {
    p.entidad_salud = null;
    return (
      'Antes de revisar horarios, necesito saber con qué entidad de salud cuentas ' +
      'o si prefieres atenderte como particular. ' +
      'Por ejemplo: "Colsanitas", "Medplus", "Coomeva oro plus" o "Particular".'
    );
  }
  // Guardamos la forma canon
  p.entidad_salud = entidadCanon;

  // 2) Tipo efectivo normalizado
  const tipoRaw = session.tipoActual || guessTipo(session.lastUserText || '') || 'Control presencial';
  const tipo = normalizeTipo(tipoRaw);
  session.tipoActual = tipo;

  const nowLocal = now.setZone(ZONE);

  // 3) Punto base según reglas generales
  let baseStart = (typeof firstAllowedStartFn === 'function')
    ? firstAllowedStartFn(nowLocal)
    : firstAllowedStartSafe(nowLocal);

  // 4) Clamp especial para controles virtuales: nunca antes de 1 de diciembre
  if (/virtual/i.test(tipo)) {
    const minVirtual = DateTime.fromISO(MIN_VIRTUAL_CONTROL_DATE_ISO, { zone: ZONE }).startOf('day');
    if (minVirtual.isValid && baseStart < minVirtual) {
      baseStart = minVirtual;
    }
  }

  // 5) Política de mes / corte
  const policy = (typeof monthPolicyFromFn === 'function')
    ? monthPolicyFromFn(baseStart.toISODate())
    : monthPolicyFrom(baseStart.toISODate());

  const startISO = policy.start.toISODate();
  const dias     = Math.min(policy.diasMax || 30, CALENDAR_HORIZON_DAYS);

  // 6) Buscar disponibilidad real en Calendar
  const raw = await disponibilidadPorDias({ tipo, desdeISO: startISO, dias });

  const ordered = (raw || [])
    .filter(d => (d.slots || []).length > 0)
    .sort((a, b) => a.fecha.localeCompare(b.fecha));

  if (!ordered.length) {
    return 'Por ahora no tengo cupos disponibles. Intenta de nuevo más tarde.';
  }

  const firstDay  = ordered[0];
  const firstSlot = (firstDay.slots || [])[0];
  if (!firstSlot) {
    return 'Por ahora no tengo cupos disponibles. Intenta de nuevo más tarde.';
  }

  // 7) Cachear oferta en sesión (un solo día / una sola hora)
  session.lastOffered = {
    tipo,
    days: [{
      fechaISO: firstDay.fecha,
      slots: [{ inicio: firstSlot.inicio, fin: firstSlot.fin }]
    }],
    singleDay: true
  };

  const fechaTxt = fmtFechaHumana(firstDay.fecha);
  const horaTxt  = fmtHoraHumana(firstSlot.inicio);

  return (
    `Tengo un cupo disponible muy cercano:\n` +
    `📅 *${fechaTxt}* a las *${horaTxt}*.\n\n` +
    `¿Deseas tomar esa hora?\n` +
    `Si no te sirve, te comento que por ahora es la única disponible para ese día.`
  );
}


// Requiere: getSession, sendWhatsAppText, DateTime, ZONE, panelState, contactNames.
async function triggerPriorityEscalation(jid, opts = {}) {
  const {
    source = 'texto',            // 'texto' | 'pdf'
    birads = '4',                // '4' | '5'
    patientPhone,                // celular del paciente (ideal en E.164, ej: +573001234567)
    patientName,                 // opcional
    snippet                      // opcional (texto corto de contexto)
  } = opts;

  // ===== Config de staff =====
  const ISABEL_PHONE = (process.env.ISABEL_PHONE || '+57 3007666588').trim();
  const DEIVIS_PHONE = (process.env.DEIVIS_PHONE || '+57 3108611759').trim();

  // Helpers locales y autosuficientes
  const digitsOnly = (s='') => String(s).replace(/\D/g, '');

  // Normaliza a E.164 CO (solo móviles: 3 + 9 dígitos)
  function toE164Colombia(raw = '') {
    const s = String(raw || '').replace(/[\s\-().]/g, '');
    // +57 3XXXXXXXXX
    const m1 = s.match(/^\+57(3\d{9})$/);
    if (m1) return `+57${m1[1]}`;
    // 57 3XXXXXXXXX
    const m2 = s.match(/^57(3\d{9})$/);
    if (m2) return `+57${m2[1]}`;
    // 3XXXXXXXXX
    const m3 = s.match(/^(3\d{9})$/);
    if (m3) return `+57${m3[1]}`;
    return null;
  }

  // JID de WhatsApp a partir del teléfono (E.164 o variantes comunes)
  function phoneToJid(raw = '') {
    const e164 = toE164Colombia(raw);
    if (!e164) return null;
    const msisdn = digitsOnly(e164); // ej: 573001234567
    return `${msisdn}@s.whatsapp.net`;
  }

  // Pick 3:1 → 75% Isabel, 25% Deivis
  function pickStaffByWeight() {
    return (Math.random() < 0.75)
      ? { name: 'Isabel', phone: ISABEL_PHONE }
      : { name: 'Deivis', phone: DEIVIS_PHONE };
  }

  const session = getSession(jid);
  const now = DateTime.now().setZone(ZONE);

  // Validación estricta: SIN teléfono válido, no escalamos (el caller debe pedirlo antes)
  const phoneE164 = toE164Colombia(patientPhone || '');
  if (!phoneE164) {
    console.log(`[PRIORITY] 🚫 Sin teléfono válido. No se escala. Esperando número del paciente… (jid=${jid})`);
    // Marcamos estado de espera (por si no estaba)
    session.priority = {
      active: true,
      status: 'waiting_phone',
      source,
      birads: String(birads || ''),
      lockUntilISO: null
    };
    // Aquí NO enviamos mensaje (se hace fuera) para no duplicar prompts.
    return;
  }

  // Si ya fue escalado y está bloqueado, no duplicar
  if (session.priority?.active && session.priority.status === 'submitted') {
    console.log(`[PRIORITY] ⚠️ Ya escalado y bloqueado: jid=${jid} → lockUntil=${session.priority.lockUntilISO}`);
    return;
  }

  const patientLabel = (patientName || contactNames.get(jid) || jid.split('@')[0]);
  const route = pickStaffByWeight();
  const routeJid = phoneToJid(route.phone);
  if (!routeJid) {
    console.error(`[PRIORITY] ❌ Staff phone inválido para ${route.name}: "${route.phone}"`);
    return;
  }

  // Mensaje al staff
  const staffMsg =
    `🔴 *PRIORIDAD* (BI-RADS ${birads.toString().toUpperCase()})\n` +
    `Paciente: ${patientLabel}\n` +
    `Celular: ${phoneE164}\n` +
    `Origen: ${source}\n` +
    `JID: ${jid}\n` +
    (snippet ? `Nota: ${String(snippet).slice(0, 200)}\n` : '') +
    `\nPor favor contactar de inmediato y coordinar atención prioritaria.`;

  // Enviar al staff seleccionado
  try {
    await sendWhatsAppText(routeJid, staffMsg);
    console.log(`[PRIORITY] ✅ Aviso enviado a ${route.name} (${routeJid}) — paciente ${phoneE164}.`);
  } catch (e) {
    console.error(`[PRIORITY] ❌ Error enviando a ${route.name} (${routeJid}):`, e);
  }

  // Acuse breve al paciente
  try {
    await sendWhatsAppText(
      jid,
      `Hemos escalado tu caso (BI-RADS ${birads}). Nuestra asesora ${route.name} te contactará al ${phoneE164} en breve.\n` +
      `Mientras tanto, pausaré las respuestas automáticas aquí.`
    );
    console.log(`[PRIORITY] 📩 Aviso breve enviado al paciente (${phoneE164}).`);
  } catch (e) {
    console.error('[PRIORITY] ❌ Error enviando acuse al paciente:', e);
  }

  // Bloquear IA por 60 minutos para este chat
  const lockUntil = now.plus({ minutes: 60 }).toISO();
  session.priority = {
    active: true,
    status: 'submitted',
    source,
    birads: String(birads || ''),
    phone: phoneE164,
    staff: route.name,
    lockUntilISO: lockUntil
  };
  panelState.aiDisabledChats.add(jid);

  console.log(`[PRIORITY] 🔒 IA APAGADA por 60 min (BI-RADS ${birads}, source=${source}) — paciente: ${phoneE164} (${patientLabel})`);
  console.log(`[PRIORITY] 🧭 Ruta: ${route.name} | lockUntil=${lockUntil}`);
}


function ventanasPorDia(date, tipo = '') {
  const dow = date.weekday; // 1=Lun ... 7=Dom
  const t = norm(tipo);
  const v = [];
  const H = (h, m = 0) => date.set({ hour: h, minute: m, second: 0, millisecond: 0 });
  const push = (start, end) => { if (end > start) v.push({ start, end }); };

  // Martes sin consulta
  if (dow === 2) return v;

  // Lunes (solo presencial)
  if (dow === 1) {
    if (t.includes('control virtual')) return v; // lunes solo presencial
    push(H(8, 0), H(11, 30));
    push(H(14, 0), H(17, 30));
    return v;
  }

  // Miércoles y Jueves → 14:00 a 16:30 (presencial)
  if (dow === 3 || dow === 4) {
    if (t.includes('control virtual')) return v;
    push(H(14, 0), H(16, 30));
    return v;
  }

  // Viernes: presencial en la mañana / virtual en la tarde
  if (dow === 5) {
    if (t.includes('control virtual')) {
      // Controles virtuales solo en la tarde: 14:00–16:30
      push(H(14, 0), H(16, 30));
    } else {
      // Presenciales en la mañana
      push(H(8, 0), H(11, 30));
    }
    return v;
  }

  // Sábado / Domingo: sin consulta (por ahora)
  return v;
}


function generarSlots(dateISO, tipo, maxSlots = 100) {
  const date = DateTime.fromISO(dateISO, { zone: ZONE });
  const ventanas = ventanasPorDia(date, tipo);   // ventanas de trabajo del doctor ese día
  const dur = duracionPorTipo(tipo);             // ej: 20 para "Primera vez", 15 para "Control presencial"
  const STEP = 5;                                // resolucion de 5 minutos

  const slots = [];

  for (const win of ventanas) {
    if (!win || !win.start || !win.end) continue;

    let cursor = win.start;

    // Alinear el cursor a múltiplos de 5 min (por si la ventana comienza en x:02 o algo raro)
    const m = cursor.minute % STEP;
    if (m !== 0) {
      cursor = cursor.plus({ minutes: STEP - m });
    }

    while (slots.length < maxSlots) {
      const fin = cursor.plus({ minutes: dur });

      // Permite un pequeeeño overhang si quieres (ej: terminar 16:05 cuando la ventana acaba 16:00)
      // Si prefieres estricto dentro de la ventana, usa: if (fin > win.end) break;
      if (fin > win.end.plus({ minutes: STEP })) {
        break;
      }

      slots.push({
        inicio: cursor.toISO({ suppressMilliseconds: true }),
        fin: fin.toISO({ suppressMilliseconds: true })
      });

      // Avanzamos el cursor 5 minutos, para poder tener 8:00, 8:20, 8:35, 8:50, etc.
      cursor = cursor.plus({ minutes: STEP });
    }

    if (slots.length >= maxSlots) break;
  }

  return { dur, ventanas, slots };
}


function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

async function consultarBusy(ventanas) {
  if (!ventanas.length) return [];
  const day = ventanas[0].start.setZone(ZONE);
  const timeMin = day.startOf('day').toUTC().toISO();
  const timeMax = day.endOf('day').toUTC().toISO();

  const resp = await calendar.freebusy.query({
    requestBody: { timeMin, timeMax, items: [{ id: CALENDAR_ID }], timeZone: ZONE },
  });

  const cal = resp.data.calendars?.[CALENDAR_ID];
  return (cal?.busy || []).map(b => ({
    start: DateTime.fromISO(b.start, { zone: ZONE }),
    end:   DateTime.fromISO(b.end,   { zone: ZONE }),
  }));
}
// NUEVO — Helpers de ventana mensual
function firstAllowedStart(now = DateTime.now().setZone(ZONE)) {
  const minDay = DateTime.fromISO(MIN_BOOKING_DATE_ISO, { zone: ZONE }).startOf('day');
  let start = now.startOf('day');
  if (minDay.isValid && start < minDay) start = minDay;
  return start;
}

 function monthPolicyFrom(desdeISO) {
   // Sin bloqueo mensual ni límite al fin de mes
   let start = DateTime.fromISO(desdeISO, { zone: ZONE });
   if (!start.isValid) start = firstAllowedStart();
   const minStart = firstAllowedStart();
   if (start < minStart) start = minStart;
   const diasMax = 180; // o el número que quieras permitir (2–6 meses, por ejemplo)
   const nextMonthStart = start.plus({ months: 1 }).startOf('month');
   return {
     start,
     endOfMonth: start.plus({ days: diasMax - 1 }).startOf('day'),
     blocked: false,
     nextMonthStart,
     diasMax
   };
}

function filtrarSlotsLibres(slots, busy) {
  // Blindaje fuerte
  if (!Array.isArray(slots) || !slots.length) return [];

  const busyArr = Array.isArray(busy) ? busy : [];
  if (!busyArr.length) return slots;

  return slots.filter(s => {
    const s1 = DateTime.fromISO(s.inicio, { zone: ZONE });
    const s2 = DateTime.fromISO(s.fin,    { zone: ZONE });

    return !busyArr.some(b => overlaps(s1, s2, b.start, b.end));
  });
}

function slotDentroDeVentanas(startISO, endISO, tipo) {
  const s = DateTime.fromISO(startISO, { zone: ZONE });
  const e = DateTime.fromISO(endISO, { zone: ZONE });
  const ventanas = ventanasPorDia(s, tipo);
  if (!ventanas.length) return false;
  return ventanas.some(w => s >= w.start && e <= w.end);
}
function coerceFutureISODate(dateStr) {
  let d = DateTime.fromISO(dateStr, { zone: ZONE });
  if (!d.isValid) return MIN_BOOKING_DATE_ISO;
  const minDay = DateTime.fromISO(MIN_BOOKING_DATE_ISO, { zone: ZONE }).startOf('day');
  if (d < minDay) d = minDay;
  return d.toISODate();
}

function coerceFutureISODateOrToday(dateStr) {
  let d = DateTime.fromISO(dateStr, { zone: ZONE });
  if (!d.isValid) return MIN_BOOKING_DATE_ISO;
  const minDay = DateTime.fromISO(MIN_BOOKING_DATE_ISO, { zone: ZONE }).startOf('day');
  if (d < minDay) d = minDay;
  return d.toISODate();
}
function fmtFechaHumana(isoDate)     { return DateTime.fromISO(isoDate, { zone: ZONE }).setLocale('es').toFormat('d LLLL'); }
function fmtHoraHumana(isoDateTime)  { return DateTime.fromISO(isoDateTime, { zone: ZONE }).toFormat('H:mm'); }
function parseHoraToMinutes(raw = '') {
  let s = String(raw || '').toLowerCase().replace(/a\s*las\s*/g, '').replace(/\s+/g, ' ').trim();
  const m = s.match(/(\d{1,2})(?::|\.|h)?\s*(\d{2})?/i);
  if (!m) return null;
  let hh = parseInt(m[1], 10);
  let mm = m[2] ? parseInt(m[2], 10) : 0;
  if (Number.isNaN(hh) || Number.isNaN(mm)) return null;
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return hh * 60 + mm;
}

const DEFAULT_REMINDER_TEMPLATE =
`🔔 *Recordatorio de cita*
Hola, {nombre}. Tienes una cita el *{fecha}* a las *{hora}*.
Si necesitas reprogramar, responde a este mensaje.`;

// Reemplaza {nombre}, {fecha}, {hora}, {fecha_hora}, {jid}, {tipo}
function renderReminderTemplate(tpl, ctx = {}) {
  const map = {
    nombre    : ctx.nombre ?? 'paciente',
    fecha     : ctx.fecha ?? '',
    hora      : ctx.hora ?? '',
    fecha_hora: ctx.fecha_hora ?? '',
    jid       : ctx.jid ?? '',
    tipo      : ctx.tipo ?? 'consulta',
  };
  return String(tpl || '')
    .replace(/\{(nombre|fecha|hora|fecha_hora|jid|tipo)\}/gi, (_, k) => map[k.toLowerCase()] ?? '');
}

async function disponibilidadPorDias({ tipo, desdeISO, dias = 30, maxSlotsPorDia = 100 }) {
  console.time(`disponibilidad:${desdeISO}:${dias}:${tipo}`);

  let start = DateTime.fromISO(desdeISO, { zone: ZONE });

  // Clamp por si llaman con fecha anterior a 1 de diciembre para virtual
  if (/virtual/i.test(tipo)) {
    const minVirtual = DateTime.fromISO(MIN_VIRTUAL_CONTROL_DATE_ISO, { zone: ZONE }).startOf('day');
    if (minVirtual.isValid && start < minVirtual) {
      start = minVirtual;
    }
  }

  const diasLista = [];
  for (let i = 0; i < dias; i++) diasLista.push(start.plus({ days: i }));

  const CONCURRENCY = 3;
  const out = [];
  let idx = 0;

  async function worker() {
    while (idx < diasLista.length) {
      const d = diasLista[idx++];

      try {
        // 🔥 CONTROLES VIRTUALES: solo viernes (weekday 5)
        if (/virtual/i.test(tipo) && d.weekday !== 5) {
          continue;
        }

        const dISO = d.toISODate();
        const { dur, ventanas, slots } = generarSlots(dISO, tipo, 2000);
        if (!ventanas.length) continue;

        console.time(`fb:${dISO}`);
        const busy = await consultarBusy(ventanas);
        console.timeEnd(`fb:${dISO}`);

        const libres = filtrarSlotsLibres(slots, busy);
        if (libres.length) {
          out.push({
            fecha: dISO,
            duracion_min: dur,
            total: libres.length,
            ejemplos: libres
              .slice(0, 8)
              .map(s => DateTime.fromISO(s.inicio, { zone: ZONE }).toFormat('HH:mm')),
            slots: libres
          });
        }
      } catch (e) {
        console.error('⚠️ Error consultando día:', e);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  out.sort((a, b) => a.fecha.localeCompare(b.fecha));
  console.timeEnd(`disponibilidad:${desdeISO}:${dias}:${tipo}`);
  return out;
}


const MONTHS_ES = {
  enero:1,febrero:2,marzo:3,abril:4,mayo:5,junio:6,
  julio:7,agosto:8,septiembre:9,setiembre:9,octubre:10,noviembre:11,diciembre:12,
  ene:1,feb:2,mar:3,abr:4,may:5,jun:6,jul:7,ago:8,sep:9,set:9,oct:10,nov:11,dic:12
};

function parseUserDate(text) {
  if (!text) return null;
  const s = text.toLowerCase();
  // YYYY-MM-DD
  const m1 = s.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/);
  if (m1) return `${m1[1]}-${String(m1[2]).padStart(2,'0')}-${String(m1[3]).padStart(2,'0')}`;
  // dd/mm/yyyy
  const m2 = s.match(/\b(\d{1,2})[\/\-](\d{1,2})[\/\-](20\d{2})\b/);
  if (m2) return `${m2[3]}-${String(m2[2]).padStart(2,'0')}-${String(m2[1]).padStart(2,'0')}`;
  // “27 de noviembre” (+ año actual)
  const m3 = s.match(/\b(\d{1,2})\s+de\s+([a-záéíóú\.]{3,})\b/);
  if (m3 && MONTHS_ES[m3[2].replace(/\./g,'')]) {
    const y = DateTime.now().setZone(ZONE).year;
    const mm = String(MONTHS_ES[m3[2].replace(/\./g,'')]).padStart(2,'0');
    const dd = String(m3[1]).padStart(2,'0');
    return `${y}-${mm}-${dd}`;
  }
  return null;
}

function extractHour(text) {
  if (!text) return null;
  const s = text.toLowerCase().replace(/\s+/g,' ');
  // 24h HH:mm
  const m1 = s.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (m1) return `${String(m1[1]).padStart(2,'0')}:${m1[2]}`;
  // 12h hh:mm am/pm
  const m2 = s.match(/\b(1[0-2]|0?\d):([0-5]\d)\s*([ap]\.?m\.?)\b/);
  if (m2) {
    let h = parseInt(m2[1],10);
    const mm = m2[2];
    const ampm = m2[3].replace(/\./g,'');
    if (ampm.startsWith('p') && h !== 12) h += 12;
    if (ampm.startsWith('a') && h === 12) h = 0;
    return `${String(h).padStart(2,'0')}:${mm}`;
  }
  return null;
}





async function alternativasCercanas({ tipo, desdeISO, dias = 10, limite = 6 }) {
  const lista = await disponibilidadPorDias({ tipo, desdeISO, dias, maxSlotsPorDia: limite });
  const planos = [];
  for (const d of lista) {
    for (const s of d.slots) {
      planos.push({ fecha: d.fecha, inicio: s.inicio, fin: s.fin, duracion_min: d.duracion_min });
      if (planos.length >= limite) break;
    }
    if (planos.length >= limite) break;
  }
  return planos;
}

// =================== WhatsApp QR: conexión + helpers ===================
const WA_SESSION_DIR = process.env.WA_SESSION_DIR || './wa_auth';
let waSock = null;

const toJid = (to) => {
  if (!to) return null;
  if (to.includes('@')) return to;
  const digits = String(to).replace(/\D/g, '');
  return `${digits}@s.whatsapp.net`;
};
const normJid = (jid='') => { try { return jidNormalizedUser(jid); } catch { return jid; } };

async function sendWhatsAppText(to, body) {
  if (!waSock) throw new Error('wa_not_connected');
  const raw = to.includes('@') ? to : toJid(to);
  const jid = normJid(raw);
  await waSock.sendMessage(jid, { text: String(body || '').slice(0, 4096) });
  // panel: registra salida
  appendChatMessage(jid, { id: `out-${Date.now()}`, fromMe: true, text: String(body || '').slice(0, 4096), ts: Date.now() });
}

async function downloadDocumentBuffer(documentMessage) {
  const stream = await downloadContentFromMessage(documentMessage, 'document');
  const chunks = []; for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function connectWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(WA_SESSION_DIR);
  const { version } = await fetchLatestBaileysVersion();

  waSock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    browser: ['ClinicBot', 'Chrome', '1.0'],
    syncFullHistory: false,
    markOnlineOnConnect: false,
    connectTimeoutMs: 60_000,
  });

  waSock.ev.on('creds.update', saveCreds);
  
  waSock.ev.on('connection.update', async (u) => {
  const { connection, lastDisconnect, qr } = u;

  // 2.1 QR -> DataURL para el panel
  if (qr) {
    try {
      waQRDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 260 });
      waQRUpdatedAt = Date.now();
      console.log('🔐 Nuevo QR listo para mostrar en el panel.');
    } catch (err) {
      console.error('❌ Error generando QR dataURL:', err);
    }
  }

  if (connection === 'open') {
    // Datos de la sesión
    try {
      const jid = waSock?.user?.id || null;
      waUserJid = jid ? jidNormalizedUser(jid) : null;
      waUserName = waSock?.user?.name || null;
      console.log('✅ WhatsApp conectado:', waUserJid || '(sin JID)');
      // Ya no necesitamos mostrar el QR si está conectado
      waQRDataUrl = null;
    } catch (e) {
      console.warn('⚠️ No se pudo leer el user de WA:', e);
    }
  }

  if (connection === 'close') {
    const shouldReconnect = !['loggedOut'].includes(lastDisconnect?.error?.output?.payload?.error);
    console.warn('⚠️ Conexión cerrada. Reintentando...', shouldReconnect);
    // Al cerrar, es posible que necesitamos QR nuevo
    // waQRDataUrl queda como esté; en cuanto Baileys emita nuevo 'qr', lo actualizamos.
    if (shouldReconnect) connectWhatsApp().catch(console.error);
    else {
      // Sesión cerrada definitivamente
      waUserJid = null; waUserName = null;
    }
  }
});


  waSock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify' || !messages?.length) return;
    for (const m of messages) {
      try { await handleIncomingBaileysMessage(m); }
      catch (err) { console.error('❌ Error procesando mensaje:', err); }
    }
  });
}

// ====== PANEL: estado y almacén de chats ======
// ====== PANEL: estado y almacén de chats (con UNREAD + normalización) ======
const panelState = {
  aiGlobalEnabled: true,        // toggle global de IA
  aiDisabledChats: new Set(),   // JIDs con IA apagada
};

const contactNames = new Map(); // Map<jid, name>
const chatStore    = new Map(); // Map<jid, Array<{id, fromMe, text, ts}>>
const unreadByJid  = new Map(); // Map<jid, number>
const CHAT_MAX_PER_THREAD = 500;



function getUnread(jid){ return unreadByJid.get(jid) || 0; }
function resetUnread(jid){ unreadByJid.set(jid, 0); }

function appendChatMessage(jid, msg) {
  const nj = normJid(jid);
  if (!chatStore.has(nj)) chatStore.set(nj, []);
  const arr = chatStore.get(nj);
  arr.push(msg);
  if (arr.length > CHAT_MAX_PER_THREAD) arr.splice(0, arr.length - CHAT_MAX_PER_THREAD);

  // si es ENTRANTE y no es de nosotros → cuenta como no leído
  if (!msg.fromMe) unreadByJid.set(nj, (unreadByJid.get(nj) || 0) + 1);
}

function listChatsSummary() {
  const out = [];
  for (const [jid, arr] of chatStore.entries()) {
    const last = arr[arr.length - 1] || null;
    out.push({
      jid,
      name: contactNames.get(jid) || jid.replace('@s.whatsapp.net',''),
      lastText: last?.text || '',
      lastTs: last?.ts || 0,
      unreadCount: getUnread(jid),
      aiEnabled: !panelState.aiDisabledChats.has(jid) && panelState.aiGlobalEnabled,
      messagesCount: arr.length,
    });
  }
  out.sort((a,b) => (b.lastTs || 0) - (a.lastTs || 0));
  return out;
}

// ================= REMINDERS (recordatorios por chat) =================
const remindersByJid = new Map(); // Map<jid, {enabled, plan, appointmentISO, jobs: Timeout[], timesISO: string[], lastSentISO: string[] }>

// planes -> offsets relativos a la cita
const REMINDER_PLANS = {
  '1h': [ { hours: 1 } ],
  '24h': [ { hours: 24 }, { hours: 1 } ],
  '1m': [ { months: 1 }, { hours: 24 }, { hours: 1 } ],
  '3m': [ { months: 3 }, { months: 1 }, { hours: 24 }, { hours: 1 } ],
  '6m': [ { months: 6 }, { months: 3 }, { months: 1 }, { hours: 24 }, { hours: 1 } ],
  '1y': [ { years: 1 }, { months: 6 }, { months: 3 }, { months: 1 }, { hours: 24 }, { hours: 1 } ],
};


function parseLocalDateTime(raw){
  // raw: "YYYY-MM-DDTHH:mm" (sin Z) desde <input type="datetime-local">
  if (!raw) return null;
  const d = DateTime.fromISO(raw, { zone: ZONE }); // lo interpreta en ZONE
  return d.isValid ? d : null;
}


function computeReminderTimes(appointmentISO, planKey) {
  const appt = DateTime.fromISO(appointmentISO, { zone: ZONE });
  if (!appt.isValid) return [];
  const now = DateTime.now().setZone(ZONE);
  const offsets = REMINDER_PLANS[planKey] || [];
  return offsets.map(off => appt.minus(off))
    .filter(dt => dt > now)               // solo futuros
    .sort((a, b) => a.toMillis() - b.toMillis());
}

function cancelJobs(cfg) {
  if (!cfg?.jobs) return;
  for (const t of cfg.jobs) try { clearTimeout(t); } catch {}
  cfg.jobs = [];
}

function scheduleJobs(jid, cfg) {
  cancelJobs(cfg);
  const times = computeReminderTimes(cfg.appointmentISO, cfg.plan);
  cfg.timesISO = times.map(t => t.toISO());
  cfg.jobs = times.map(t => {
    const delay = Math.max(0, t.toMillis() - DateTime.now().setZone(ZONE).toMillis());
    return setTimeout(async () => {
      try {
        // Contexto para las etiquetas
        const appt = DateTime.fromISO(cfg.appointmentISO, { zone: ZONE });
        const ctx = {
          nombre: contactNames.get(jid) || jid.replace('@s.whatsapp.net',''),
          fecha: appt.setLocale('es').toFormat("d 'de' LLLL yyyy"),
          hora: appt.toFormat('H:mm'),
          fecha_hora: appt.setLocale('es').toFormat("d 'de' LLLL yyyy 'a las' HH:mm"),
          jid: jid.split('@')[0],
          tipo: cfg.tipo || 'consulta',
        };

        const template = cfg.template || DEFAULT_REMINDER_TEMPLATE;

        const body = renderReminderTemplate(template, ctx);

        await sendWhatsAppText(jid, body);
        (cfg.lastSentISO ||= []).push(DateTime.now().setZone(ZONE).toISO());
      } catch (e) {
        console.error('❌ recordatorio send error', e);
      }
    }, delay);
  });
}


// GET: /api/panel/reminders[?jid=...]
app.get('/api/panel/reminders', (req, res) => {
  const jid = normJid(String(req.query?.jid || ''));
  if (jid) {
    const cfg = remindersByJid.get(jid) || null;
    return res.json({ ok: true, reminder: cfg ? { ...cfg, jobs: undefined } : null });
  }
  const all = [];
  for (const [k, v] of remindersByJid.entries()) {
    all.push({
      jid: k,
      name: contactNames.get(k) || k.replace('@s.whatsapp.net',''),
      enabled: !!v.enabled,
      plan: v.plan,
      appointmentISO: v.appointmentISO,
      timesISO: v.timesISO || [],
      lastSentISO: v.lastSentISO || [],
    });
  }
  all.sort((a,b) => String(a.appointmentISO||'').localeCompare(String(b.appointmentISO||'')));
  res.json({ ok: true, reminders: all });
});

// PATCH: /api/panel/reminders  { jid, enabled, plan, appointmentISO }
app.patch('/api/panel/reminders', (req, res) => {
  try {
    const jid = normJid(String(req.body?.jid || ''));
    if (!jid) return res.status(400).json({ ok:false, error:'falta_jid' });

    const enabled = !!req.body?.enabled;
    let plan = String(req.body?.plan || '24h');
    if (!REMINDER_PLANS[plan]) plan = '24h';

    let apptISO = null;
    if (enabled) {
      const parsed = parseLocalDateTime(String(req.body?.appointmentISO || '').trim());
      if (!parsed) return res.status(400).json({ ok:false, error:'appointment_invalida' });
      if (parsed <= DateTime.now().setZone(ZONE)) return res.status(400).json({ ok:false, error:'appointment_pasada' });
      apptISO = parsed.toISO();
    }

    let cfg = remindersByJid.get(jid);
    if (!cfg) { cfg = { enabled:false, plan:'24h', appointmentISO:null, jobs:[], timesISO:[], lastSentISO:[] }; remindersByJid.set(jid, cfg); }

    cfg.enabled = enabled;
    cfg.plan = plan;
    if (apptISO) cfg.appointmentISO = apptISO;

    if (!cfg.enabled) {
      cancelJobs(cfg);
      cfg.timesISO = [];
      return res.json({ ok:true, reminder:{ ...cfg, jobs:undefined } });
    }

    scheduleJobs(jid, cfg);
    res.json({ ok:true, reminder:{ ...cfg, jobs:undefined } });
  } catch (e) {
    console.error('reminders patch error', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

// ================ MÉTRICAS para HOME ====================
app.get('/api/panel/metrics', async (req, res) => {
  try {
    const now = DateTime.now().setZone(ZONE);
    const start = now.startOf('day'), end = now.endOf('day');
    let messagesToday = 0, unreadTotal = 0;
    const recent = [];
    for (const [jid, msgs] of chatStore.entries()) {
      unreadTotal += (unreadByJid.get(jid) || 0);
      const last = msgs[msgs.length-1];
      if (last?.ts) {
        const ts = DateTime.fromMillis(typeof last.ts === 'number' ? last.ts : Number(last.ts), { zone: ZONE });
        recent.push({
          jid,
          name: contactNames.get(jid) || jid.replace('@s.whatsapp.net',''),
          lastText: last?.text || '',
          lastTs: ts.toISO()
        });
      }
      messagesToday += msgs.filter(m => {
        const t = DateTime.fromMillis(typeof m.ts === 'number' ? m.ts : Number(m.ts), { zone: ZONE });
        return t >= start && t <= end;
      }).length;
    }
    recent.sort((a,b)=> (b.lastTs||'').localeCompare(a.lastTs||''));
    const recentTop = recent.slice(0, 5);

    // eventos próximos 14 días
    const timeMin = now.toUTC().toISO();
    const timeMax = now.plus({ days: 30 }).toUTC().toISO();
    const resp = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin, timeMax,
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 250,
    });
    const eventsNext = (resp.data.items || []).length;

    res.json({
      ok:true,
      connected: !!waUserJid,
      aiGlobalEnabled: panelState.aiGlobalEnabled,
      messagesToday,
      eventsNext,
      unreadTotal,
      recentTop,
    });
  } catch (e) {
    console.error('metrics error', e);
    res.status(500).json({ ok:false, error:'metrics_error' });
  }
});



// ============== Media + BI-RADS + resumen PDF (helpers) ==============
function detectarBirads(raw = '') {
  const s = String(raw || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').replace(/\s+/g, ' ').toUpperCase();
  const m = s.match(/\bBI\s*[-\s]?RADS?\s*[:\-]?\s*(0|1|2|3|4[ABC]?|5|6)\b/);
  return m ? m[1] : null;
}
function isPriorityBirads(b) { if (!b) return false; const u = String(b).toUpperCase(); return u.startsWith('4') || u.startsWith('5'); }


// Normaliza "10", "10:0", "10:00" → "10:00"
function normHHmm(hora) {
  const s = String(hora || '').trim();
  const m = s.match(/^(\d{1,2})(?::?(\d{1,2}))?$/);
  if (!m) return null;
  const hh = String(Math.min(23, parseInt(m[1],10))).padStart(2,'0');
  const mm = String(Math.min(59, parseInt(m[2] ?? '0',10))).padStart(2,'0');
  return `${hh}:${mm}`;
}




// ====== Cancelación ======
async function cancelEventById(eventId) {
  try { await calendar.events.delete({ calendarId: CALENDAR_ID, eventId, sendUpdates: 'none' }); return { ok: true }; }
  catch (err) { const code = err?.response?.status || err?.code; return { ok: false, code, err }; }
}

async function findEventByLocal({ fechaISO, horaHHmm, toleranceMin = 10 }) {
  const hhmm = normHHmm(horaHHmm);
  if (!fechaISO || !hhmm) return null;

  const localTarget = DateTime.fromISO(`${fechaISO}T${hhmm}`, { zone: ZONE });
  if (!localTarget.isValid) return null;

  const timeMin = localTarget.minus({ minutes: 30 }).toUTC().toISO();
  const timeMax = localTarget.plus({ minutes: 30 }).toUTC().toISO();

  // Trae eventos cercanos a esa hora
  const resp = await calendar.events.list({
    calendarId: CALENDAR_ID,
    timeMin,
    timeMax,
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 50,
  });

  const items = resp.data.items || [];
  console.log(`[CANCEL][DBG] Se listaron ${items.length} eventos entre ${timeMin} y ${timeMax} (UTC)`);

  // Log detallado de lo que hay en ese rango
  for (const ev of items) {
    const evStartISO = ev.start?.dateTime || ev.start?.date || null;
    if (!evStartISO) continue;
    const evStartLocal = DateTime.fromISO(evStartISO).setZone(ZONE);
    console.log(`[CANCEL][DBG] - ${ev.id} ${ev.summary || '“(sin título)”'} @ ${evStartLocal.toISO()} (local)`);
  }

  // Escoge el más cercano dentro de la tolerancia
  let best = null;
  let bestDiff = Infinity;

  for (const ev of items) {
    const evStartISO = ev.start?.dateTime || null; // ignoramos “all-day”
    if (!evStartISO) continue;
    const evStartLocal = DateTime.fromISO(evStartISO).setZone(ZONE);
    const diff = Math.abs(evStartLocal.diff(localTarget, 'minutes').minutes);
    if (diff <= toleranceMin && diff < bestDiff) {
      bestDiff = diff;
      best = {
        eventId: ev.id,
        startLocal: evStartLocal.toISO(),
        summary: ev.summary || '',
        htmlLink: ev.htmlLink || null,
      };
    }
  }

  if (!best) {
    console.log(`[CANCEL][DBG] Ningún evento dentro de ±${toleranceMin} min de ${localTarget.toISO()}.`);
  } else {
    console.log(`[CANCEL][DBG] MATCH: eventId=${best.eventId} startLocal=${best.startLocal} (Δ≈${bestDiff.toFixed(1)} min)`);
  }
  return best;
}



// ===== LLM outage handling =====
let _llmSilenceUntilISO = null; // evita spam en consola

// ====== Reparador / parser de acciones JSON ======
function repairJSON(raw = '') {
  let s = String(raw || '');
  s = s.replace(/```/g, '').replace(/\bjson\b/gi, '');
  s = s.replace(/[\u00A0\u200B\uFEFF]/g, ' ');
  s = s.replace(/[“”«»„‟]/g, '"').replace(/[‘’‚‛]/g, "'");
  s = s.replace(/:\s*'([^']*)'/g, ': "$1"');
  s = s.replace(/,\s*([}\]])/g, '$1');
  return s.trim();
}

// Quita cualquier bloque JSON visible y fences de código antes de enviar al usuario



function extractActionJSONBlocks(text = '') {
  const cleaned = repairJSON(text); const out = [];
  const idx = cleaned.indexOf('"action"');
  if (idx !== -1) {
    let start = cleaned.lastIndexOf('{', idx);
    if (start !== -1) {
      let depth = 0;
      for (let i = start; i < cleaned.length; i++) {
        const ch = cleaned[i];
        if (ch === '{') depth++;
        if (ch === '}') depth--;
        if (depth === 0) {
          const candidate = cleaned.slice(start, i + 1);
          try { const obj = JSON.parse(candidate); if (obj && typeof obj === 'object' && obj.action) out.push(obj); } catch {}
          break;
        }
      }
    }
  }
  if (out.length === 0) {
    const objs = cleaned.match(/\{[\s\S]*?\}/g) || [];
    for (const raw of objs) { try { const obj = JSON.parse(raw); if (obj && typeof obj === 'object' && obj.action) out.push(obj); } catch {} }
  }
  return out;
}
async function maybeHandleAssistantAction(text, session) {
  const payloads = extractActionJSONBlocks(text);
  if (!payloads.length) return null;

  const results = [];
  const now = DateTime.now().setZone(ZONE);

  for (const payload of payloads) {
    const action = norm(payload.action || '');

    // ─────────────────────────────────────
    // CONSULTAR DISPONIBILIDAD (UN DÍA)
    // ─────────────────────────────────────
    if (action === 'consultar_disponibilidad') {
      const userWants = guessTipo(session.lastUserText || '');
      let tipoRaw = (payload.data?.tipo) || userWants || session.tipoActual || 'Control presencial';
      const tipo = normalizeTipo(tipoRaw);
      session.tipoActual = tipo; // persistimos normalizado

      let { fecha } = payload.data || {};
      if (fecha) fecha = coerceFutureISODate(fecha);

      const { dur, ventanas, slots } = generarSlots(fecha, tipo, 60);
      if (!ventanas.length) {
        results.push({
          ok: true,
          fecha,
          tipo,
          duracion_min: dur,
          slots: [],
          note: 'Día sin consulta según reglas'
        });
        continue;
      }
      const busy = await consultarBusy(ventanas);
      const libres = filtrarSlotsLibres(slots, busy);
      results.push({ ok: true, fecha, tipo, duracion_min: dur, slots: libres });
      continue;
    }

    // ─────────────────────────────────────
    // CONSULTAR DISPONIBILIDAD (RANGO)
    // ─────────────────────────────────────
    if (action === 'consultar_disponibilidad_rango') {
      const userWants = guessTipo(session.lastUserText || '');
      let tipoRaw = (payload.data?.tipo) || userWants || session.tipoActual || 'Control presencial';
      const tipo = normalizeTipo(tipoRaw);
      session.tipoActual = tipo;

      let { desde, dias } = payload.data || {};
      const nowLocal   = DateTime.now().setZone(ZONE);
      const startRef   = firstAllowedStartSafe(nowLocal);
      // 🟣 Clamp especial para control virtual
      if (/virtual/i.test(tipo)) {
        const minVirtual = DateTime.fromISO(MIN_VIRTUAL_CONTROL_DATE_ISO, { zone: ZONE }).startOf('day');
      if (minVirtual.isValid && startRef < minVirtual) {
        startRef = minVirtual;
      }
     }
      const desdeFixed = desde ? coerceFutureISODateOrToday(desde) : startRef.toISODate();

         // Si el modelo pidió un "desde" antes del 1 de diciembre, lo subimos igual
      if (/virtual/i.test(tipo) && desdeFixed < MIN_VIRTUAL_CONTROL_DATE_ISO) {
        desdeFixed = MIN_VIRTUAL_CONTROL_DATE_ISO;
      }

      const diasCalendar = Math.min(Number(dias || CALENDAR_HORIZON_DAYS), CALENDAR_HORIZON_DAYS);

      const raw = await disponibilidadPorDias({ tipo, desdeISO: desdeFixed, dias: diasCalendar });

      const byDate = new Map();
      for (const d of raw || []) {
        const k = d.fecha;
        const prev = byDate.get(k);
        const merged = (prev?.slots || []).concat(d.slots || []);
        const seen = new Set();
        const slots = merged
          .filter(s => { const key = String(s.inicio); if (seen.has(key)) return false; seen.add(key); return true; })
          .sort((a, b) => String(a.inicio).localeCompare(String(b.inicio)));
        byDate.set(k, { fecha: k, slots });
      }
      const ordered = [...byDate.values()]
        .filter(d => (d.slots || []).length > 0)
        .sort((a, b) => a.fecha.localeCompare(b.fecha))
        .slice(0, Number(session.rangeLockHabiles || HABILES_TARGET));

      results.push({
        ok: true,
        tipo,
        desde: desdeFixed,
        dias: diasCalendar,
        total_dias: ordered.length,
        dias_disponibles: ordered
      });
      continue;
    }

    // ─────────────────────────────────────
    // CREAR CITA  (AQUÍ ES DONDE PARCHEAMOS)
    // ─────────────────────────────────────
    if (action === 'crear_cita') {
      const d = payload.data || {};

      // === Tipo efectivo y cache ===
      const tipoEff = normalizeTipo(d.tipo || session.tipoActual || 'Control presencial');
      session.tipoActual = tipoEff;


      // === Reparar inicio/fin usando lastOffered + duración, si hace falta ===
      let inicio = d.inicio || null;
      let fin    = d.fin    || null;

      // 1) Intentar leer un slot ofrecido previamente
      let offeredSlot = null;
      if (session.lastOffered && Array.isArray(session.lastOffered.days) && session.lastOffered.days.length) {
        const day0 = session.lastOffered.days[0];
        if (day0 && Array.isArray(day0.slots) && day0.slots.length) {
          offeredSlot = day0.slots[0]; // en tu flujo normal solo hay 1 slot
        }
      }

      // 2) Si el LLM no puso inicio/fin pero nosotros sí tenemos un slot ofrecido, usarlo
      if ((!inicio || !fin) && offeredSlot) {
        if (!inicio && offeredSlot.inicio) inicio = offeredSlot.inicio;
        if (!fin    && offeredSlot.fin)    fin    = offeredSlot.fin;
      }

      // 3) Si hay inicio pero no fin, lo calculamos con la duración por tipo
      if (inicio && !fin) {
        const startDT = DateTime.fromISO(inicio, { zone: ZONE });
        if (startDT.isValid) {
          const durMin = duracionPorTipo(tipoEff);
          fin = startDT.plus({ minutes: durMin }).toISO();
        }
      }

      // 4) Construimos DateTime ya reparados
      const s = inicio ? DateTime.fromISO(inicio, { zone: ZONE }) : DateTime.invalid('no_inicio');
      const e = fin    ? DateTime.fromISO(fin,    { zone: ZONE }) : DateTime.invalid('no_fin');

      // === Merge paciente: payload > session (SEÑUELOS NO BLOQUEAN) ===
       // Entidad: pasamos SIEMPRE por normalizeEntidadSalud para evitar cosas tipo "Hola"
  const entidadFromPayload = normalizeEntidadSalud(d.entidad_salud);
  const entidadFromSession = normalizeEntidadSalud(session.patient?.entidad_salud);
  const entidadFinal = entidadFromPayload || entidadFromSession || null;

  const pat = {
    nombre:            d.nombre            ?? session.patient?.nombre,
    cedula:            d.cedula            ?? session.patient?.cedula,
    entidad_salud:     entidadFinal,
    correo:            d.correo            ?? session.patient?.correo,
    celular:           d.celular ?? d.telefono ?? session.patient?.celular,
    direccion:         d.direccion         ?? session.patient?.direccion,
    ciudad:            d.ciudad            ?? session.patient?.ciudad,

    // —— SEÑUELOS (opcionales, solo para que queden en WhatsApp / descripción)
    fecha_nacimiento:  d.fecha_nacimiento  ?? session.patient?.fecha_nacimiento,
    tipo_sangre:       d.tipo_sangre       ?? session.patient?.tipo_sangre,
    estado_civil:      d.estado_civil      ?? session.patient?.estado_civil,
    plan:              d.plan              ?? session.patient?.plan,
  };

  // Actualizamos cache de sesión ya "limpio"
  session.patient = { ...(session.patient || {}), ...pat };


      // === Bloqueo por prioridad
      if (session.priority?.active) {
        results.push({
          ok: false,
          error: 'prioridad_activa',
          message: 'Tu caso es prioritario y un asesor te contactará directamente. No puedo crear la cita por este medio.'
        });
        session.lastSystemNote = 'Bloqueado crear_cita por prioridad activa.';
        continue;
      }

      // === Validaciones de tiempo (ya con posible reparación)
      if (!s.isValid || !e.isValid || s >= e) {
        console.log('[CREAR_CITA][ERR fecha_invalida]', {
          rawInicio: d.inicio,
          rawFin: d.fin,
          repairedInicio: inicio,
          repairedFin: fin,
          lastOffered: session.lastOffered || null
        });
        results.push({ ok: false, error: 'fecha_invalida', message: 'Fecha/hora inválida.' });
        session.lastSystemNote = 'El último intento falló: fecha/hora inválida.';
        continue;
      }

      if (s < now) {
        results.push({
          ok: false,
          error: 'fecha_pasada',
          message: 'La hora elegida ya pasó. Elige una fecha futura.'
        });
        session.lastSystemNote = 'Falló por fecha pasada.';
        continue;
      }

      // === Mínimo absoluto (si aplica)
      if (typeof MIN_BOOKING_DATE_ISO === 'string' && MIN_BOOKING_DATE_ISO) {
        const minDay = DateTime.fromISO(MIN_BOOKING_DATE_ISO, { zone: ZONE }).startOf('day');
        if (minDay.isValid && s < minDay) {
          results.push({
            ok: false,
            error: 'antes_minimo',
            message: `Solo agendamos desde el ${minDay.setLocale('es').toFormat("d 'de' LLLL yyyy")} en adelante.`
          });
          session.lastSystemNote = 'Falló por fecha anterior al mínimo.';
          continue;
        }
      }

      // === OBLIGATORIOS REALES
      const required = ['nombre','cedula','entidad_salud','correo','celular','direccion','ciudad'];
      const labels = {
        nombre: 'nombre completo',
        cedula: 'cédula',
        entidad_salud: 'entidad de salud (o particular)',
        correo: 'correo',
        celular: 'número de celular',
        direccion: 'dirección',
        ciudad: 'ciudad',
      };
      const missing = required.filter(k => !pat[k] || String(pat[k]).trim() === '');
      if (missing.length) {
        const human = missing.map(k => labels[k] || k).join(', ');
        results.push({
          ok: false,
          error: 'faltan_campos',
          message: `Antes de agendar necesito: ${human}.`
        });
        session.lastSystemNote = `Crear_cita bloqueado: faltan ${missing.join(', ')}.`;
        continue;
      }

      // === Coomeva Preferente
      const entidadRaw = String(pat.entidad_salud || '');
      const planRaw = String(pat.plan || '');
      if (/coomeva/i.test(entidadRaw) && /preferent/i.test(entidadRaw + ' ' + planRaw)) {
        results.push({
          ok: false,
          error: 'coomeva_preferente',
          message: 'No podemos agendar con Coomeva Preferente. ¿Deseas agendar como particular?'
        });
        session.lastSystemNote = 'Intento con Coomeva Preferente bloqueado.';
        continue;
      }

      // === Ventanas válidas
      if (!slotDentroDeVentanas(s.toISO(), e.toISO(), tipoEff)) {
        results.push({
          ok: false,
          error: 'fuera_horario',
          message: 'Ese día/horario no es válido según las reglas.'
        });
        session.lastSystemNote = 'Falló por fuera de horario.';
        continue;
      }

      // === Solapamiento en Calendar
      const fb = await calendar.freebusy.query({
        requestBody: {
          timeMin: s.toUTC().toISO(),
          timeMax: e.toUTC().toISO(),
          items: [{ id: CALENDAR_ID }],
          timeZone: ZONE,
        },
      });
      const cal = fb.data.calendars?.[CALENDAR_ID];
      const busy = (cal?.busy || []).map(b => ({
        start: DateTime.fromISO(b.start, { zone: ZONE }),
        end:   DateTime.fromISO(b.end,   { zone: ZONE }),
      }));
      const solapa = busy.some(b => overlaps(s, e, b.start, b.end));
      if (solapa) {
        results.push({
          ok: false,
          error: 'slot_ocupado',
          message: 'Ese horario ya está reservado. Elige otra opción.'
        });
        session.lastSystemNote = 'Falló por slot ocupado.';
        continue;
      }

      // === Nombre (obligatorio)
      const displayName = String(pat.nombre).trim();

      // === Insertar evento
      try {
        const ins = await calendar.events.insert({
          calendarId: CALENDAR_ID,
          requestBody: {
            summary: `[${tipoEff}] ${displayName} (${pat.entidad_salud || ''})`.trim(),
            location: 'Clínica Portoazul, piso 7, consultorio 707, Barranquilla',
            description:
              `Cédula: ${pat.cedula || ''}\n` +
              `Entidad: ${pat.entidad_salud || ''}\n` +
              `Teléfono: ${pat.celular || ''}\n` +
              `Correo: ${pat.correo || ''}\n` +
              `Tipo: ${tipoEff}\n` +
              (pat.fecha_nacimiento ? `Fecha de nacimiento: ${pat.fecha_nacimiento}\n` : '') +
              (pat.tipo_sangre ? `Tipo de sangre: ${pat.tipo_sangre}\n` : '') +
              (pat.estado_civil ? `Estado civil: ${pat.estado_civil}\n` : '') +
              `Dirección: ${pat.direccion || ''}\n` +
              `Ciudad: ${pat.ciudad || ''}`,
            start: { dateTime: s.toISO(), timeZone: ZONE },
            end:   { dateTime: e.toISO(), timeZone: ZONE },
          },
        });

        const f = s.setLocale('es');
        const fechaTxt = f.toFormat("d 'de' LLLL");
        const horaTxt  = f.toFormat('HH:mm');
        const confirmText =
          `Tu cita ha sido agendada exitosamente para el ${fechaTxt} a las ${horaTxt} ` +
          `en la Clínica Portoazul, piso 7, consultorio 707, en Barranquilla. ` +
          `Por favor, llega con 15 minutos de anticipación y lleva todos los reportes previos impresos.\n\n` +
          `Recuerda que está prohibido grabar audio o video durante la consulta sin autorización. ` +
          `Cualquier inquietud adicional, no dudes en contactarnos.`;

        console.log('✅ Evento creado:', ins.data.id, ins.data.htmlLink || '', {
          tipo: tipoEff, nombre: displayName, cedula: pat.cedula, cel: pat.celular
        });

        results.push({
          ok: true,
          eventId: ins.data.id,
          htmlLink: ins.data.htmlLink || null,
          inicio: s.toISO(),
          fin: e.toISO(),
          tipo: tipoEff,
          confirmText,
        });
        session.lastSystemNote = 'La última cita fue creada correctamente en el calendario.';
      } catch (err) {
        console.error('❌ Error creando evento:', err?.response?.data || err);
        results.push({
          ok: false,
          error: 'gcal_insert_error',
          message: 'No se pudo crear la cita en Google Calendar.'
        });
        session.lastSystemNote = 'No se pudo crear la cita en Google Calendar.';
      }
      continue;
    }

    // ─────────────────────────────────────
    // GUARDAR PACIENTE (mock)
    // ─────────────────────────────────────
    if (action === 'guardar_paciente') {
      results.push({ ok: true, saved: true });
      continue;
    }

    // ─────────────────────────────────────
    // CANCELAR CITA
    // ─────────────────────────────────────
    if (action === 'cancelar_cita') {
      const d = payload.data || {};
      const cedula = (d.cedula || '').trim();
      console.log('[CANCEL] Cédula recibida (señuelo, no valida):', cedula || '(vacía)');

      const fecha = (d.fecha || '').trim();
      const hora  = (d.hora  || '').trim();

      if (!fecha || !hora) {
        console.log('[CANCEL] Falta fecha u hora → pedir datos');
        results.push({
          ok:false,
          error:'falta_fecha_hora',
          message:'Indícame la fecha (AAAA-MM-DD) y la hora (HH:mm) exactas de tu cita.'
        });
        continue;
      }

      const hhmm = normHHmm(hora);
      if (!hhmm) {
        console.log('[CANCEL] Hora inválida (normHHmm falló):', hora);
        results.push({
          ok:false,
          error:'hora_invalida',
          message:'Formato de hora inválido. Usa 24h, por ejemplo: 08:00 o 14:30.'
        });
        continue;
      }

      console.log(`[CANCEL] Buscando evento por fecha/hora → ${fecha} ${hhmm} (${ZONE}) con tolerancia ±10min`);
      const found = await findEventByLocal({ fechaISO: fecha, horaHHmm: hhmm, toleranceMin: 10 });

      if (!found) {
        console.log('[CANCEL][ERR] No se encontró evento con fecha/hora dentro de la tolerancia.');
        results.push({
          ok:false,
          error:'no_encontrada',
          message:'No encontré una cita exactamente con esos datos.'
        });
        continue;
      }

      console.log('[CANCEL] Cancelando eventId=', found.eventId, 'startLocal=', found.startLocal);
      const del = await cancelEventById(found.eventId);
      if (!del.ok) {
        console.log('[CANCEL][ERR] No se pudo cancelar:', del.code);
        results.push({
          ok:false,
          error:'cancel_error',
          code:del.code,
          message:'No se pudo cancelar la cita.'
        });
        continue;
      }

      console.log('[CANCEL] ✅ Cancelada eventId=', found.eventId, 'startLocal=', found.startLocal, 'resumen=', found.summary);
      results.push({ ok:true, cancelled:true, eventId:found.eventId });
      session.lastSystemNote = 'Se canceló una cita (ok).';
      continue;
    }
  }

  if (results.length === 1) return { handled: true, makeResponse: results[0] };
  return { handled: true, makeResponse: results };
}


// ============== Handler de mensajes (con CORTE IA temprano) ==============
async function handleIncomingBaileysMessage(m) {
  const rawJid = m.key?.remoteJid;
  if (!rawJid || rawJid.endsWith('@g.us')) return; // sin grupos
  const remoteJid = normJid(rawJid);

  const now = DateTime.now().setZone(ZONE);
  if (m.pushName) contactNames.set(remoteJid, m.pushName);

  // Parse básico para registrar en panel
  const msg = m.message || {};
  const textBody =
    msg.conversation ||
    msg.extendedTextMessage?.text || '';
  const documentMessage = msg.documentMessage || msg.documentWithCaptionMessage?.message?.documentMessage || null;
  const buttonsResponse = msg.buttonsResponseMessage || null;
  const listResponse    = msg.listResponseMessage || null;

  let displayText = '';
  if (documentMessage) displayText = '[Documento] ' + (documentMessage?.fileName || 'archivo');
  else if (buttonsResponse) displayText = '[Botón] ' + (buttonsResponse?.selectedDisplayText || buttonsResponse?.selectedButtonId || 'opción');
  else if (listResponse) displayText = '[Lista] ' + (listResponse?.title || listResponse?.singleSelectReply?.selectedRowId || 'opción');
  else displayText = textBody || '[Mensaje]';

  appendChatMessage(remoteJid, { id: m.key?.id || String(Date.now()), fromMe: false, text: displayText, ts: (m.messageTimestamp || Date.now()) * 1000 });

  // Corte por horario: después de 6:00 pm no se atiende


  // ===== CORTE: IA desactivada (global o chat) → no responder
  const iaOffForChat = panelState.aiDisabledChats.has(remoteJid);
  if (!panelState.aiGlobalEnabled || iaOffForChat) {
    console.log(`🤖 IA desactivada ${!panelState.aiGlobalEnabled ? 'GLOBAL' : 'para chat'} → ${remoteJid}.`);
    return;
  }

  
// ===== De aquí en adelante tu flujo normal (PDF/BI-RADS/PRIORIDAD/⏳/chat)
const session = getSession(remoteJid);

let userText = '';
let biradsDetectado = null;

// 1) Construir userText según el tipo de mensaje
if (documentMessage) {
  const mime = documentMessage.mimetype || '';
  if (mime.includes('pdf')) {
    try {
      const buf = await downloadDocumentBuffer(documentMessage);
      const parsed = await pdf(buf);
      const birads = detectarBirads(parsed.text || '');
      biradsDetectado = birads;

      if (birads) {
        session.birads = birads;
        if (isPriorityBirads(birads)) {
          // PRIORIDAD por PDF — solo escalamos si viene teléfono válido, si no, pedimos y entramos a waiting_phone
          const phoneFromPdf = extractPhoneFromText(parsed.text || '');
          if (!phoneFromPdf) {
            session.priority = { active: true, status: 'waiting_phone', birads, source: 'pdf' };
            console.log(`[PRIORITY] BI-RADS ${birads} por PDF — sin teléfono. → waiting_phone & pedir número`);
            await sendWhatsAppText(
              remoteJid,
              'Para coordinar tu atención prioritaria, necesito tu **número celular con indicativo**, por ejemplo: +57 3001234567.'
            );
            return; // no seguimos al /chat
          } else {
            console.log(`[PRIORITY] BI-RADS ${birads} por PDF — teléfono en PDF: ${phoneFromPdf}. → escalar`);
            await triggerPriorityEscalation(remoteJid, {
              source: 'pdf',
              birads,
              snippet: (parsed.text || '').slice(0, 200),
              patientPhone: phoneFromPdf,
              patientName: contactNames.get(remoteJid),
            });
            return; // no seguimos al /chat
          }
        } else {
          // No-prioridad: anotar y continuar flujo clínico
          session.lastSystemNote = `BIRADS ${birads} detectado desde PDF. No pidas de nuevo la categoría; procede según reglas.`;
          userText = `BI-RADS ${birads} detectado por PDF. Continúa el flujo clínico.`;
        }
      } else {
        userText = 'Leí tu PDF pero no detecté la categoría BI-RADS. ¿Cuál es tu BI-RADS? Además, ¿tiene estudios recientes? ¿cuándo y dónde se los hizo?';
      }
    } catch (e) {
      console.error('❌ Error procesando PDF:', e);
      userText = 'Recibí tu PDF pero no pude leerlo. ¿Puedes confirmar tu BI-RADS y si tienes estudios recientes (cuándo y dónde)?';
    }
  } else {
    userText = '[Documento recibido]';
  }

} else if (buttonsResponse || listResponse) {
  userText =
    buttonsResponse?.selectedDisplayText ||
    buttonsResponse?.selectedButtonId ||
    listResponse?.title ||
    listResponse?.singleSelectReply?.selectedRowId || 'OK';

} else if (textBody) {
  userText = (textBody || '').trim();

} else {
  userText = 'Recibí tu mensaje. ¿Cómo quieres continuar?';
}

// 2) Si ya estamos esperando SOLO el teléfono → intentar extraerlo del mensaje actual
if (session?.priority?.active && session.priority.status === 'waiting_phone') {
  const guessPhone =
    extractPhoneFromText(userText) ||
    extractPhoneFromText(displayText); // displayText ya lo armaste arriba
  if (guessPhone) {
    console.log(`[PRIORITY] 📞 Teléfono recibido en waiting_phone: ${guessPhone}. → escalar`);
    await triggerPriorityEscalation(remoteJid, {
      source: session.priority?.source || 'texto',
      birads: session.priority?.birads || '4',
      patientPhone: guessPhone,
      patientName: contactNames.get(remoteJid),
    });
    return; // no seguimos al /chat
  } else {
    console.log('[PRIORITY] Aún sin teléfono en waiting_phone → re-pedir');
    await sendWhatsAppText(
      remoteJid,
      'Solo necesito tu **número celular con indicativo**, por ejemplo: +57 3001234567. Apenas lo envíes, un asesor te contacta.'
    );
    return;
  }
}

// 3) Detección de BI-RADS por TEXTO (después del gate de teléfono)
const bx = detectarBirads(userText);
if (bx) {
  biradsDetectado = bx;
  session.birads = bx;

  if (isPriorityBirads(bx)) {
    // PRIORIDAD por TEXTO — solo escalamos si viene teléfono válido, si no, pedimos y entramos a waiting_phone
    const phoneFromText = extractPhoneFromText(userText);
    if (!phoneFromText) {
      session.priority = { active: true, status: 'waiting_phone', birads: bx, source: 'texto' };
      console.log(`[PRIORITY] BI-RADS ${bx} por TEXTO — sin teléfono. → waiting_phone & pedir número`);
      await sendWhatsAppText(
        remoteJid,
        'Para coordinar tu atención prioritaria, necesito tu **número celular con indicativo**, por ejemplo: +57 3001234567.'
      );
      return; // no seguimos al /chat
    } else {
      console.log(`[PRIORITY] BI-RADS ${bx} por TEXTO — teléfono en texto: ${phoneFromText}. → escalar`);
      await triggerPriorityEscalation(remoteJid, {
        source: 'texto',
        birads: bx,
        snippet: userText.slice(0, 200),
        patientPhone: phoneFromText,
        patientName: contactNames.get(remoteJid),
      });
      return; // no seguimos al /chat
    }
  } else {
    session.lastSystemNote = `BIRADS ${bx} reportado por texto. No pidas de nuevo la categoría; procede según reglas.`;
  }
}

// === Si llegaste aquí: NO prioridad o ya resuelto → continúa con “⏳ …” y POST a /chat
await sendWhatsAppText(remoteJid, '⏳ Un momento, estoy consultando…');
// ... (tu POST a /chat sigue como ya lo tienes)


  try {
    const r = await fetch('http://localhost:3000/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: remoteJid, message: userText }),
    });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = null; }
    if (!r.ok) { console.error('❌ /chat status:', r.status, text); await sendWhatsAppText(remoteJid, '⚠️ Hubo un problema consultando. Intenta otra vez.'); return; }
    const botReply = data?.reply || 'Ups, no pude procesar tu mensaje.';
    await sendWhatsAppText(remoteJid, botReply || 'Listo ✅');
  } catch (e) { console.error('❌ Error en procesamiento diferido:', e); await sendWhatsAppText(remoteJid, '⚠️ Hubo un problema consultando. Intenta otra vez.'); }
}

// ====================== API PANEL ======================
// ====================== API PANEL ======================
app.get('/api/panel/state', (req, res) => {
  res.json({
    aiGlobalEnabled: panelState.aiGlobalEnabled,
    aiDisabledChats: Array.from(panelState.aiDisabledChats),
  });
});

app.patch('/api/panel/toggle-ai-global', (req, res) => {
  try {
    const enabled = !!req.body?.enabled;
    panelState.aiGlobalEnabled = enabled;
    res.json({ ok: true, aiGlobalEnabled: panelState.aiGlobalEnabled });
  } catch {
    res.status(400).json({ ok: false });
  }
});

app.get('/api/panel/chats', (req, res) => {
  res.json({ ok: true, chats: listChatsSummary() });
});

app.get('/api/panel/messages', (req, res) => {
  const jid = normJid(String(req.query.jid || ''));
  if (!jid) return res.status(400).json({ ok: false, error: 'falta_jid' });
  res.json({
    ok: true,
    jid,
    name: contactNames.get(jid) || jid.replace('@s.whatsapp.net',''),
    messages: chatStore.get(jid) || [],
    unreadCount: (unreadByJid.get(jid) || 0),
    aiEnabled: !panelState.aiDisabledChats.has(jid) && panelState.aiGlobalEnabled,
  });
});

// marcar leído/un leído
app.patch('/api/panel/mark-read', (req, res) => {
  const jid = normJid(String(req.body?.jid || ''));
  if (!jid) return res.status(400).json({ ok:false, error:'falta_jid' });
  resetUnread(jid);
  res.json({ ok:true });
});

app.patch('/api/panel/toggle-ai-chat', (req, res) => {
  const jid = normJid(String(req.body?.jid || ''));
  const enabled = !!req.body?.enabled;
  if (!jid) return res.status(400).json({ ok: false, error: 'falta_jid' });
  if (enabled) panelState.aiDisabledChats.delete(jid);
  else panelState.aiDisabledChats.add(jid);
  res.json({ ok: true, jid, aiEnabled: enabled });
});

app.post('/api/panel/send', async (req, res) => {
  try {
    const jid = normJid(String(req.body?.jid || ''));
    const text = String(req.body?.text || '');
    if (!jid || !text) return res.status(400).json({ ok: false, error: 'falta_jid_o_texto' });
    await sendWhatsAppText(jid, text);
    res.json({ ok: true });
  } catch (e) {
    console.error('panel send error', e);
    res.status(500).json({ ok: false, error: 'send_failed' });
  }
});

// (opcional) Re-vincular: borra sesión y reconecta
app.post('/api/panel/relink', async (req, res) => {
  try {
    const dir = process.env.WA_SESSION_DIR || './wa_auth';
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    if (waSock?.end) try { await waSock.end(); } catch {}
    connectWhatsApp().catch(console.error);
    res.json({ ok: true });
  } catch (e) {
    console.error('relink error', e);
    res.status(500).json({ ok: false });
  }
});

// Estado de la sesión de WhatsApp para el panel
app.get('/api/wa/status', (req, res) => {
  res.json({
    connected: !!waUserJid,
    jid: waUserJid,
    name: waUserName,
    qrAvailable: !!waQRDataUrl,
    qrUpdatedAt: waQRUpdatedAt,
  });
});

// QR como imagen (dataURL)
app.get('/api/wa/qr', (req, res) => {
  if (!waQRDataUrl) return res.status(404).json({ ok:false, error:'no_qr' });
  res.json({ ok:true, dataUrl: waQRDataUrl, ts: waQRUpdatedAt });
});

// Lista eventos del calendario vinculado (próximos N días)
app.get('/api/calendar/events', async (req, res) => {
  try {
    const days = Math.max(1, Math.min(31, parseInt(req.query.days || '18', 10)));
    const now = DateTime.now().setZone(ZONE);
    const timeMin = now.toUTC().toISO();
    const timeMax = now.plus({ days }).toUTC().toISO();

    const resp = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin, timeMax,
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 250,
    });

    const events = (resp.data.items || []).map(ev => ({
      id: ev.id,
      summary: ev.summary || '(Sin título)',
      location: ev.location || '',
      description: ev.description || '',
      start: ev.start?.dateTime || ev.start?.date || null,
      end:   ev.end?.dateTime   || ev.end?.date   || null,
      htmlLink: ev.htmlLink || null,
    }));

    res.json({ ok:true, events });
  } catch (e) {
    console.error('calendar events error', e?.response?.data || e);
    res.status(500).json({ ok:false, error:String(e?.response?.data || e?.message || e) });
  }
});



// Ruta estática para el logo
app.get('/assets/logo.svg', (req, res) => {
  res.type('image/svg+xml').send(LOGO_SVG);
});

app.get('/api/debug/events-by-day', async (req, res) => {
  try {
    const day = String(req.query.day || '').trim(); // AAAA-MM-DD
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return res.status(400).json({ ok:false, error:'formato_day' });

    const start = DateTime.fromISO(day, { zone: ZONE }).startOf('day');
    const end   = start.plus({ days: 1 });

    const resp = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin: start.toUTC().toISO(),
      timeMax: end.toUTC().toISO(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 250,
    });

    const items = (resp.data.items || []).map(ev => {
      const evStartISO = ev.start?.dateTime || ev.start?.date || null;
      const evStartLocal = evStartISO ? DateTime.fromISO(evStartISO).setZone(ZONE).toISO() : null;
      return { id: ev.id, summary: ev.summary || '', startLocal: evStartLocal, htmlLink: ev.htmlLink || null };
    });

    res.json({ ok:true, day, items });
  } catch (e) {
    console.error('debug events-by-day error', e);
    res.status(500).json({ ok:false, error:String(e?.message||e) });
  }
});


// ====================== Página del panel (rediseñada) ======================
const PANEL_HTML = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Panel WhatsApp • Bot de Citas</title>
<style>
:root{
  --bg:#f5f7fb; --card:#ffffff; --muted:#5c6b83; --text:#0b1320; --subtle:#334363;
  --line:#e6eaf4; --accent:#2d6cff; --accent-2:#00c2ae; --danger:#e5484d; --warning:#f59e0b;
  --bubble-in:#e8f0ff; --bubble-out:#f6f8ff; --shadow:0 8px 28px rgba(16,24,40,.08);
}
*{box-sizing:border-box} html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 system-ui,Segoe UI,Roboto;overflow:hidden}

/* Topbar */
.topbar{display:flex;align-items:center;justify-content:space-between;padding:10px 16px;background:#fff;border-bottom:1px solid var(--line);height:56px;position:sticky;top:0;z-index:5}
.brand{display:flex;align-items:center;gap:10px}
.brand img{width:28px;height:28px;display:block}
.brand span{font-weight:800;letter-spacing:.2px}

/* Layout */
.app{display:grid;grid-template-columns:240px 1fr;height:calc(100vh - 56px)}
.sidebar{background:#fff;border-right:1px solid var(--line)}
.side-head{display:flex;align-items:center;gap:8px;padding:14px;border-bottom:1px solid var(--line)}
.side-title{font-weight:800}
.side-menu{padding:10px;display:flex;flex-direction:column;gap:6px}
.menu-item{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:10px;border:1px solid transparent;background:transparent;color:var(--text);cursor:pointer}
.menu-item:hover{background:#f2f6ff}
.menu-item.active{border-color:var(--accent);background:#edf3ff}
.menu-icon{width:22px;text-align:center}

/* Content */
.content{padding:16px;height:100%;overflow:hidden}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;box-shadow:var(--shadow);overflow:hidden}
.section{padding:14px}

/* HOME */
.grid{display:grid;gap:14px}
.grid.home{grid-template-columns:1fr 1fr}
.kpis{display:grid;gap:12px;grid-template-columns:1fr 1fr}
.kpi{padding:16px;border:1px solid var(--line);border-radius:12px;background:#fff}
.kpi .big{font-size:26px;font-weight:800;margin-top:6px}
.list{padding:12px}
.row{display:flex;align-items:center;justify-content:space-between;padding:8px 10px;border-radius:8px;border:1px solid var(--line);background:#fff;margin:6px 0}

/* WHATSAPP */
.wa-wrap{display:grid;grid-template-columns:340px 1fr;gap:12px;height:100%}
.wa-tile{padding:16px}
.wa-qr{display:flex;align-items:center;justify-content:center;min-height:280px;border:1px dashed var(--line);border-radius:12px;background:#fafcff}
.btn{padding:10px 14px;border-radius:10px;border:1px solid var(--line);cursor:pointer;background:var(--accent);color:#fff}
.btn.ghost{background:#fff;color:var(--text)}
.badge{display:inline-block;min-width:18px;padding:0 6px;border-radius:999px;background:var(--accent);color:#fff;font-weight:700;font-size:12px}

/* ===== Conversaciones (scroll solo en lista y mensajes) ===== */
#view-conversaciones.card{display:block;height:100%}
.conv-grid{
  display:grid;
  grid-template-columns:330px 1fr 300px;
  gap:12px;
  height:100%;
  min-height:0;
  overflow:hidden;
}
.left,.right,.rem{min-width:0}

/* izquierda */
.left{display:flex;flex-direction:column;min-height:0;overflow:hidden}
.search{padding:10px;border-bottom:1px solid var(--line);background:#fff;flex:0 0 auto}
.tabs{display:flex;gap:8px;padding:10px;border-bottom:1px solid var(--line);background:#fff;flex:0 0 auto}
.tab{padding:6px 10px;border:1px solid var(--line);border-radius:999px;cursor:pointer;color:var(--subtle);background:#fff}
.tab.active{color:var(--text);border-color:var(--accent)}
.chatlist{
  flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;background:transparent
}
.chat{
  padding:10px 12px;border-bottom:1px solid var(--line);cursor:pointer;
  display:grid;grid-template-columns:36px 1fr auto;gap:10px;align-items:center;background:#fff;overflow:hidden
}
.chat:hover{background:#f7faff}
.avatar{width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,var(--accent),var(--accent-2));color:#fff;font-weight:700}
.cmeta{font-size:12px;color:var(--muted)}
.chat .last{max-width:90%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

/* centro */
.right{
  display:flex;flex-direction:column;min-height:0;overflow:hidden;background:#fff;border:1px solid var(--line);border-radius:12px
}
.toolbar{display:flex;align-items:center;gap:12px;padding:10px;border-bottom:1px solid var(--line);background:#fff;flex:0 0 auto}
.title{font-weight:800}
.pill{padding:6px 10px;border-radius:999px;border:1px solid var(--line);background:#fff;font-size:12px}
.messages{
  flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;
  padding:12px;display:flex;flex-direction:column;gap:8px;background:linear-gradient(180deg,transparent,#f7faff 30%,transparent)
}
.msg{
  max-width:70%;padding:10px 12px;border-radius:12px;border:1px solid var(--line);background:var(--bubble-out);
  word-break:break-word;overflow-wrap:anywhere
}
.me{align-self:flex-end;background:var(--bubble-in)}
.meta{font-size:11px;color:var(--muted);margin-top:4px}
.composer{display:flex;gap:8px;padding:10px;border-top:1px solid var(--line);background:#fff;flex:0 0 auto}
.input{width:100%;padding:10px 12px;border-radius:10px;border:1px solid var(--line);background:#fff;color:var(--text)}
.btn.accent2{background:var(--accent-2);border-color:var(--accent-2)}

/* derecha (recordatorios) */
.rem{padding:12px;border:1px solid var(--line);border-radius:12px;background:#fff;height:100%;display:grid;grid-template-rows:auto auto auto 1fr}
.rem h4{margin:4px 0 8px 0}
.small{font-size:12px;color:var(--muted)}
.rem ul{margin:8px 0;padding-left:18px}

/* Calendario */
.cal-wrap{display:flex;flex-direction:column;height:100%}
.cal-head{display:flex;gap:8px;align-items:center;justify-content:space-between;padding:10px;border-bottom:1px solid var(--line);background:#fff}
.cal-list{padding:10px;overflow:auto;min-height:0}
.cal-day{margin:10px 0}
.cal-day h3{margin:0 0 6px 0;font-size:13px;color:var(--subtle)}
.cal-ev{padding:10px;border:1px solid var(--line);border-radius:10px;margin:6px 0;background:#fff}
.cal-ev a{color:var(--accent)}

/* Tareas */
.tasks-wrap{padding:12px;height:100%;overflow:auto}
.task{display:grid;grid-template-columns:36px 1fr auto;gap:10px;align-items:center;border:1px solid var(--line);border-radius:12px;background:#fff;padding:10px;margin:8px 0}
.task .who{font-weight:700}
</style>
</head>
<body>
<div class="topbar">
  <div class="brand">
    <img src="/assets/logo.svg" alt="logo"/>
    <span>Panel WhatsApp • Bot de Citas</span>
  </div>
  <div class="tools" style="display:flex;gap:8px;align-items:center">
    <span class="small">IA Global</span>
    <label class="pill"><input id="aiGlobalToggle" type="checkbox"/> ON</label>
    <button id="relinkBtnTop" class="btn ghost" title="Nuevo QR / re-vincular">🔗 Re-vincular</button>
  </div>
</div>

<div class="app">
  <!-- Sidebar fija -->
  <aside class="sidebar">
    <div class="side-head"><span class="side-title">Menú</span></div>
    <div class="side-menu">
      <button data-view="home" class="menu-item active"><span class="menu-icon">🏠</span><span class="menu-text">Home</span></button>
      <button data-view="whatsapp" class="menu-item"><span class="menu-icon">📱</span><span class="menu-text">WhatsApp</span></button>
      <button data-view="conversaciones" class="menu-item"><span class="menu-icon">💬</span><span class="menu-text">Conversaciones</span></button>
      <button data-view="calendario" class="menu-item"><span class="menu-icon">📅</span><span class="menu-text">Calendario</span></button>
      <button data-view="tareas" class="menu-item"><span class="menu-icon">✅</span><span class="menu-text">Tareas</span></button>
    </div>
  </aside>

  <!-- Content -->
  <main class="content">
    <!-- HOME -->
    <section id="view-home" class="grid home">
      <div class="card section">
        <h2>Resumen</h2>
        <div class="kpis" id="kpisBox">
          <div class="kpi"><div>Mensajes hoy</div><div id="kpiMsgs" class="big">–</div></div>
          <div class="kpi"><div>Eventos próximos</div><div id="kpiEvents" class="big">–</div></div>
        </div>
        <div class="list" id="homeRecent">
          <h3>Conversaciones recientes</h3>
          <div id="homeRecentList"></div>
        </div>
      </div>
      <div class="card section">
        <h2>Estado</h2>
        <div class="row"><div>WhatsApp</div><div id="homeConn">—</div></div>
        <div class="row"><div>IA Global</div><div id="homeAI">—</div></div>
        <div class="row"><div>No leídos</div><div id="homeUnread">—</div></div>
      </div>
    </section>

    <!-- WhatsApp -->
    <section id="view-whatsapp" class="card" style="display:none;height:100%">
      <div class="wa-wrap">
        <div class="wa-tile">
          <h2>Vinculación WhatsApp</h2>
          <p class="small" id="waStatusText">Estado: —</p>
          <div class="wa-qr" id="waQRBox"><div id="waQRInner">Cargando QR…</div></div>
          <div style="margin-top:10px; display:flex; gap:8px;">
            <button id="relinkBtn" class="btn ghost">Re-vincular</button>
            <button id="refreshQRBtn" class="btn ghost">Refrescar QR</button>
          </div>
        </div>
        <div class="wa-tile">
          <h3>Sesión actual</h3>
          <div id="waSessionBox" class="card" style="padding:10px; margin-top:8px;">
            <div id="waSessionInfo">—</div>
          </div>
          <p class="small" style="margin-top:8px">Si ya estás conectado, el QR no se mostrará.</p>
        </div>
      </div>
    </section>

    <!-- Conversaciones -->
    <section id="view-conversaciones" class="card" style="display:none;height:100%">
      <div class="conv-grid">
        <div class="left">
          <div class="search"><input id="search" class="input" placeholder="Buscar por número o nombre"/></div>
          <div class="tabs">
            <button id="tabRecent" class="tab active">Recientes</button>
            <button id="tabUnread" class="tab">No leídos <span id="badgeUnread" class="badge" style="display:none">0</span></button>
            <button id="tabRead" class="tab">Leídos</button>
          </div>
          <div class="chatlist" id="chatlist"></div>
        </div>
        <div class="right">
          <div class="toolbar">
            <div id="chatTitle" class="title">Selecciona un chat</div>
            <div style="margin-left:auto;display:flex;gap:12px;align-items:center">
              <span id="aiChatStatus" class="pill">IA: OFF</span>
              <label class="pill"><input id="chatToggle" type="checkbox"/> IA en este chat</label>
            </div>
          </div>
          <div class="messages" id="messages"></div>
          <div class="composer">
            <input id="composerInput" class="input" placeholder="Escribe un mensaje manual... (no usa IA)"/>
            <button id="sendBtn" class="btn accent2">Enviar</button>
          </div>
        </div>
        <!-- Recordatorios -->
        <aside class="rem">
          <div><h4>Recordatorios de cita</h4><div class="small">Programa avisos automáticos para este chat.</div></div>
          <div><label class="pill"><input id="remEnabled" type="checkbox"/> Activar</label></div>
          <div style="display:grid;gap:8px">
            <label>Fecha y hora de la cita
              <input id="remAppt" type="datetime-local" class="input" />
            </label>
            <label>Plan
              <select id="remPlan" class="input">
                <option value="1h">1 hora antes</option>
                <option value="24h">24 horas + 1 hora</option>
                <option value="1m">1 mes + 24h + 1h</option>
                <option value="3m">3m + 1m + 24h + 1h</option>
                <option value="6m">6m + 3m + 1m + 24h + 1h</option>
                <option value="1y">1a + 6m + 3m + 1m + 24h + 1h</option>
              </select>
            </label>
            <!-- NUEVO: plantilla del mensaje -->
            <label>Plantilla del mensaje
              <textarea id="remTpl" class="input" rows="5"
                placeholder="Hola, {nombre}. Tienes una cita el {fecha} a las {hora}."></textarea>
            </label>
            <div class="small">
              Etiquetas: <code>{nombre}</code> <code>{fecha}</code> <code>{hora}</code>
              <code>{fecha_hora}</code> <code>{jid}</code> <code>{tipo}</code>
            </div>
            <button id="remSaveBtn" class="btn">Guardar</button>
            <div id="remStatus" class="small">—</div>
            <div style="margin-top:6px">
              <strong>Vista previa</strong>
              <div id="remPreview" class="card" style="padding:8px;margin-top:6px"></div>
            </div>
          </div>
          <div>
            <h4>Próximos avisos</h4>
            <ul id="remListTimes"><li class="small">—</li></ul>
          </div>
        </aside>
      </div>
    </section>

    <!-- Calendario -->
    <section id="view-calendario" class="card" style="display:none;height:100%">
      <div class="cal-wrap">
        <div class="cal-head">
          <div><strong>Calendario vinculado</strong></div>
          <div>
            <select id="calRange" class="input" style="width:auto">
              <option value="7">Próximos 7 días</option>
              <option value="14" selected>Próximos 14 días</option>
              <option value="30">Próximos 30 días</option>
            </select>
            <button id="calReload" class="btn ghost">Actualizar</button>
          </div>
        </div>
        <div class="cal-list" id="calList"></div>
      </div>
    </section>

    <!-- Tareas -->
    <section id="view-tareas" class="card" style="display:none;height:100%">
      <div class="tasks-wrap">
        <h2>Recordatorios programados</h2>
        <div id="tasksList"></div>
      </div>
    </section>
  </main>
</div>

<script>
/* ===== Helpers ===== */
const $ = s => document.querySelector(s);
function fmtTime(ts){try{return new Date(ts).toLocaleString();}catch{return''}}
function toInputLocal(iso){ if(!iso) return ''; const d=new Date(iso); const t = new Date(d.getTime()-d.getTimezoneOffset()*60000); return t.toISOString().slice(0,16); }

/* ===== Flags para evitar que se borre la fecha mientras editas ===== */
let remDirty = false;     // hay cambios no guardados
let remEditing = false;   // el input tiene foco

/* ===== Navegación ===== */
const menuBtns = document.querySelectorAll('.menu-item');
const views = { home: $('#view-home'), whatsapp: $('#view-whatsapp'), conversaciones: $('#view-conversaciones'), calendario: $('#view-calendario'), tareas: $('#view-tareas') };
function showView(id){ Object.values(views).forEach(v=>v.style.display='none'); views[id].style.display='block'; menuBtns.forEach(b=>b.classList.toggle('active', b.dataset.view===id)); }
menuBtns.forEach(b=>b.onclick=()=>{ showView(b.dataset.view); if (b.dataset.view==='home') loadHome(); if (b.dataset.view==='tareas') loadTasks(); if (b.dataset.view==='calendario') loadCalendar(); if (b.dataset.view==='whatsapp') loadWAStatus(); });

/* ===== IA Global ===== */
async function syncGlobalAI(){ const r = await fetch('/api/panel/state'); const st = await r.json(); $('#aiGlobalToggle').checked = !!st.aiGlobalEnabled; }
$('#aiGlobalToggle').addEventListener('change', async e=>{ await fetch('/api/panel/toggle-ai-global',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:!!e.target.checked})}); loadHome(); });

/* ===== HOME (con fallback si /api/panel/metrics no existe) ===== */
async function loadHome(){
  try{
    const r = await fetch('/api/panel/metrics'); 
    if(r.ok){
      const m = await r.json();
      $('#kpiMsgs').textContent = m.messagesToday ?? '—';
      $('#kpiEvents').textContent = m.eventsNext ?? '—';
      $('#homeConn').textContent = m.connected ? 'Conectado' : 'No conectado';
      $('#homeAI').textContent = m.aiGlobalEnabled ? 'ON' : 'OFF';
      $('#homeUnread').textContent = m.unreadTotal ?? '—';
      const box = $('#homeRecentList'); box.innerHTML='';
      (m.recentTop||[]).forEach(c=>{
        const div = document.createElement('div'); div.className='row';
        div.innerHTML = \`<div><strong>\${c.name}</strong> <span class="cmeta">(\${c.jid})</span><div class="cmeta">\${c.lastText||''}</div></div><div class="cmeta">\${new Date(c.lastTs).toLocaleTimeString()}</div>\`;
        div.onclick = ()=>{ openChat(c.jid); showView('conversaciones'); };
        box.appendChild(div);
      });
      return;
    }
  }catch{}
  // Fallback mínimo usando /api/panel/chats
  const rc = await fetch('/api/panel/chats'); const data = await rc.json();
  const chats = data.chats||[];
  $('#kpiMsgs').textContent = '—';
  $('#kpiEvents').textContent = '—';
  $('#homeConn').textContent = '—';
  $('#homeAI').textContent = '—';
  $('#homeUnread').textContent = chats.reduce((a,c)=>a+(c.unreadCount||0),0);
  const box = $('#homeRecentList'); box.innerHTML='';
  chats.slice(0,5).forEach(c=>{
    const div = document.createElement('div'); div.className='row';
    div.innerHTML = \`<div><strong>\${c.name||c.jid}</strong> <span class="cmeta">(\${c.jid})</span><div class="cmeta">\${c.lastText||''}</div></div><div class="cmeta">\${new Date(c.lastTs||Date.now()).toLocaleTimeString()}</div>\`;
    div.onclick = ()=>{ openChat(c.jid); showView('conversaciones'); };
    box.appendChild(div);
  });
}

/* ===== WhatsApp ===== */
async function loadWAStatus(){
  const r = await fetch('/api/wa/status'); const data = await r.json();
  $('#waStatusText').textContent = data.connected ? 'Estado: Conectado' : 'Estado: No conectado';
  $('#waSessionInfo').innerHTML = data.connected ? \`<div><strong>JID:</strong> \${data.jid}</div><div><strong>Nombre:</strong> \${data.name || '-'}</div>\` : 'No hay sesión activa.';
  if (!data.connected) await loadWAQR(); else $('#waQRInner').innerHTML = 'Dispositivo conectado. No se requiere QR.';
}
async function loadWAQR(){
  const box = $('#waQRInner');
  try { const r = await fetch('/api/wa/qr'); if (!r.ok) { box.innerHTML = 'No hay QR disponible. Presiona "Re-vincular".'; return; }
    const { dataUrl } = await r.json(); box.innerHTML = \`<img src="\${dataUrl}" alt="QR" style="image-rendering:pixelated;max-width: 240px;"/>\`; }
  catch { box.textContent = 'Error cargando QR.'; }
}
$('#relinkBtn').onclick = async ()=>{ await fetch('/api/panel/relink',{method:'POST'}); setTimeout(loadWAStatus, 800); };
$('#relinkBtnTop').onclick = $('#relinkBtn').onclick;
$('#refreshQRBtn').onclick = loadWAQR;
setInterval(loadWAStatus, 4000);

/* ===== Conversaciones ===== */
let chats = []; let currentJid = null; let currentTab = 'recent';
async function fetchChats(){ const r=await fetch('/api/panel/chats'); const data=await r.json(); chats=data.chats||[]; updateUnreadBadge(); renderChatList($('#search').value||''); }
async function fetchMessages(opts = { reloadRem: true }) {
  if(!currentJid){
    $('#chatTitle').textContent='Selecciona un chat';
    $('#messages').innerHTML='';
    $('#aiChatStatus').textContent='IA: OFF';
    return;
  }
  const r=await fetch('/api/panel/messages?jid='+encodeURIComponent(currentJid)); const data=await r.json();
  $('#chatTitle').innerHTML=\`<strong>\${data.name}</strong> <span class="cmeta">(\${data.jid})</span>\`;
  $('#chatToggle').checked=!!data.aiEnabled; $('#aiChatStatus').textContent='IA: '+(data.aiEnabled?'ON':'OFF');
  const cont=$('#messages'); cont.innerHTML='';
  for(const m of (data.messages||[])){
    const el=document.createElement('div'); el.className='msg'+(m.fromMe?' me':''); el.innerHTML=\`<div>\${m.text||''}</div><div class="meta">\${m.fromMe?'Tú':'Contacto'} • \${fmtTime(m.ts)}</div>\`; cont.appendChild(el);
  }
  cont.scrollTop=cont.scrollHeight;
  await fetch('/api/panel/mark-read',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({jid:currentJid})});
  fetchChats();
  if (opts.reloadRem && !remEditing && !remDirty) { loadReminderUI(currentJid); }
}
function updateUnreadBadge(){ const totalUnread = chats.reduce((a,c)=> a + (c.unreadCount||0), 0); const bd = $('#badgeUnread'); if (totalUnread>0){ bd.style.display='inline-block'; bd.textContent=totalUnread; } else bd.style.display='none'; }
function renderChatList(filter=''){ const list=$('#chatlist'); list.innerHTML=''; const f=(filter||'').toLowerCase();
  const subset = chats.filter(c=>{ const matches = c.jid.toLowerCase().includes(f) || String(c.name||'').toLowerCase().includes(f);
    if (!matches) return false; if (currentTab==='unread') return (c.unreadCount||0)>0; if (currentTab==='read') return (c.unreadCount||0)===0; return true; });
  for(const c of subset){ const div=document.createElement('div'); div.className='chat';
    const initials=(String(c.name||c.jid).trim()[0]||'?').toUpperCase();
    div.innerHTML=\`
      <div class="avatar">\${initials}</div>
      <div>
        <div><strong>\${c.name || c.jid}</strong> <span class="cmeta">(\${c.jid})</span></div>
        <div class="cmeta last">\${c.lastText||''}</div>
      </div>
      <div style="display:flex;gap:8px;align-items:center">\${(c.unreadCount||0)>0?'<span class="badge">'+c.unreadCount+'</span>':''}
      <span class="cmeta">\${new Date(c.lastTs||Date.now()).toLocaleTimeString()}</span></div>\`;
    div.onclick=()=>openChat(c.jid); list.appendChild(div);
  }
}
async function openChat(jid){ currentJid=jid; showView('conversaciones'); await fetchMessages({ reloadRem: true }); }
$('#tabRecent').onclick=()=>{currentTab='recent'; $('#tabRecent').classList.add('active'); $('#tabUnread').classList.remove('active'); $('#tabRead').classList.remove('active'); renderChatList($('#search').value||'');};
$('#tabUnread').onclick=()=>{currentTab='unread'; $('#tabRecent').classList.remove('active'); $('#tabUnread').classList.add('active'); $('#tabRead').classList.remove('active'); renderChatList($('#search').value||'');};
$('#tabRead').onclick  =()=>{currentTab='read';   $('#tabRecent').classList.remove('active'); $('#tabUnread').classList.remove('active'); $('#tabRead').classList.add('active'); renderChatList($('#search').value||'');};
$('#search').addEventListener('input', e=>renderChatList(e.target.value));
$('#chatToggle').addEventListener('change', async e=>{ if(!currentJid) return; await fetch('/api/panel/toggle-ai-chat',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({jid:currentJid,enabled:!!e.target.checked})}); $('#aiChatStatus').textContent='IA: '+(e.target.checked?'ON':'OFF'); fetchChats(); });
$('#sendBtn').onclick = sendManual;
$('#composerInput').addEventListener('keydown', e=>{ if(e.key==='Enter') sendManual(); });
async function sendManual(){ const inp=$('#composerInput'); const txt=(inp.value||'').trim(); if(!txt||!currentJid) return; await fetch('/api/panel/send',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jid:currentJid,text:txt})}); inp.value=''; fetchMessages({ reloadRem: false }); }

/* ===== Recordatorios UI ===== */
async function loadReminderUI(jid){
  if (remEditing || remDirty) return; // no pisar mientras editas
  const r = await fetch('/api/panel/reminders?jid='+encodeURIComponent(jid)); const data = await r.json();
  const cfg = data.reminder || null;
  $('#remEnabled').checked = !!cfg?.enabled;
  $('#remPlan').value = cfg?.plan || '24h';
  $('#remAppt').value = cfg?.appointmentISO ? toInputLocal(cfg.appointmentISO) : '';
  $('#remTpl').value = (cfg?.template) || \`🔔 *Recordatorio de cita*\\nHola, {nombre}. Tienes una cita el *{fecha}* a las *{hora}*.\\nSi necesitas reprogramar, responde a este mensaje.\`;
  renderTimes(cfg?.timesISO||[]);
  $('#remStatus').textContent = cfg ? 'Configuración cargada' : 'Sin configuración';
  updatePreview();
}
function renderTimes(list){ const ul = $('#remListTimes'); ul.innerHTML = ''; if(!list.length){ ul.innerHTML='<li class="small">—</li>'; return; } list.forEach(t=>{ const li=document.createElement('li'); li.textContent=new Date(t).toLocaleString(); ul.appendChild(li); }); }

// Marcar edición/dirty para no sobrescribir tu input
$('#remAppt').addEventListener('focus', ()=>{ remEditing = true; });
$('#remAppt').addEventListener('blur',  ()=>{ remEditing = false; updatePreview(); });
$('#remAppt').addEventListener('input', ()=>{ remDirty = true; updatePreview(); });
$('#remPlan').addEventListener('change', ()=>{ remDirty = true; updatePreview(); });
$('#remTpl').addEventListener('input', ()=>{ remDirty = true; updatePreview(); });

// Guardar
$('#remSaveBtn').onclick = async ()=>{
  if(!currentJid) return;
  const raw = $('#remAppt').value;
  const body = { jid: currentJid, enabled: !!$('#remEnabled').checked, plan: $('#remPlan').value, appointmentISO: raw || null, template: $('#remTpl').value };
  $('#remStatus').textContent = 'Guardando...';
  try{
    const r = await fetch('/api/panel/reminders',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const data = await r.json();
    if (data.ok){
      remDirty = false; remEditing = false;
      $('#remStatus').textContent='✅ Guardado';
      $('#remEnabled').checked=!!data.reminder.enabled;
      renderTimes(data.reminder.timesISO||[]);
      updatePreview();
      loadTasks();
    } else { $('#remStatus').textContent='⚠ '+(data.error||'Error'); }
  }catch{ $('#remStatus').textContent='❌ Error de conexión'; }
};

// Toggle directo – solo si hay fecha válida
$('#remEnabled').addEventListener('change', async (e)=>{
  if(!currentJid) return; const enabled=!!e.target.checked; const raw=$('#remAppt').value;
  if (enabled && !raw){ $('#remStatus').textContent='Primero elige fecha y hora'; e.target.checked=false; return; }
  const body={ jid: currentJid, enabled, plan: $('#remPlan').value, appointmentISO: raw || null, template: $('#remTpl').value };
  try{
    const r=await fetch('/api/panel/reminders',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const data=await r.json();
    if (!data.ok){ e.target.checked=!enabled; $('#remStatus').textContent='⚠ '+(data.error||'Error'); return; }
    remDirty = false; remEditing = false;
    $('#remStatus').textContent = enabled ? '✅ Activado' : '⏸ Desactivado';
    renderTimes(data.reminder.timesISO||[]);
    updatePreview();
    loadTasks();
  }catch{ e.target.checked=!enabled; $('#remStatus').textContent='❌ Error de conexión'; }
});

// Vista previa local de plantilla
function updatePreview(){
  const raw = $('#remTpl').value || '';
  const apptVal = $('#remAppt').value;
  let fecha = '', hora = '', fecha_hora = '';
  if (apptVal){
    const d = new Date(apptVal);
    fecha = d.toLocaleDateString('es-CO', { day:'numeric', month:'long', year:'numeric' });
    hora = d.toLocaleTimeString('es-CO', { hour:'2-digit', minute:'2-digit' });
    fecha_hora = fecha + ' a las ' + hora;
  }
  const ctx = {
    nombre: ($('#chatTitle').textContent.split('(')[0]||'paciente').trim(),
    fecha, hora, fecha_hora,
    jid: (currentJid||'').split('@')[0],
    tipo: 'consulta'
  };
  const out = raw.replace(/\{(nombre|fecha|hora|fecha_hora|jid|tipo)\}/gi, (_,k)=> ctx[k.toLowerCase()] ?? '');
  $('#remPreview').textContent = out;
}

/* ===== Calendario ===== */
function groupByDate(evts){ const map = new Map(); for(const e of evts){ const dateKey = (e.start || '').slice(0,10); if(!map.has(dateKey)) map.set(dateKey, []); map.get(dateKey).push(e); } return Array.from(map.entries()).sort((a,b)=>a[0].localeCompare(b[0])); }
async function loadCalendar(){
  const days=$('#calRange').value||'14'; const r=await fetch('/api/calendar/events?days='+encodeURIComponent(days)); const data=await r.json();
  const list=$('#calList'); list.innerHTML='';
  if(!data.ok){ list.textContent='Error cargando eventos: '+(data.error||''); console.error('calendar error', data); return; }
  const groups=groupByDate(data.events||[]); if(groups.length===0){ list.textContent='Sin eventos en el rango.'; return; }
  for(const [date, evs] of groups){ const dayDiv=document.createElement('div'); dayDiv.className='cal-day'; const h=document.createElement('h3'); h.textContent=new Date(date).toLocaleDateString(); dayDiv.appendChild(h);
    evs.forEach(ev=>{ const el=document.createElement('div'); el.className='cal-ev'; const timeTxt=(ev.start && ev.start.length>10)?(new Date(ev.start)).toLocaleTimeString():'Todo el día'; el.innerHTML=\`<div><strong>\${ev.summary||'(Sin título)'}</strong></div><div>\${timeTxt}\${ev.location?' • '+ev.location:''}</div>\${ev.htmlLink?'<div><a target="_blank" href="'+ev.htmlLink+'">Abrir en Google Calendar</a></div>':''}\`; dayDiv.appendChild(el);});
    list.appendChild(dayDiv); }
}
$('#calRange').onchange = loadCalendar;
$('#calReload').onclick = loadCalendar;

/* ===== Tareas (lista de recordatorios) ===== */
async function loadTasks(){
  const r = await fetch('/api/panel/reminders'); const data = await r.json();
  const list = $('#tasksList'); list.innerHTML='';
  (data.reminders||[]).filter(x=>x.enabled).forEach(rm=>{
    const next = (rm.timesISO||[])[0] ? new Date(rm.timesISO[0]).toLocaleString() : '—';
    const div = document.createElement('div'); const initials=(String(rm.name||rm.jid).trim()[0]||'?').toUpperCase();
    div.className='task';
    div.innerHTML=\`
      <div class="avatar">\${initials}</div>
      <div>
        <div class="who">\${rm.name||rm.jid} <span class="cmeta">(\${rm.jid})</span></div>
        <div class="cmeta">Cita: \${rm.appointmentISO ? new Date(rm.appointmentISO).toLocaleString() : '—'} • Plan: \${rm.plan}</div>
        <div class="cmeta">Próximo aviso: \${next}</div>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn ghost">Abrir chat</button>
        <label class="pill"><input type="checkbox" \${rm.enabled?'checked':''} data-jid="\${rm.jid}" class="t-toggle"/> Activo</label>
      </div>\`;
    div.querySelector('.btn.ghost').onclick = ()=>{ openChat(rm.jid); showView('conversaciones'); };
    list.appendChild(div);
  });
  document.querySelectorAll('.t-toggle').forEach(chk=>{
    chk.addEventListener('change', async (e)=>{
      const jid = e.target.getAttribute('data-jid');
      await fetch('/api/panel/reminders',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({jid, enabled: !!e.target.checked})});
      loadTasks();
    });
  });
}

/* ===== Boot ===== */
async function boot(){
  await syncGlobalAI();
  await fetchChats();
  await loadHome();
  setInterval(async()=>{
    await fetchChats();
    if(views.conversaciones.style.display==='block' && currentJid){
      await fetchMessages({ reloadRem: false }); // no pisar recordatorio mientras editas
    }
    if(views.whatsapp.style.display==='block') await loadWAStatus();
  }, 3000);
}
boot();
</script>
</body>
</html>`;

app.get('/panel', (req, res) => res.type('html').send(PANEL_HTML));

// ====== HELPERS: extracción de datos del paciente ======
function cleanBase(str = "") {
  return String(str || "")
    .replace(/[🏠📍➡️←↑↓🏢🏘️🛣️🛤️]/g, " ")         // emojis de dirección
    .replace(/\s+/g, " ")                         // espacios dobles
    .trim()
    .toLowerCase();
}

function isCoomevaPreferente(text) {
  const t = String(text || '').toLowerCase();

  if (!/coomeva/.test(t)) return false;
  if (/\bpreferent(e|es)?\b/.test(t)) return true;

  return false;
}



function ensurePatient(session){
  if(!session.patient) session.patient = {};
  return session.patient;
}

// CÉDULA
function extractCedula(s){ 
  const m=(s||'').match(/\b(\d{6,12})\b/); 
  return m?m[1]:null; 
}

// CELULAR (con prefijos +57, 57, 3…)
function extractPhone(s){
  const clean=(s||'').replace(/\D+/g,'');
  const m=clean.match(/(57)?3\d{9}/);
  if(!m) return null;
  const v=m[0];
  return v.startsWith("57") ? ("+"+v) : ("+57"+v);
}

// EMAIL con corrección de errores comunes
function extractEmail(s){ 
  let m=(s||'').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i); 
  if(!m) return null;

  let email = m[0].toLowerCase();
  email = email.replace(/@gmai\.com/, '@gmail.com')
               .replace(/@hotmil\.com/, '@hotmail.com')
               .replace(/@outllok\.com/, '@outlook.com');
  return email;
}


// AAAA-MM-DD o dd/mm/aaaa
function extractFechaNacimiento(s){
  const t = cleanBase(s);

  // 2024-12-20
  const m1=t.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if(m1) return `${m1[1]}-${m1[2]}-${m1[3]}`;

  // 20/12/2024
  const m2=t.match(/\b(\d{2})\/(\d{2})\/(\d{4})\b/);
  if(m2) return `${m2[3]}-${m2[2]}-${m2[1]}`;

  return null;
}


// A+, A-, B+, B-, AB+, AB-, O+, O-
function extractBloodType(s){
  const m=(s||'').toUpperCase().match(/\b(AB|A|B|O)\s*([+-])\b/);
  return m ? (m[1]+m[2]) : null;
}


const CIVILES=[
  'soltero','soltera','casado','casada',
  'union libre','unión libre',
  'divorciado','divorciada','viudo','viuda'
];

function extractEstadoCivil(s){
  const low=cleanBase(s);
  const f=CIVILES.find(x=>low.includes(x));
  return f ? (f[0].toUpperCase()+f.slice(1)) : null;
}


// heurísticas rápidas (opcional)
function extractDireccion(s){
  let t = cleanBase(s);

  // normalizar abreviaciones
  t = t.replace(/\b(carr?e?ra?|krr|kr|crr|crra|cra|cr)\b/g, "cra");
  t = t.replace(/\b(calle|cll|cl)\b/g, "cl");
  t = t.replace(/\b(avenida|av)\b/g, "av");
  t = t.replace(/\b(diagonal|dg)\b/g, "dg");
  t = t.replace(/\b(transversal|tv)\b/g, "tv");

  // convertir # raro
  t = t.replace(/#/g, " # ");

  // separar letras y números pegados
  t = t.replace(/([a-z]+)(\d)/g, "$1 $2");
  t = t.replace(/(\d)([a-z]+)/g, "$1 $2");

  // patrón típico de dirección
  const dir = t.match(/\b(cra|cl|av|dg|tv)\b[\s\S]{0,50}/i);
  if (dir) return dir[0].trim();

  // fallback con numeral
  const m2 = s.match(/[^\n]{0,40}#\s*\d{1,4}[-–]\d{1,5}/);
  if (m2) return m2[0].trim();

  return null;
}


function extractCiudad(s){
  const cities = [
    "barranquilla","bogota","bogotá","medellin","medellín",
    "cali","soledad","cartagena","santa marta","valledupar",
    "bucaramanga","envigado","itaguí","sabaneta"
  ];
  const t = cleanBase(s);
  const c = cities.find(ci => t.includes(ci));
  return c ? c.charAt(0).toUpperCase() + c.slice(1) : null;
}

const ENTIDADES_CANON = [
  'Sudamericana',
  'Colsanitas',
  'Medplus',
  'Bolivar',
  'Allianz',
  'Colmedica',
  'Coomeva',
  'Particular',
];

function normalizeEntidadSalud(raw) {
  const txt = String(raw || '').toLowerCase();

  if (!txt.trim()) return null;

  // Sudamericana
  if (/suda\s*americana|sudamericana/.test(txt)) return 'Sudamericana';

  // Colsanitas
  if (/col\s*sanitas|colsanitas/.test(txt)) return 'Colsanitas';

  // Medplus
  if (/med\s*plus|medplus/.test(txt)) return 'Medplus';

  // Bolívar / Bolivar
  if (/bol[ií]var|bolivar/.test(txt)) return 'Bolivar';

  // Allianz
  if (/allianz/.test(txt)) return 'Allianz';

  // Colmédica / Colmedica
  if (/colm[eé]dica|colmedica/.test(txt)) return 'Colmedica';

  // Coomeva (cualquier plan, el plan lo vemos aparte)
  if (/coomeva/.test(txt)) return 'Coomeva';

  // Particular
  if (/particular|pago\s*particular/.test(txt)) return 'Particular';

  // Si no coincide con nada conocido → NO es entidad válida
  return null;
}


// va “aspirando” datos desde cualquier mensaje del paciente
function collectPatientFields(session, text){
  const p = ensurePatient(session);
  const t = text || '';

  p.nombre            = p.nombre            || null; // nombre se suele pedir explícitamente
  p.cedula            = p.cedula            || extractCedula(t);
  p.celular           = p.celular           || extractPhone(t);
  p.correo            = p.correo            || extractEmail(t);
  p.fecha_nacimiento  = p.fecha_nacimiento  || extractFechaNacimiento(t);
  p.tipo_sangre       = p.tipo_sangre       || extractBloodType(t);
  p.estado_civil      = p.estado_civil      || extractEstadoCivil(t);
  p.direccion         = p.direccion         || extractDireccion(t);
  p.ciudad            = p.ciudad            || extractCiudad(t);

  // 🔴 ENTIDAD: solo aceptamos algo si pasa por normalizeEntidadSalud
  const candEntidad = normalizeEntidadSalud(t);
  if (!p.entidad_salud && candEntidad) {
    p.entidad_salud = candEntidad;
  }

  return p;
}


function requiredForTipo(tipo){
  const base = ['nombre','cedula','entidad_salud','correo','celular','direccion','ciudad'];
  if (/primera\s*vez/i.test(tipo)) {
    return [...base, 'fecha_nacimiento','tipo_sangre','estado_civil'];
  }
  return base;
}

function missingForTipo(session, tipo){
  const p = ensurePatient(session);
  return requiredForTipo(tipo).filter(k => !p[k]);
}

function pushKnownPatientNote(session) {
  const p = ensurePatient(session);
  const partes = [];

  if (session.tipoActual) {
    partes.push(`Motivo de consulta actual: "${session.tipoActual}". No vuelvas a preguntar por el motivo salvo que la paciente diga explícitamente que lo quiere cambiar.`);
  }

  if (p.nombre) {
    partes.push(`Nombre completo ya registrado: ${p.nombre}. No vuelvas a pedir el nombre.`);
  }
  if (p.cedula) {
    partes.push(`Cédula ya registrada: ${p.cedula}. No vuelvas a pedirla.`);
  }
  if (p.entidad_salud) {
    partes.push(`Entidad de salud ya registrada: ${p.entidad_salud}. No vuelvas a preguntar por EPS/seguro a menos que la paciente diga que quiere cambiarla.`);
  }
  if (p.correo) {
    partes.push(`Correo ya registrado: ${p.correo}. No vuelvas a pedirlo.`);
  }
  if (p.celular) {
    partes.push(`Celular ya registrado: ${p.celular}. No vuelvas a pedirlo.`);
  }
  if (p.direccion) {
    partes.push(`Dirección ya registrada: ${p.direccion}. No vuelvas a pedirla.`);
  }
  if (p.ciudad) {
    partes.push(`Ciudad ya registrada: ${p.ciudad}. No vuelvas a pedirla.`);
  }

  if (!partes.length) return;

  session.history.push({
    role: 'system',
    content:
      'IMPORTANTE (memoria de datos del paciente): ' +
      partes.join(' ') +
      ' Usa estos datos como verdad actual. Si necesitas repetirlos, hazlo a partir de esta nota, pero no vuelvas a pedirlos como si no los tuvieras.'
  });
}

function needEntidadBeforeDispon(session) {
  const p = ensurePatient(session);
  return !p.entidad_salud;
}

function normalizeTipo(tipo) {
  const s = String(tipo || '').toLowerCase();

  if (!s) return 'Control presencial';

  if (s.includes('virtual')) {
    // Cualquier cosa con "virtual" lo tratamos como control virtual
    return 'Control virtual';
  }
  if (s.includes('primera')) {
    return 'Primera vez';
  }
  if (s.includes('biopsia')) {
    return 'Biopsia guiada por ecografía';
  }

  // Todo lo demás lo tratamos como control presencial
  return 'Control presencial';
}

function replyAskEntidad(res, session) {
  const reply =
    'Antes de revisar la disponibilidad de citas, necesito que me indiques ' +
    'con qué entidad de salud estás afiliado (por ejemplo, Colsanitas, Sura, Coomeva, MedPlus, etc.) ' +
    'o si prefieres atenderte como *particular*.';

  session.history.push({ role: 'assistant', content: reply });
  capHistory(session);
  touchSession(session);
  res.json({ reply, makeResponse: null });
  return true; // para poder hacer "if (replyAskEntidad(...)) return;"
}


// ===== CONFIG opcional por ENV =====
const LLM_DOWN_MINUTES   = Number(process.env.LLM_DOWN_MINUTES || 45);
const LLM_DOWN_MESSAGE   = process.env.LLM_DOWN_MESSAGE 
  || '⚠️ No estamos disponibles en este momento por ajustes técnicos. Un asesor te contactará en breve. Gracias por tu paciencia.';

// ===== Detectar errores de cuota/conexión del LLM =====
function isQuotaOrConnError(e){
  const msg = String(e?.message || e?.toString() || '').toLowerCase();
  const code = e?.status || e?.response?.status;
  // 429 (quota/ratelimit), 402 (billing), o mensajes típicos
  return code === 429 || code === 402 ||
         msg.includes('you exceeded your current quota') ||
         msg.includes('rate limit') ||
         msg.includes('billing') ||
         msg.includes('connection error') ||
         msg.includes('ecconnreset') ||
         msg.includes('timeout');
}

// ===== LLM con reintentos (4o → 4o-mini) y si falla, lanza error =====
async function callLLMWithGuard(messages, { model='gpt-4o', temperature=0.4, retries=2 } = {}){
  try{
    return await openai.chat.completions.create({ model, messages, temperature });
  }catch(e1){
    if (retries <= 0) throw e1;
    // Reintento con modelo más barato/ligero
    try{
      console.warn('[LLM][RETRY] cambiando a gpt-4o-mini por error:', e1?.message);
      return await openai.chat.completions.create({ model:'gpt-4o-mini', messages, temperature });
    }catch(e2){
      // último intento fallido → propagar
      throw e2;
    }
  }
}

// ===== Apagar IA del chat + mensaje amable al usuario + logs =====
async function handleLLMFailureAndDisableChat(jid, err){
  try{
    const session = getSession(jid);
    const now = DateTime.now().setZone(ZONE);
    const until = now.plus({ minutes: LLM_DOWN_MINUTES });

    // Apaga IA sólo en este chat
    session.llmDownUntilISO = until.toISO();
    panelState.aiDisabledChats.add(jid);

    // Log claro para verificar
    console.error(`[LLM-DOWN] 🔌 Desactivando IA en ${jid} por ${LLM_DOWN_MINUTES} min`
      + ` — motivo: ${isQuotaOrConnError(err) ? 'quota/conexión' : (err?.message || 'desconocido')}`);

    // Mensaje al paciente
    const reply = LLM_DOWN_MESSAGE;

    // (Opcional) notifica al staff por WhatsApp para intervención
    try{
      if (typeof sendWhatsAppText === 'function' && typeof STAFF_ISA_PHONE !== 'undefined'){
        await sendWhatsAppText(formatJidFromPhone(STAFF_ISA_PHONE),
          `⚠️ LLM caído en chat ${jid}. IA apagada ${LLM_DOWN_MINUTES} min. Motivo: ${err?.message || 'N/A'}`);
      }
    }catch(notifyErr){
      console.warn('[LLM-DOWN] No se pudo notificar al staff:', notifyErr?.message);
    }

    return { reply };
  }catch(inner){
    console.error('[LLM-DOWN] Error en handleLLMFailureAndDisableChat:', inner);
    // fallback duro
    return { reply: LLM_DOWN_MESSAGE };
  }
}



// ============== /chat (lógica IA por sesión) ==============
app.post('/chat', async (req, res) => {
  const from    = normJid(String(req.body.from || 'anon'));
  const userMsg = String(req.body.message || '').trim();

  // 1) OBTÉN SESIÓN Y NOW ANTES DE USARLA EN CUALQUIER BLOQUE
  const session = getSession(from);
  const now     = DateTime.now().setZone(ZONE);

  // Aseguramos que exista el objeto patient una sola vez
  ensurePatient(session); // <- importante para no estar inventándolo en cada lado

  
    // ⚠️ RECHAZO DE LA HORA OFRECIDA (cuando ya mostramos 1 día/1 hora)
  if (session.lastOffered && session.lastOffered.singleDay) {
    const txt = userMsg.toLowerCase();
    const rechazo = /\b(no quiero\b|no me sirve|no puedo|no deseo|no gracias|no la quiero|no lo quiero|no esa\b|esa no\b|otra hora|otro horario|muy tarde|muy temprano|no me queda bien)\b/i;
 // i = case-insensitive, x = permite espacios en el regex

    if (rechazo.test(txt)) {
      // 🔴 Limpiamos la oferta para que no vuelva a insistir
      session.lastOffered = null;

      const reply =
        'Entiendo perfectamente.\n\n' +
        'Por ahora no tengo más horarios disponibles aparte de la hora que te ofrecí. ' +
        'Si en otro momento deseas buscar un nuevo cupo, puedes escribirme de nuevo.';

      session.history.push({ role: 'assistant', content: reply });
      capHistory(session);
      touchSession(session);
      return res.json({ reply, makeResponse: null });
    }
  }



  // 2) DESBLOQUEO DE PRIORIDAD VENCIDA (usa session ya definida)
  if (session.priority?.active && now >= DateTime.fromISO(session.priority.lockUntilISO)) {
    console.log(`[PRIORITY] Expiró lock en ${from}, desbloqueando`);
    session.priority = null;
    panelState.aiDisabledChats.delete(from);
  }
  if (session.priority?.active) {
    console.log(`[PRIORITY] Chat bloqueado ${from} — se devuelve mensaje fijo`);
    return res.json({ reply: 'Atención prioritaria. Un asesor te contactará en breve.' });
  }

  // 3) DESBLOQUEO DE “IA APAGADA POR LLM” (antes de chequear IA OFF para poder reactivar)
  if (session.llmDownUntilISO) {
    const offUntil = DateTime.fromISO(session.llmDownUntilISO, { zone: ZONE });
    if (offUntil.isValid && now >= offUntil) {
      session.llmDownUntilISO = null;
      panelState.aiDisabledChats.delete(from);
      console.log(`🤖 IA reactivada por tiempo cumplido → ${from}`);
    }
  }

  // 4) IA OFF → ahora sí podemos salir si sigue apagada
  if (!panelState.aiGlobalEnabled || panelState.aiDisabledChats.has(from)) {
    return res.json({ reply: '' });
  }

  // 5) RESET DURO (lo dejamos una sola vez, no duplicado)
  if (userMsg === '__RESET__') {
    sessions.delete(from);
    return res.json({ ok: true, reset: true });
  }

  // ─────────────────────────────────────────────────────────
  // Helpers locales por si NO pegaste los helpers globales:
  // firstAllowedStart / monthPolicyFrom y constante MONTH_CUTOFF_DAY
  const cutoffDay = (typeof MONTH_CUTOFF_DAY === 'number' ? MONTH_CUTOFF_DAY : 24);

  const _firstAllowedStart = (typeof firstAllowedStart === 'function')
    ? firstAllowedStart
    : function(nowLocal = DateTime.now().setZone(ZONE)) {
        const minDay = DateTime.fromISO(MIN_BOOKING_DATE_ISO || '', { zone: ZONE }).startOf('day');
        let start = nowLocal.startOf('day');
        if (minDay.isValid && start < minDay) start = minDay;
        return start;
      };

  const _monthPolicyFrom = (typeof monthPolicyFrom === 'function')
    ? monthPolicyFrom
    : function(desdeISO) {
        let start = DateTime.fromISO(desdeISO || '', { zone: ZONE });
        if (!start.isValid) start = _firstAllowedStart(now);
        const minStart = _firstAllowedStart(now);
        if (start < minStart) start = minStart;

        const endOfMonth     = start.endOf('month').startOf('day');
        const blocked        = start.day >= cutoffDay; // usamos cutoffDay seguro
        const nextMonthStart = start.plus({ months: 1 }).startOf('month');
        const diasMax        = Math.max(0, Math.floor(endOfMonth.diff(start, 'days').days) + 1);

        return { start, endOfMonth, blocked, nextMonthStart, diasMax };
      };
  // ─────────────────────────────────────────────────────────

  // -------- Helpers locales --------
  const stripActionBlocks = (s) =>
    (s || '')
      .replace(/```action[\s\S]*?```/gi, '')
      .replace(/```[\s\S]*?```/g, '')
      .trim();

  const looksLikeFakeConfirmation = (s) =>
    /\b(cita|turno)\b[\s\S]{0,50}\b(agendada|confirmada|reservada)/i.test(s || '');

  // Detecta tipo explícito por texto del usuario (dentro de /chat para evitar “no definido”)
function guessTipo(text = '') {
  const s = norm(text);
  if (!s) return null;

  // Biopsia
  if (/(biops)/.test(s)) {
    return 'Biopsia guiada por ecografía';
  }

  // Control de resultados / virtual
  if (/control\s+de\s+resultados?/.test(s)) {
    return 'Control virtual';
  }
  if (/(virtual|en\s*linea|en\s*l[ií]nea|online)/.test(s)) {
    return 'Control virtual';
  }

  // Primera vez
  if (/(primera\s*vez|primer[ao]\s*consulta|nueva\s*(cita|consulta))/i.test(s)) {
    return 'Primera vez';
  }

  // Control presencial
  if (/\bcontrol\b/.test(s) && !/virtual/.test(s) && !/resultado/.test(s)) {
    return 'Control presencial';
  }

  return null;
}



  // ===== Instrucciones de sistema =====
  const todayNote =
    `Hoy es ${DateTime.now().setZone(ZONE).toISODate()} (${ZONE}). ` +
    `Reglas: Martes sin consulta; virtual solo viernes tarde; no agendar fechas pasadas.`;

  const policyNote =
  'Usa “**Disponibilidad de citas**” (no “Horarios disponibles”). ' +
  'Preguntar por estudios recientes está bien, pero evita bucles. ' +
  '⚠️ **No guardes pacientes** por ahora: NO digas “voy a guardar/registrar tus datos” y NO ejecutes acciones de guardado. ' +
  'No muestres JSON ni bloques de código al paciente. ' +
  'NO ofrezcas al paciente elegir rangos de fechas ni preguntes "¿qué día prefieres o consulto un rango de fechas?". ' +
  'Cuando hables de disponibilidad, di que vas a revisar y el sistema te devolverá el *primer cupo disponible más cercano* (un solo día y una sola hora). ' +
  'No inventes reglas de agenda fuera de las instrucciones del sistema. ';

const epsNote =
  'Si la entidad es **Coomeva** y el plan es **Preferente** (incluye nombres como "oro plus", "gold", "VIP"), ' +
  'el sistema NO debe agendar ni ofrecer cita. ' +
  'No prometas atención futura con ese plan. ' +
  'El backend enviará un mensaje fijo explicando que NO se atiende Coomeva Preferente y dará el número de contacto para más información. ' +
  'Tú no agregues textos contradictorios ni sugieras que sí se puede agendar con ese plan.';



  const actionNote =
    'Para ejecutar acciones usa SIEMPRE un bloque: ' +
    '```action\\n{"action":"...","data":{...}}\\n``` ' +
    'y además responde con texto natural para el paciente. Yo oculto el bloque. ' +
    'No confirmes citas en el texto visible hasta que el sistema te devuelva confirmación.';

  // Reglas de datos para "Primera vez" (permisivas)
 const firstTimeNote =
  'Si el motivo es "Primera vez": pide TODOS los datos en UN SOLO mensaje (usa la plantilla) ' +
  '(nombre completo, cédula, entidad_salud, correo, celular, dirección, ciudad, fecha de nacimiento, tipo de sangre, estado civil, antecedentes de estudios). ' +
  'En tus mensajes al paciente NO digas que algún dato es opcional ni uses frases como "si deseas", "si quieres puedes incluir", "si es posible". ' +
  'Puedes consultar disponibilidad aunque falte alguno de esos campos, pero SOLO bloquea al **crear_cita** si falta un campo del núcleo: ' +
  'nombre completo, cédula, entidad_salud, correo, celular, dirección y ciudad. ' +
  'Los demás campos sirven para la historia clínica, pero no deben impedir agendar cuando el núcleo ya está completo.';

const entityHardRuleNote =
  'Después de conocer el MOTIVO de la consulta, SIEMPRE debes pedir la entidad de salud o si es particular ' +
  'ANTES de hablar de estudios, BI-RADS o disponibilidad de citas. ' +
  'No avances al siguiente paso si aún no sabes la entidad. ' +
  'Ejemplo: "¿Con qué seguro o entidad de salud cuentas, o prefieres atenderte como particular?".';



  session.history.push({ role: 'system', content: todayNote });
  session.history.push({ role: 'system', content: policyNote });
  session.history.push({ role: 'system', content: epsNote });
  session.history.push({ role: 'system', content: actionNote });
  session.history.push({ role: 'system', content: firstTimeNote });
  session.history.push({ role: 'system', content: entityHardRuleNote }); // ⬅️ NUEVA

// Fijar tipo por mensaje explícito y guardar último texto
const explicitTipo = guessTipo(userMsg);
if (explicitTipo) {
  session.tipoActual = normalizeTipo(explicitTipo);
}
session.lastUserText = userMsg;

  // Tomar datos del mensaje actual para ir llenando session.patient
  collectPatientFields(session, userMsg);
  const paciente = ensurePatient(session);

  // Tipo efectivo (raw) y normalizado
  const tipoEfectivoRaw = session.tipoActual || guessTipo(userMsg) || '';
  const tipoNorm = tipoEfectivoRaw ? normalizeTipo(tipoEfectivoRaw) : '';

  // si no había tipo en sesión y lo inferimos, persístelo normalizado
  if (tipoNorm) {
    session.tipoActual = tipoNorm;
  }

  // 🔒 Inyectar nota de “ya tengo estos datos, no los pidas otra vez”
  pushKnownPatientNote(session);

  // 🚫 REGLA DURA: Coomeva Preferente no se atiende ni se agenda
  session.flags = session.flags || {};

  const textoEntidad = [
    paciente.entidad_salud || '',
    userMsg || ''
  ].join(' ');

  if (!session.flags.coomevaPreferenteNotified && isCoomevaPreferente(textoEntidad)) {
    session.flags.coomevaPreferenteNotified = true;

    const reply =
      'En este momento *NO podemos atender ni agendar citas* para pacientes con el plan **Coomeva Preferente**. ' +
      'Te pedimos disculpas por las molestias.\n\n' +
      'Para recibir más información sobre tus opciones de atención, por favor comunícate directamente con nuestro asesor *Deivis* al +57 3108611759.';
      

    session.history.push({ role: 'assistant', content: reply });
    capHistory(session);
    touchSession(session);
    return res.json({ reply, makeResponse: null });
  }

  // ✅ NOTA POSITIVA: Coomeva NO-PREFERENTE (oro, oro plus, etc.) SÍ se atiende
  const entidadCanon = normalizeEntidadSalud(paciente.entidad_salud || userMsg);
  const textoPlan = [
    paciente.plan || '',
    userMsg || ''
  ].join(' ').toLowerCase();

  const tienePalabraPreferente = /\bpreferent(e|es)?\b/.test(textoPlan);

  if (entidadCanon === 'Coomeva' && !tienePalabraPreferente) {
    session.history.push({
      role: 'system',
      content:
        'El paciente tiene Coomeva *NO-PREFERENTE* (por ejemplo "oro", "oro plus", "medicina prepagada", "tradicional"). ' +
        'NO digas que no se puede atender su plan, ni lo mezcles con Coomeva Preferente. ' +
        'Trátalo como Coomeva válido y sigue el flujo normal de agendamiento.'
    });
  }

  // ✅ Si ya está completo el núcleo de "Primera vez", NO volver a pedirlo
  if (/primera\s*vez/i.test(tipoNorm) && missingForTipo(session, 'Primera vez').length === 0) {
    console.log('[PV] Núcleo COMPLETO para "Primera vez". No volver a pedir datos.');
    session.history.push({
      role: 'system',
      content: 'Ya tengo TODOS los datos obligatorios del paciente para "Primera vez". NO los pidas de nuevo.'
    });
    // Flag para un auto-siguiente paso (mostrar disponibilidad)
    session.flags = session.flags || {};
    session.flags.firstTimeCoreReady = true;
  }


  // ✅ Cancelación por chat HABILITADA: guía al LLM, pero NO respondas aquí
  const cancelIntent = /\b(cancelar|anular|reprogramar|cambiar|modificar|mover)\b[\s\S]{0,60}\b(cita|turno|reserva)\b/i.test(userMsg);
  if (cancelIntent) {
    session.cancelling = true;  // ⬅️ IMPORTANTE
    session.history.push({
      role: 'system',
      content: [
        'CANCELACIÓN HABILITADA POR CHAT.',
        'Flujo: 1) pide CÉDULA (señuelo, no validar),',
        '2) pide FECHA (AAAA-MM-DD) y HORA exacta (HH:mm, 24h),',
        '3) emite SOLO un JSON: {"action":"cancelar_cita","data":{"cedula":"...","fecha":"AAAA-MM-DD","hora":"HH:mm"}}',
        'No mezcles texto y JSON en el mismo mensaje y no confirmes hasta respuesta del sistema.',
        'Si el sistema dice que NO se encontró o falta hora exacta → ahí sí responde con el número de Deivis.'
      ].join(' ')
    });
    // OJO: no hacemos return aquí
  }

  if (session.birads) {
    session.history.push({
      role: 'system',
      content: `BIRADS ${session.birads} detectado previamente. No pidas de nuevo la categoría; procede según reglas.`
    });
  }
  if (session.lastSystemNote) {
    session.history.push({ role: 'system', content: session.lastSystemNote });
    session.lastSystemNote = null;
  }

  // Mensaje del usuario
  session.history.push({ role: 'user', content: userMsg });
  capHistory(session);
  touchSession(session);  // aquí actualizas el TTL de la sesión

  try {
    // ===== LLM con guard =====
    const completion = await callLLMWithGuard(session.history, {
      model: 'gpt-4o',
      temperature: 0.4,
      // max_tokens: 600,
      retries: 3,
    });

    const replyRaw = completion.choices?.[0]?.message?.content || '';
    const actionResult = await maybeHandleAssistantAction(replyRaw, session);

    // Texto visible (sin JSON ni bloques)
    let reply = stripActionBlocks(replyRaw);

    // ========= Si hubo acciones, ARMAR RESPUESTA SÓLO CON RESULTADOS =========
    if (actionResult?.handled && actionResult.makeResponse) {
      const mr = Array.isArray(actionResult.makeResponse)
        ? actionResult.makeResponse
        : [actionResult.makeResponse];

      const errors    = mr.filter(x => x && x.ok === false);
      const cancelled = mr.find(x => x && x.cancelled === true);
      const daysResp  = mr.find(x => Array.isArray(x?.dias_disponibles));
      const daySlots  = mr.find(x => Array.isArray(x?.slots));
      const created   = mr.find(x => x && x.ok === true && (x.eventId || x.confirmText));
      const saved     = mr.find(x => x && x.saved === true);

      reply = ''; // <- IMPORTANTE: partimos en blanco, NO usamos texto del modelo

      if (cancelled) {
        session.cancelling = false; // ⬅️ ya se canceló, salimos de modo cancelar
        console.log('[CANCEL][OK] Enviando confirmación de cancelación al paciente.');
        reply = '✅ Tu cita fue cancelada correctamente. ¿Deseas **reprogramarla**? Puedo mostrarte la disponibilidad actual.';
      } else if (errors.length) {
        console.log('[CANCEL][ERR]', errors);
        const noEncontrada = errors.find(e => e?.error === 'no_encontrada' || /no_encontrad/i.test(e?.message || ''));
        const faltaHora    = errors.find(e => e?.error === 'falta_fecha_hora');
        if (noEncontrada || faltaHora) {
          reply = `No pude ubicar la cita con la información dada. Para cancelar o reprogramar, por favor comunícate con nuestro asesor *Deivis* al +57 3108611759`;
        } else {
          reply = errors.map(e => `⚠️ ${e.message || 'Operación no completada.'}`).join('\n\n');
        }
      } else if (created) {
        if (created.confirmText) {
          reply = created.confirmText;
        } else {
          const df = DateTime.fromISO(created.inicio || '', { zone: ZONE }).setLocale('es');
          const fechaTxt = df.isValid ? df.toFormat("d 'de' LLLL") : 'la fecha indicada';
          const horaTxt  = df.isValid ? df.toFormat('HH:mm') : 'la hora indicada';
          reply =
            `Tu cita ha sido agendada exitosamente para el ${fechaTxt} a las ${horaTxt} en la Clínica Portoazul, piso 7, consultorio 707, en Barranquilla.
     Por favor, llega con 15 minutos de anticipación y lleva todos los reportes previos impresos.
     Recuerda que está prohibido grabar audio o video durante la consulta sin autorización. Cualquier inquietud adicional, no dudes en contactarnos.` +
            (created.htmlLink ? `\n\nAbrir en Google Calendar: ${created.htmlLink}` : '');
        }
      } else if (saved) {
        const auto = await showAvailabilityNow(session, now, _firstAllowedStart, _monthPolicyFrom);
        reply = `He tomado tus datos. Pasemos a revisar la disponibilidad…\n\n${auto}`;
      } else if (daySlots || daysResp) {
        if (needEntidadBeforeDispon(session)) {
        if (replyAskEntidad(res, session)) return; // ya respondimos y salimos
        }
        // Ignoramos la lista cruda que venga del modelo (slots o dias_disponibles)
        const auto = await showAvailabilityNow(session, now, _firstAllowedStart, _monthPolicyFrom);
        reply = auto;
      }

      reply = (reply || '').trim();
      if (!reply) reply = 'Listo ✅';

      console.log('[CHAT][FINAL-REPLY]', reply);

      session.history.push({ role: 'assistant', content: reply });
      capHistory(session);
      touchSession(session);
      return res.json({ reply, makeResponse: actionResult.makeResponse });
    }

    // Si el modelo "prometió" consultar pero NO mandó acción JSON → mostrar disponibilidad
    const promisedToCheck = /(consultar[ée]?\s+la\s+disponibilidad|voy\s+a\s+consultar\s+la\s+disponibilidad|proceder[eé]?\s+a\s+(verificar|revisar|buscar)\s+disponibilidad|voy\s+a\s+revisar\s+la\s+agenda|voy\s+a\s+revisar\s+el\s+pr[oó]ximo\s+cupo\s+disponible|voy\s+a\s+buscar\s+el\s+pr[oó]ximo\s+cupo\s+disponible|un\s+momento\s+mientras\s+reviso\s+el\s+pr[oó]ximo\s+cupo)/i.test(replyRaw);

    if (!actionResult?.handled && promisedToCheck) {
         // ⛔ Si no hay EPS, no revises disponibilidad todavía
       if (needEntidadBeforeDispon(session)) {
       if (replyAskEntidad(res, session)) return; // ya respondimos y salimos
       }
      try {
        const auto = await showAvailabilityNow(session, now, _firstAllowedStart, _monthPolicyFrom);
        reply = auto;
        console.log('[AUTO-DISPONIBILIDAD] sin acción JSON → enviada');
      } catch (e) {
        console.error('❌ Auto-disponibilidad error:', e);
      }
    }

    // Si el modelo “dice” que ya agendó pero no hubo acción real → frenar
    if (looksLikeFakeConfirmation(reply)) {
      reply = 'Aún no he registrado la cita. Indícame la **fecha** y la **hora exacta** (por ejemplo, "2025-11-19 15:15") o elige una opción de la disponibilidad.';
    }

    // Si el usuario envió una fecha explícita (YYYY-MM-DD o dd/mm/yyyy)
   const dateWanted = parseUserDate(userMsg);

// ⛔ NO disparar auto-disponibilidad por fecha mientras estamos cancelando
if (!actionResult?.handled && dateWanted && !session.cancelling) {
  
    if (needEntidadBeforeDispon(session)) {
    if (replyAskEntidad(res, session)) return;
    }
  try {
    const tipo = session.tipoActual || 'Control presencial';
    const dias = await disponibilidadPorDias({
      tipo,
      desdeISO: dateWanted,
      dias: 1 // 🔒 solo ese día
    });

    if (!dias.length || !(dias[0].slots || []).length) {
      reply = `Para ${fmtFechaHumana(dateWanted)} no hay cupos válidos. ¿Quieres otra fecha?`;
    } else {
      const day   = dias[0];
      const slot  = day.slots[0]; // ⬅️ SOLO el primer cupo del día
      const df    = DateTime.fromISO(slot.inicio, { zone: ZONE }).setLocale('es');
      const fechaTxt = fmtFechaHumana(day.fecha);
      const horaTxt  = df.toFormat('HH:mm');

      reply =
        `Tengo un cupo disponible ese día:\n` +
        `📅 *${fechaTxt}* a las *${horaTxt}*.\n\n` +
        `¿Deseas tomar esa hora?  ` +
        `Si no te sirve, por ahora es la única disponible para ese día.`;

      // Guardamos la oferta para que el auto-create pueda usarla
      session.lastOffered = {
        tipo: session.tipoActual || tipo,
        singleDay: true,
        days: [{
          fechaISO: day.fecha,
          slots: [{ inicio: slot.inicio, fin: slot.fin }]
        }]
      };
    }

    console.log('[AUTO-DISPONIBILIDAD-DÍA] fecha del usuario → enviada');
  } catch (e) {
    console.error('❌ Auto-disponibilidad por día error:', e);
  }
}


    // === AUTO-CREAR SI EL USUARIO ELIGE UN HORARIO DE LOS ÚLTIMOS OFRECIDOS ===
    if (!actionResult?.handled && session.lastOffered && session.lastOffered.days?.length) {
      const hhmm        = extractHour(userMsg);
      const dateFromMsg = parseUserDate(userMsg);

      let chosenDay = null;
      if (dateFromMsg) {
        chosenDay = session.lastOffered.days.find(d => d.fechaISO === dateFromMsg);
      } else if (session.lastOffered.singleDay) {
        chosenDay = session.lastOffered.days[0];
      }

      if (chosenDay && hhmm) {
        const slot = (chosenDay.slots || []).find(s => {
          const h = DateTime.fromISO(s.inicio, { zone: ZONE }).toFormat('HH:mm');
          return h === hhmm;
        });

        if (slot) {
          const P = session.patient || {};
          const core = ['nombre','cedula','entidad_salud','correo','celular','direccion','ciudad'];
          const missingCore = core.filter(k => !String(P[k] || '').trim());
          if (missingCore.length) {
            reply = `Antes de agendar necesito: ${missingCore.join(', ')}. Por favor envíalos en un solo mensaje.`;
          } else {
                      // ❗ Validar Coomeva Preferente SOLO AQUÍ
          if (isCoomevaPreferente(P.entidad_salud || '')) {
            reply = 'En este momento no puedo agendar citas para pacientes con el plan Coomeva Preferente. ' +
                    'Por favor, comunícate con nuestra oficina para revisar otras opciones.';
            session.history.push({ role: 'assistant', content: reply });
            capHistory(session);
            touchSession(session);
            return res.json({ reply, makeResponse: null });
          }

            const payload = {
              action: 'crear_cita',
              data: {
                nombre:   P.nombre,
                cedula:   P.cedula,
                entidad_salud: P.entidad_salud,
                correo:   P.correo,
                celular:  P.celular,
                direccion:P.direccion,
                ciudad:   P.ciudad,
                tipo:     session.tipoActual || 'Control presencial',
                inicio:   slot.inicio,
                fin:      slot.fin
              }
            };
            const block   = '```action\n' + JSON.stringify(payload, null, 2) + '\n```';
            const autoRes = await maybeHandleAssistantAction(block, session);

            if (autoRes?.handled && autoRes.makeResponse) {
              const mr = Array.isArray(autoRes.makeResponse) ? autoRes.makeResponse : [autoRes.makeResponse];
              const created = mr.find(x => x && x.ok === true && (x.eventId || x.confirmText));

              if (created) {
                if (created.confirmText) {
                  reply = created.confirmText;
                } else {
                  const df = DateTime.fromISO(created.inicio || slot.inicio, { zone: ZONE }).setLocale('es');
                  const fechaTxt = df.isValid ? df.toFormat("d 'de' LLLL") : 'la fecha indicada';
                  const horaTxt  = df.isValid ? df.toFormat('HH:mm') : 'la hora indicada';
                  reply = `Tu cita ha sido agendada exitosamente para el ${fechaTxt} a las ${horaTxt} ` +
                          `en la Clínica Portoazul, piso 7, consultorio 707, en Barranquilla. ` +
                          `Por favor, llega con 15 minutos de anticipación y lleva todos los reportes previos impresos.\n\n` +
                          `Recuerda que está prohibido grabar audio o video durante la consulta sin autorización. ` +
                          `Cualquier inquietud adicional, no dudes en contactarnos.`;
                }
                console.log('[AUTO-CREATE] Cita creada desde selección de usuario.');
                session.history.push({ role: 'assistant', content: reply });
                capHistory(session);
                touchSession(session);
                return res.json({ reply, makeResponse: autoRes.makeResponse });
              }
            }
          }
        }
      }
    }

    // 🔁 AUTO-DISPONIBILIDAD cuando es "Primera vez" y ya tengo núcleo
    if (
      !actionResult?.handled &&
      /primera\s*vez/i.test(session.tipoActual || '') &&
      missingForTipo(session, 'Primera vez').length === 0 &&
      !session.lastOffered
    ) {
      try {
        const replyAuto = await showAvailabilityNow(session, now, _firstAllowedStart, _monthPolicyFrom);
        console.log('[AUTO-DISPONIBILIDAD] Primera vez con núcleo completo → mostrando cupos');
        session.history.push({ role: 'assistant', content: replyAuto });
        capHistory(session); touchSession(session);
        session.flags.firstTimeCoreReady = false;
        return res.json({ reply: replyAuto, makeResponse: null });
      } catch (e) {
        console.error('❌ Auto-disponibilidad falló:', e);
      }
    }

    // Fallback: si pidió disponibilidad en texto libre
    const u = userMsg.toLowerCase();
    const pideDispon = /disponibilidad|horarios|agenda|qué días|que dias|que horarios|que horario/.test(u);
    if (pideDispon) {

          if (needEntidadBeforeDispon(session)) {
          if (replyAskEntidad(res, session)) return;
          }

      try {
        const replyAuto = await showAvailabilityNow(session, now, _firstAllowedStart, _monthPolicyFrom);
        console.log('[AUTO-DISPONIBILIDAD] Palabras clave de disponibilidad → usando showAvailabilityNow');
        reply = replyAuto;
      } catch (e) {
        console.error('❌ Auto-disponibilidad (keywords) falló:', e);
      }
    }

    reply = stripActionBlocks(reply);
    if (!reply) reply = 'Listo ✅';

    session.history.push({ role: 'assistant', content: reply });
    capHistory(session);
    touchSession(session);
    return res.json({ reply, makeResponse: null });

  } catch (e) {
    const { reply } = await handleLLMFailureAndDisableChat(from, e);
    return res.json({ reply });
  }
});

// ====== Endpoints directos para probar disponibilidad ======
app.post('/availability', async (req, res) => {
  try {
    const { tipo = 'Control presencial' } = req.body;
    let { fecha } = req.body;
    if (!fecha) return res.status(400).json({ ok: false, error: 'falta_fecha' });

    fecha = coerceFutureISODate(fecha);
    const { dur, ventanas, slots } = generarSlots(fecha, tipo, 100);
    if (!ventanas.length) return res.json({ ok: true, fecha, tipo, duracion_min: dur, slots: [] });

    const busy = await consultarBusy(ventanas);
    const libres = filtrarSlotsLibres(slots, busy);
    res.json({ ok: true, fecha, tipo, duracion_min: dur, slots: libres });
  } catch (e) { console.error(e); res.status(500).json({ ok: false, error: 'server_error' }); }
});

app.post('/availability-range', async (req, res) => {
  try {
    const { tipo = 'Control presencial' } = req.body;
    let { desde, dias = 30 } = req.body;
    if (!desde) return res.status(400).json({ ok: false, error: 'falta_desde' });

    const desdeFixed = coerceFutureISODateOrToday(desde);
    const pol = monthPolicyFrom(desdeFixed);
    if (pol.blocked) {
      return res.json({ ok: true, tipo, desde: pol.start.toISODate(), dias: 0, dias_disponibles: [], policy: 'agenda_bloqueada', nextMonthStart: pol.nextMonthStart.toISODate() });
    }

    dias = Math.max(1, Math.min(dias, pol.diasMax));
    const diasDisp = await disponibilidadPorDias({ tipo, desdeISO: pol.start.toISODate(), dias });
    res.json({ ok: true, tipo, desde: pol.start.toISODate(), dias, dias_disponibles: diasDisp });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});


// ====== ARRANQUE ======
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Panel en http://0.0.0.0:${PORT}/panel`);
});

connectWhatsApp().catch(err => { console.error('❌ Error conectando WhatsApp:', err); });

