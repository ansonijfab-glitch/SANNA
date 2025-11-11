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
import qrcode from 'qrcode-terminal';
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
// NUEVO — Política mensual de agenda
const MONTH_CUTOFF_DAY = 24; // desde este día se cierra la agenda del mes actual
const DEFAULT_RANGE_DAYS = 18;
const PRIORITY_SEND_TO_ALL_STAFF = true;   
// Permite buscar X días hacia adelante (cruza meses)
const LOOKAHEAD_DAYS = parseInt(process.env.LOOKAHEAD_DAYS || '60', 10);

const PRIORITY_LOCK_MINUTES = parseInt(process.env.PRIORITY_LOCK_MINUTES || '60', 10);

// ====== PRIORITY CONFIG (Isabel 3 : Deivis 1) ======
const STAFF_ISABEL_PHONE = process.env.STAFF_ISABEL_PHONE || '+57 3007666588'; // ← PÓN LA REAL
const STAFF_DEIVIS_PHONE = process.env.STAFF_DEIVIS_PHONE || '+57 3108611759'; // ya la tienes

function phoneToJid(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  // Para staff siempre usar "s.whatsapp.net"
  return digits ? `${digits}@s.whatsapp.net` : null;
}
const STAFF = {
  isabel: { name: 'Isabel', phone: STAFF_ISABEL_PHONE, jid: phoneToJid(STAFF_ISABEL_PHONE) },
  deivis: { name: 'Deivis', phone: STAFF_DEIVIS_PHONE, jid: phoneToJid(STAFF_DEIVIS_PHONE) },
};

// ====== Helpers de teléfono / sesión ======
function jidLocalDigits(jid = '') {
  const local = String(jid).split('@')[0] || '';
  return /^\d{8,15}$/.test(local) ? local : null; // solo si parece "teléfono"
}
function toE164(digits = '') {
  const d = String(digits).replace(/\D/g, '');
  if (!d) return null;
  if (d.startsWith('57') && d.length >= 10 && d.length <= 12) return `+${d}`;   // ya trae 57
  if (d.length === 10 && /^3/.test(d)) return `+57${d}`;                        // móviles COL
  if (d.startsWith('00')) return `+${d.slice(2)}`;                               // 00… → +
  return d.startsWith('+') ? d : `+${d}`;                                        // fallback
}
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
function pickStaffByWeight() {
  const seq = ['isabel', 'isabel', 'isabel', 'deivis'];
  const key = seq[priorityCounter % seq.length];
  priorityCounter++;
  return STAFF[key];
}

// === Teléfono (Colombia): extracción ESTRICTA ===
// Acepta: "+57 3XXXXXXXXX" o "3XXXXXXXXX" (10 dígitos iniciando en 3)
// Devuelve en E.164: "+573XXXXXXXXX"
function extractValidPhone(raw = '') {
  const s = String(raw || '').replace(/[\s\-().]/g, '');
  // Intenta con prefijo +57
  const withCC = s.match(/\+57(3\d{9})/);
  if (withCC) return '+57' + withCC[1];
  // Intenta sin prefijo (móvil CO)
  const local = s.match(/\b(3\d{9})\b/);
  if (local) return '+57' + local[1];
  return null; // Nada válido → no arriesgar
}



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
- Recibir pacientes, hacer un triage clínico básico y gestionar agenda.
- Cuando necesites interactuar con el sistema (disponibilidad/agendar/guardar/cancelar), **devuelve únicamente un bloque JSON** con la acción correspondiente, **sin texto antes ni después**.
- **Nunca** declares una cita “confirmada” en texto. Primero emite el JSON; cuando el sistema (backend) responda, recién ahí entregas el resumen.

ESTILO
- Saluda y pídele el **nombre completo** al inicio.
- Habla con claridad y brevedad, sin emojis ni adornos.
- Dirígete por el **nombre** del paciente.
- Mantente en el tema clínico; si se desvían, redirígelo.
- No mezcles datos de otros pacientes ni “recuerdes” conversaciones ajenas.

PROTOCOLO PRIORITARIO  — BI-RADS 4 o 5
- Si detectas (por texto del paciente o porque el sistema te lo indica tras leer un PDF) **BI-RADS 4 o 5**
  1) **No** consultes horarios ni intentes agendar.
  2) transferir a humano (Isa/Deivis)

FLUJO ESTRICTO (cuando NO hay prioridad activa)
1) Nombre completo.
2) **Motivo de consulta** (elige uno):
   - **Primera vez**
   - **Control presencial**
   - **Control de resultados virtual**
   - **Biopsia guiada por ecografía** (solo particular)
   - **Programación de cirugía** → transferir a humano (Isa/Deivis)
   - **Actualización de órdenes** → transferir a humano (Isa/Deivis)

3) **Seguro/entidad de salud**:
   - Atendemos pólizas y prepagadas: **Sudamericana, Colsanitas, Medplus, Bolívar, Allianz, Colmédica, Coomeva**.
   - También **particular**.
   - **No atendemos EPS** (indícalo con cortesía; puedes orientar a particular).

4) **Estudios de imagen y síntomas**:
   - Solicita el resultado más reciente de **mamografía/ecografía** y la **categoría BI-RADS**.
   - Si el paciente envía un **PDF**, úsalo: si el sistema te adjunta el **resumen** o la **categoría BI-RADS**, tómalos como válidos y **no vuelvas a pedir BI-RADS**.
   - Si **BI-RADS 4 o 5** → dar manera hamable y sin emojis el numero de deivis
   - Si **BI-RADS 3** → preferir cita en **≤ 7 días hábiles**.
   - Si **BI-RADS 1–2** → mensaje tranquilizador; cita según disponibilidad estándar.
   - Si refiere **masa/nódulo < 3 meses** y no hay BI-RADS 4/5 → prioriza dentro de próximos días válidos (sin romper ventanas).

5) **Datos obligatorios antes de agendar (para cualquier cita)**:
   - **Nombre y apellido**
   - **Cédula**
   - **Entidad de salud** (o “particular”) si es conmeva y es preferente no se atiende(obligatorio)
   - **Correo electrónico**
   - **Celular**
   - **Dirección** y **Ciudad** (si falta ciudad, pídela con cortesía)
   Si falta algo, **pídelo**. **No** generes JSON de crear_cita hasta tenerlos.

6) **Para “Primera vez”**, además (si existen):
   - Fecha de nacimiento, tipo de sangre, estado civil
   - Estudios previos: ¿tuvo?, ¿cuándo?, ¿dónde?

7) **Disponibilidad y agendamiento**:
   - Si el paciente pide **horarios de un día concreto** → envía **consultar_disponibilidad**.
   - Si pide “qué días tienes libres” o no da fecha → envía **consultar_disponibilidad_rango** desde **hoy** por **60 días**.
   - Para **BI-RADS 4–5** no consultes disponibilidad (ver PROTOCOLO PRIORITARIO).
   - Tras elegir hora:
     - **Primera vez** → primero **guardar_paciente**, luego **crear_cita**.
     - **Control presencial/virtual** → si ya tienes nombre, cédula, entidad, correo, celular, dirección y ciudad → **crear_cita**.

8) **Confirmación**:
   - No confirmes en texto por tu cuenta.
   - Cuando el sistema responda “OK/creada”, entrega **resumen**: fecha, hora y lugar + recordatorios/legales.

CANCELACIÓN / REPROGRAMACIÓN
- Sí se puede gestionar por chat.
- Flujo estricto:
  1) Pide **cédula** (señuelo).
  2) Pide **fecha (AAAA-MM-DD)** y **hora exacta (HH:mm, 24h)** de la cita.
  3) Emite JSON:
     {
       "action": "cancelar_cita",
       "data": { "cedula": "123...", "fecha": "2025-11-19", "hora": "15:15" }
     }
- Si el sistema responde “no_encontrada”, vuelve a pedir la hora exacta. Si persiste, responde:
  “No pude cancelar por chat. Por favor comunícate con nuestro asesor Deivis al ${STAFF_DEIVIS_PHONE}.”
- No confirmes cancelación en texto hasta que el sistema lo indique.
- Nunca mezcles texto y JSON en el mismo mensaje.



AGENDA (VENTANAS Y LÍMITES)
- **Lugar**: Clínica Portoazul, piso 7, consultorio 707, Barranquilla.
- **Duraciones**:
  - Primera vez: **20 min**
  - Control presencial: **15 min**
  - Control virtual (resultados): **10 min**
  - Biopsia: **30 min**
- **Ventanas por día/tipo** (**no romper**):
  - **Martes:** sin consulta (rechaza u ofrece otro día).
  - **Lunes (presencial):** 08:00–11:30 y 14:00–17:30.(mostrar los espacios disponibles de esas horas todos)
  - **Miércoles/Jueves (presencial):** 14:00–16:30.(mostrar los espacios disponibles de esas horas todos)
  - **Viernes presencial:** 08:00–11:30 (**no** presencial viernes tarde).(mostrar los espacios disponibles de esas horas todos)
  - **Viernes virtual:** 14:00–16:30 (**solo** controles virtuales).(mostrar los espacios disponibles de esas horas todos)
- **Límites**:
  - No fechas **pasadas**.
  - No **martes**.


COSTOS (si preguntan)
- Consulta de mastología: **350.000 COP**.
- Biopsia guiada por ecografía (solo particular): **800.000 COP** (incluye patología; **no** incluye consulta de lectura de patología).
- Medios de pago: **efectivo, transferencia**.

LEGALES Y RECORDATORIOS (al confirmar)
- Llegar **15 minutos** antes.
- Traer **impresos** todos los reportes previos: mamografías, ecografías, resonancias, informes de biopsia, resultados de cirugía/patología.
- **Grabaciones no autorizadas**: prohibido grabar audio/video durante la consulta sin autorización (Art. 15 Constitución Política de Colombia y Ley 1581 de 2012).

HANDOFF HUMANO
-enviar el aviso a deivis o a isabel y apagarte por una hora

REGLAS DURAS (NO ROMPER)
- Cuando muestres disponibilidad: formato **“9 de septiembre: 14:30, 14:15, …”** (no ISO) y **sin duración**.
- Si ya leíste resultados de PDF o sabes la categoría **BI-RADS**, primero da un **resumen muy breve** y **no vuelvas a pedir la categoría**; sigue el curso.
- No martes, no fuera de ventana, no pasado.
- No confirmar sin respuesta del sistema.
- **No mezclar texto y JSON** en el mismo mensaje.
- **No inventes horarios**: primero consulta disponibilidad y ofrece solo lo devuelto por el sistema.
- Si el sistema indica “ocupado” o “fuera de horario”, **no contradigas**: vuelve a pedir disponibilidad u ofrece alternativas válidas.

ACCIONES (JSON ONLY) — **formatos exactos**
1) Guardar paciente
{
  "action": "guardar_paciente",
  "data": {
    "nombre": "Ana López",
    "cedula": "12345678",
    "fecha_nacimiento": "1985-06-20",
    "tipo_sangre": "O+",
    "estado_civil": "Casada",
    "ciudad": "Barranquilla",
    "direccion": "Cra 45 #23-10",
    "correo": "ana@mail.com",
    "celular": "3101234567",
    "entidad_salud": "Colsanitas",
    "estudios_previos": "Sí",
    "fecha_estudio": "2024-02-10",
    "lugar_estudio": "Clínica Portoazul"
  }
}

2) Consultar disponibilidad (un día)
{
  "action": "consultar_disponibilidad",
  "data": { "tipo": "Control presencial", "fecha": "2025-10-06" }
}

3) Consultar días con cupo (rango)
{
  "action": "consultar_disponibilidad_rango",
  "data": { "tipo": "Control presencial", "desde": "2025-10-01", "dias": 60 }
}

4) Crear cita 
{
  "action": "crear_cita",
  "data": {
    "nombre": "Ana López",
    "cedula": "12345678",
    "entidad_salud": "Colsanitas",
    "tipo": "Control presencial",
    "inicio": "2025-10-06T08:00:00-05:00",
    "fin": "2025-10-06T08:15:00-05:00"
  }
}


`;

// ============== SESIONES POR USUARIO ==============
// Map<fromJid, {history, lastSystemNote, updatedAtISO, priority, cancelGuard, birads}>
const sessions = new Map();
const SESSION_TTL_MIN = 60;
const PRIORITY_LOCK_MIN = 60;


const CANCEL_ATTEMPT_WINDOW_MIN = 60;
const CANCEL_ATTEMPT_MAX = 3;

function getSession(userId) {
  const now = DateTime.now().setZone(ZONE);
  let s = sessions.get(userId);
  const expired =
    s && now.diff(DateTime.fromISO(s.updatedAtISO || now.toISO())).as('minutes') > SESSION_TTL_MIN;

  if (!s || expired) {
    // REEMPLAZA dentro de getSession (objeto s = { ... })
s = {
  history: [{ role: 'system', content: systemPrompt }],
  lastSystemNote: null,
  updatedAtISO: now.toISO(),
  priority: null,
  cancelGuard: { windowStartISO: now.toISO(), attempts: 0 },
  birads: null,
  tipoActual: null, // NUEVO — persistir tipo (Primera vez / Control / Virtual / Biopsia)
};

    sessions.set(userId, s);
  }
  return s;
}
function touchSession(s) { s.updatedAtISO = DateTime.now().setZone(ZONE).toISO(); }
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
function incCancelAttempt(session) { resetCancelGuardIfWindowExpired(session); session.cancelGuard.attempts = (session.cancelGuard.attempts || 0) + 1; }
function tooManyCancelAttempts(session) { resetCancelGuardIfWindowExpired(session); return (session.cancelGuard.attempts || 0) >= CANCEL_ATTEMPT_MAX; }

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

// Enviar alerta a Isabel y Deivis, marcando un primario 3:1
async function notifyPriorityStaffAll(remoteJid, birads, fuente = 'PDF') {
  const now = DateTime.now().setZone(ZONE);
  const paciente = contactNames.get(remoteJid) || remoteJid.split('@')[0];
  const primary = choosePrimaryContact();

  const targets = [
    { name: 'Isabel', phone: ISABEL_PHONE },
    { name: 'Deivis', phone: DEIVIS_PHONE },
  ].filter(t => (t.phone || '').trim());

  for (const t of targets) {
    const base = renderPriorityAlert(pickRandom(PRIORITY_ALERT_TEMPLATES), {
      birads: String(birads || '?'),
      paciente,
      jid: remoteJid.split('@')[0],
      fechaHora: now.setLocale('es').toFormat("d 'de' LLLL yyyy 'a las' HH:mm"),
      fuente
    });
    // Si este destino es el primario, añade marca
    const extra = (t.phone === primary.phone) ? `\n\n👤 Responsable primario: ${t.name}` : '';
    const msg = base + extra;
    try {
      await sendWhatsAppText(toJid(t.phone), msg);
      console.log(`📣 Prioridad enviada a ${t.name} (${t.phone})`);
    } catch (e) {
      console.error(`❌ Error enviando prioridad a ${t.name}:`, e);
    }
  }
}

// Pide número al paciente y marca el chat como "waiting_phone"
// NO apaga la IA aquí: necesitamos leer el siguiente mensaje con el número.
async function startPriorityPhoneCapture(jid, { source, birads }) {
  const s = getSession(jid);
  s.priority = {
    active: true,
    status: 'waiting_phone',
    source: source || 'texto',
    birads: String(birads || ''),
    lockUntilISO: null
  };
  console.log(`[PRIORITY] ⏳ Esperando teléfono del paciente — BI-RADS ${birads} en ${jid}`);
  await sendWhatsAppText(
    jid,
    `🔴 *Atención prioritaria (BI-RADS ${birads})*\n` +
    `Para que nuestra asesora te contacte de inmediato, envíame tu **número celular con indicativo**, por ejemplo: +57 3001234567.`
  );
}


// Bloquear chat, avisar paciente y notificar al staff
// Escalamiento de prioridad BI-RADS 4/5: notifica staff y apaga IA 60 min
// Escala caso BI-RADS 4/5 a staff (Isabel/Deivis) con distribución 3:1,
// envía acuse al paciente y apaga la IA por 60 minutos.
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

function getContactLabel(jid) {
  return contactNames.get(jid) || jid.replace('@s.whatsapp.net','');
}

function scheduleUnmuteChat(jid, minutes = PRIORITY_LOCK_MINUTES) {
  try {
    if (priorityMuteTimers.has(jid)) {
      clearTimeout(priorityMuteTimers.get(jid));
    }
    const t = setTimeout(() => {
      panelState.aiDisabledChats.delete(jid);
      const s = sessions.get(jid);
      if (s?.priority) s.priority.active = false;
      console.log(`[PRIORITY] 🔓 Rehabilitado chat ${jid} tras ${minutes} min`);
      priorityMuteTimers.delete(jid);
    }, minutes * 60 * 1000);
    priorityMuteTimers.set(jid, t);
  } catch (e) {
    console.error('[PRIORITY] scheduleUnmuteChat error:', e);
  }
}


function isCoomeva(v='') {
  const s = norm(v);
  // tolera “coomeva/comeva”
  return s.includes('coomeva') || s.includes('comeva');
}
function isPreferente(v='') {
  const s = norm(v);
  return s.includes('preferente') || s.includes('preferencial');
}


function ventanasPorDia(date, tipo = '') {
  const dow = date.weekday; // 1=Lun ... 7=sDom
  const t = norm(tipo);
  const v = [];
  const H = (h, m = 0) => date.set({ hour: h, minute: m, second: 0, millisecond: 0 });
  const push = (start, end) => { if (end > start) v.push({ start, end }); };

  if (dow === 2) return v; // Martes sin consulta

  // Lunes
  if (dow === 1) {
    if (t.includes('control virtual')) return v;        // lunes solo presencial
    push(H(8,0), H(11,30));
    push(H(14,0), H(17,30));
    return v;
  }

  // Miércoles y Jueves → 14:00 a 17:30 (antes lo tenías hasta 16:30)
  if (dow === 3 || dow === 4) {
    if (t.includes('control virtual')) return v;
    push(H(14,0), H(17,30));
    return v;
  }

  // Viernes: presencial en la mañana / virtual en la tarde
  if (dow === 5) {
    if (t.includes('control virtual')) {
      push(H(14,0), H(17,30));
    } else {
      push(H(8,0), H(11,30));
    }
    return v;
  }

  // Sáb / Dom sin consulta
  return v;
}

function generarSlots(dateISO, tipo, maxSlots = 100) {
  const date = DateTime.fromISO(dateISO, { zone: ZONE });
  const ventanas = ventanasPorDia(date, tipo);
  const dur = duracionPorTipo(tipo);
  const slots = [];
  for (const win of ventanas) {
    let cursor = win.start;
    while (cursor.plus({ minutes: dur }) <= win.end) {
      const fin = cursor.plus({ minutes: dur });
      slots.push({ inicio: cursor.toISO({ suppressMilliseconds: true }), fin: fin.toISO({ suppressMilliseconds: true }) });
      cursor = fin;
      if (slots.length >= maxSlots) break;
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
  let start = DateTime.fromISO(desdeISO, { zone: ZONE });
  if (!start.isValid) start = firstAllowedStart();
  const minStart = firstAllowedStart();
  if (start < minStart) start = minStart;

  const endOfMonth    = start.endOf('month').startOf('day');
  const blocked       = start.day >= MONTH_CUTOFF_DAY; // 24 o más
  const nextMonthStart= start.plus({ months: 1 }).startOf('month');
  const diasMax       = Math.max(0, Math.floor(endOfMonth.diff(start, 'days').days) + 1);

  return { start, endOfMonth, blocked, nextMonthStart, diasMax };
}

function clampDiasToMonth(desdeISO, diasSolicitados) {
  const pol = monthPolicyFrom(desdeISO);
  return Math.min(diasSolicitados, pol.diasMax);
}


function filtrarSlotsLibres(slots, busy) {
  if (!busy.length) return slots;
  return slots.filter(s => {
    const s1 = DateTime.fromISO(s.inicio, { zone: ZONE });
    const s2 = DateTime.fromISO(s.fin,    { zone: ZONE });
    return !busy.some(b => overlaps(s1, s2, b.start, b.end));
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


// ====== Disponibilidad (rango) ======
async function disponibilidadPorDias({ tipo, desdeISO, dias = 30, maxSlotsPorDia = 100 }) {
  console.time(`disponibilidad:${desdeISO}:${dias}:${tipo}`);
  const start = DateTime.fromISO(desdeISO, { zone: ZONE });

  const diasLista = [];
  for (let i = 0; i < dias; i++) diasLista.push(start.plus({ days: i }));

  const CONCURRENCY = 3;
  const out = [];
  let idx = 0;

  async function worker() {
    while (idx < diasLista.length) {
      const d = diasLista[idx++];

      try {
        const dISO = d.toISODate();
        const { dur, ventanas, slots } = generarSlots(dISO, tipo, 2000);
        if (!ventanas.length) continue;

        console.time(`fb:${dISO}`);
        const busy = await consultarBusy(ventanas);   // consulta día completo
        console.timeEnd(`fb:${dISO}`);

        const libres = filtrarSlotsLibres(slots, busy);  // ← sin slice
        if (libres.length) {
          out.push({
            fecha: dISO,
            duracion_min: dur,
            total: libres.length,
            ejemplos: libres.slice(0, 8).map(s => DateTime.fromISO(s.inicio, { zone: ZONE }).toFormat('HH:mm')), // solo preview
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

async function showAvailabilityNow(session, now, _firstAllowedStart, _monthPolicyFrom) {
  const pol  = _monthPolicyFrom(_firstAllowedStart(now).toISODate());
  if (pol.blocked) {
    return `No agendamos esta semana. La agenda del mes está detenida desde el día ${_MONTH_CUTOFF_DAY}. ` +
           `Vuelve a escribir a partir del ${pol.nextMonthStart.setLocale('es').toFormat("d 'de' LLLL")}.`;
  }
  const desde = pol.start.toISODate();
  const tipo  = session.tipoActual || 'Control presencial';
  const dias  = pol.diasMax;

  const diasDisp = await disponibilidadPorDias({ tipo, desdeISO: desde, dias });
  if (!diasDisp.length) {
    return `No tengo cupos en ${pol.start.setLocale('es').toFormat('LLLL')}. ` +
           `¿Deseas intentar con otro tipo de cita (p. ej., **Control virtual** el viernes tarde)?`;
  }
  const lineas = diasDisp.map(d => {
    const fecha = fmtFechaHumana(d.fecha);
    const horas = (d.slots || []).map(s => fmtHoraHumana(s.inicio)).join(', ');
    return `- ${fecha}: ${horas}`;
  }).join('\n');
  return `Disponibilidad de citas:\n${lineas}\n\n¿Cuál eliges?`;
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
    const timeMax = now.plus({ days: 60 }).toUTC().toISO();
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

function parsePatientData(text = '') {
  const out = {}; const s = String(text || '');
  const get = (re, i = 1) => { const m = s.match(re); return m ? m[i].trim() : undefined; };
  out.nombre   = get(/(?:^|\b)nombre\s*[:\-]?\s*([^\n,;]+)/i);
  out.apellido = get(/(?:^|\b)apellido\s*[:\-]?\s*([^\n,;]+)/i);
  out.cedula   = get(/(?:c[eé]dula|cedula|cc|documento)\s*[:\-]?\s*([0-9.\-]+)/i);
  out.correo   = get(/([a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,})/i);
  const phone  = s.match(/(\+?\d[\d\s\-]{7,}\d)/);
  out.telefono = phone ? phone[1].replace(/[\s\-]/g, '') : undefined;
  out.direccion= get(/(?:direcci[oó]n|direccion)\s*[:\-]?\s*([^\n]+)/i);
  const parts = s.split(/[\n,;]+/).map(x => x.trim()).filter(Boolean);
  if ((!out.nombre || !out.apellido || !out.cedula || !out.correo || !out.telefono || !out.direccion) && parts.length >= 6) {
    out.nombre = out.nombre || parts[0];
    out.apellido = out.apellido || parts[1];
    out.cedula = out.cedula || parts[2];
    out.correo = out.correo || (parts[3].includes('@') ? parts[3] : out.correo);
    out.telefono = out.telefono || parts[4].replace(/[\s\-]/g, '');
    out.direccion = out.direccion || parts.slice(5).join(', ');
  }
  return out;
}
function missingPatientFields(d = {}) { return ['nombre','apellido','cedula','correo','telefono','direccion'].filter(k => !d[k] || !String(d[k]).trim()); }
// Normaliza "10", "10:0", "10:00" → "10:00"
function normHHmm(hora) {
  const s = String(hora || '').trim();
  const m = s.match(/^(\d{1,2})(?::?(\d{1,2}))?$/);
  if (!m) return null;
  const hh = String(Math.min(23, parseInt(m[1],10))).padStart(2,'0');
  const mm = String(Math.min(59, parseInt(m[2] ?? '0',10))).padStart(2,'0');
  return `${hh}:${mm}`;
}



async function resumirPDF(textoPlano, birads) {
  const prompt = `Resume en 2–3 líneas, en español, los hallazgos clave de este informe de imagen mamaria. Incluye lateralidad si aparece, hallazgos relevantes y recomendación. Si hay BI-RADS, menciónalo como "BI-RADS ${birads || ''}". Evita datos personales.

==== TEXTO ====
${String(textoPlano || '').slice(0, 12000)}
==== FIN ====`;
  try {
    const c = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'Eres un asistente clínico que escribe resúmenes MUY breves y precisos en español (máx 3 líneas).' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.2,
      max_tokens: 180,
    });
    return c.choices[0].message.content.trim();
  } catch (e) { console.error('⚠️ Error resumiendo PDF:', e); return null; }
}

// ====== Cancelación ======
async function cancelEventById(eventId) {
  try { await calendar.events.delete({ calendarId: CALENDAR_ID, eventId, sendUpdates: 'none' }); return { ok: true }; }
  catch (err) { const code = err?.response?.status || err?.code; return { ok: false, code, err }; }
}



// === CANCEL: helpers de búsqueda por fecha/hora (local) ===
/**
 * Busca un evento alrededor de una hora local dada con tolerancia.
 * - Busca en un rango de ±30 min en Google Calendar
 * - Selecciona el más cercano si está a ≤10 min del objetivo
 */
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

async function findEventByCedulaAndLocal({ cedula, fechaISO, horaHHmm }) {
  if (!cedula || !fechaISO || !horaHHmm) return null;
  const day = DateTime.fromISO(fechaISO, { zone: ZONE }); if (!day.isValid) return null;
  const fechaTarget = day.toISODate();
  const targetMinutes = parseHoraToMinutes(horaHHmm); if (targetMinutes == null) return null;

  const resp = await calendar.events.list({
    calendarId: CALENDAR_ID,
    timeMin: day.startOf('day').toUTC().toISO(),
    timeMax: day.endOf('day').toUTC().toISO(),
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 250,
    q: cedula,
  });

  const items = resp.data.items || [];
  const normCed = String(cedula).replace(/\D/g, '');
  const byCedula = items.filter(ev => {
    if (!ev || !ev.description) return false;
    const desc = ev.description.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
    const m = /cedula:\s*([0-9.\-]+)/i.exec(desc);
    const onlyDigits = m?.[1]?.replace(/\D/g, '') || '';
    return onlyDigits === normCed;
  });

  for (const ev of byCedula) {
    const startISO = ev.start?.dateTime; if (!startISO) continue;
    const startLocal = DateTime.fromISO(startISO, { zone: ZONE }); if (!startLocal.isValid) continue;
    const sameDate = startLocal.toISODate() === fechaTarget;
    const evMinutes = startLocal.hour * 60 + startLocal.minute;
    if (sameDate && evMinutes === targetMinutes) {
      return { eventId: ev.id, startISO: startLocal.toISO(), endISO: ev.end?.dateTime ? DateTime.fromISO(ev.end.dateTime, { zone: ZONE }).toISO() : null };
    }
  }
  return null;
}

// ===== LLM outage handling =====
const LLM_COOLDOWN_MIN = 60; // minutos apagada la IA en ese chat

let _llmSilenceUntilISO = null; // evita spam en consola

function logLLMErrorOnce(e) {
  const now = DateTime.now().setZone(ZONE);
  if (_llmSilenceUntilISO && now < DateTime.fromISO(_llmSilenceUntilISO, { zone: ZONE })) return;
  _llmSilenceUntilISO = now.plus({ minutes: 2 }).toISO();
  const code = e?.status || e?.code || 'ERR';
  const msg = (e?.message || '').slice(0, 160).replace(/\s+/g, ' ');
  console.warn(`[LLM][DOWN] code=${code} msg=${msg}`);
}

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
function stripActionJSON(text = '') {
  let s = String(text || '');
  s = s.replace(/```(?:json)?[\s\S]*?```/gi, '');       // bloque ```json ... ```
  s = s.replace(/\{[\s\S]*?"action"\s*:[\s\S]*?\}/gi, ''); // objetos con "action":
  s = s.replace(/\s{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return s;
}


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

if (action === 'consultar_disponibilidad') {
  // REEMPLAZA por este encabezado robusto
  const userWants = guessTipo(session.lastUserText || '');
  let tipo = (payload.data?.tipo) || userWants || session.tipoActual || 'Control presencial';
  session.tipoActual = tipo; // persistimos

  let { fecha } = payload.data || {};
  if (fecha) fecha = coerceFutureISODate(fecha);

  const { dur, ventanas, slots } = generarSlots(fecha, tipo, 60);
  if (!ventanas.length) { results.push({ ok: true, fecha, tipo, duracion_min: dur, slots: [], note: 'Día sin consulta según reglas' }); continue; }
  const busy = await consultarBusy(ventanas);
  const libres = filtrarSlotsLibres(slots, busy);
  results.push({ ok: true, fecha, tipo, duracion_min: dur, slots: libres });
  continue;
}

    // DISPONIBILIDAD (rango)
if (action === 'consultar_disponibilidad_rango') {
  // REEMPLAZA por este encabezado robusto
  const userWants = guessTipo(session.lastUserText || '');
  let tipo = (payload.data?.tipo) || userWants || session.tipoActual || 'Control presencial';
  session.tipoActual = tipo; // persistimos

  let { desde, dias = 60 } = payload.data || {};
  const nowLocal = DateTime.now().setZone(ZONE);
  const desdeFixed = desde ? coerceFutureISODateOrToday(desde) : nowLocal.toISODate();

  // (Si aplicas tu política de mes/corte del 24, deja aquí tus límites)
  dias = Math.max(18, Math.min(dias, 60));

  let lista = await disponibilidadPorDias({ tipo, desdeISO: desdeFixed, dias });

  // (Si ya quitaste el “ampliar a 30 días”, conserva tu versión)
  results.push({ ok: true, tipo, desde: desdeFixed, dias, dias_disponibles: lista });
  continue;
}

// CREAR CITA
if (action === 'crear_cita') {
  const d = payload.data || {};
  const s = DateTime.fromISO(d.inicio, { zone: ZONE });
  const e = DateTime.fromISO(d.fin,   { zone: ZONE });

  // === Tipo efectivo y cache ===
  const tipoEff = (d.tipo || session.tipoActual || 'Control presencial').trim();
  session.tipoActual = tipoEff;

  // === Merge paciente: payload > session (SEÑUELOS NO BLOQUEAN) ===
  const pat = {
    nombre:            d.nombre            ?? session.patient?.nombre,
    cedula:            d.cedula            ?? session.patient?.cedula,
    entidad_salud:     d.entidad_salud     ?? session.patient?.entidad_salud,
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
  session.patient = { ...(session.patient||{}), ...pat };

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

  // === Validaciones de tiempo
  if (!s.isValid || !e.isValid || s >= e) {
    results.push({ ok: false, error: 'fecha_invalida', message: 'Fecha/hora inválida.' });
    session.lastSystemNote = 'El último intento falló: fecha/hora inválida.';
    continue;
  }
  if (s < now) {
    results.push({ ok: false, error: 'fecha_pasada', message: 'La hora elegida ya pasó. Elige una fecha futura.' });
    session.lastSystemNote = 'Falló por fecha pasada.';
    continue;
  }

  // === (Opcional) solo mes en curso
  const nowZ = now.setZone(ZONE);
  if (s.month !== nowZ.month || s.year !== nowZ.year) {
    results.push({
      ok: false,
      error: 'fuera_de_mes',
      message: 'En este momento solo agendamos dentro del mes en curso.'
    });
    session.lastSystemNote = 'Falló por fuera del mes actual.';
    continue;
  }

  // === Mínimo absoluto (si aplica)
  if (typeof MIN_BOOKING_DATE_ISO === 'string' && MIN_BOOKING_DATE_ISO) {
    const minDay = DateTime.fromISO(MIN_BOOKING_DATE_ISO, { zone: ZONE }).startOf('day');
    if (minDay.isValid && s < minDay) {
      results.push({
        ok:false,
        error:'antes_minimo',
        message:`Solo agendamos desde el ${minDay.setLocale('es').toFormat("d 'de' LLLL yyyy")} en adelante.`
      });
      session.lastSystemNote = 'Falló por fecha anterior al mínimo.';
      continue;
    }
  }

  // === OBLIGATORIOS REALES (incluye NOMBRE)
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
  const missing = required.filter(k => !pat[k] || String(pat[k]).trim()==='');
  if (missing.length) {
    const human = missing.map(k => labels[k] || k).join(', ');
    results.push({
      ok:false,
      error:'faltan_campos',
      message:`Antes de agendar necesito: ${human}.`
    });
    session.lastSystemNote = `Crear_cita bloqueado: faltan ${missing.join(', ')}.`;
    continue;
  }

  // === Coomeva Preferente (no atendemos)
  const entidadRaw = String(pat.entidad_salud||'');
  const planRaw = String(pat.plan||'');
  if (/coomeva/i.test(entidadRaw) && /preferent/i.test(entidadRaw + ' ' + planRaw)) {
    results.push({
      ok:false,
      error:'coomeva_preferente',
      message:'No podemos agendar con Coomeva Preferente. ¿Deseas agendar como particular?'
    });
    session.lastSystemNote = 'Intento con Coomeva Preferente bloqueado.';
    continue;
  }

  // === Ventanas válidas (lunes/mié/jue/vie, etc.)
  if (!slotDentroDeVentanas(d.inicio, d.fin, tipoEff)) {
    results.push({ ok: false, error: 'fuera_horario', message: 'Ese día/horario no es válido según las reglas.' });
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
    results.push({ ok: false, error: 'slot_ocupado', message: 'Ese horario ya está reservado. Elige otra opción.' });
    session.lastSystemNote = 'Falló por slot ocupado.';
    continue;
  }

  // === Nombre (ahora obligatorio)
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
          // —— SEÑUELOS (si llegaron)
          (pat.fecha_nacimiento ? `Fecha de nacimiento: ${pat.fecha_nacimiento}\n` : '') +
          (pat.tipo_sangre ? `Tipo de sangre: ${pat.tipo_sangre}\n` : '') +
          (pat.estado_civil ? `Estado civil: ${pat.estado_civil}\n` : '') +
          `Dirección: ${pat.direccion || ''}\n` +
          `Ciudad: ${pat.ciudad || ''}`,
        start: { dateTime: s.toISO(), timeZone: ZONE },
        end:   { dateTime: e.toISO(), timeZone: ZONE },
      },
    });

    // === Confirmación final
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
    results.push({ ok: false, error: 'gcal_insert_error', message: 'No se pudo crear la cita en Google Calendar.' });
    session.lastSystemNote = 'No se pudo crear la cita en Google Calendar.';
  }
  continue;
}


    // GUARDAR PACIENTE
    if (action === 'guardar_paciente') { results.push({ ok: true, saved: true }); continue; }

if (action === 'cancelar_cita') {
  const d = payload.data || {};
  const cedula = (d.cedula || '').trim(); // señuelo: lo registramos, no lo usamos para buscar
  console.log('[CANCEL] Cédula recibida (señuelo, no valida):', cedula || '(vacía)');

  const fecha = (d.fecha || '').trim();
  const hora  = (d.hora  || '').trim();

  if (!fecha || !hora) {
    console.log('[CANCEL] Falta fecha u hora → pedir datos');
    results.push({ ok:false, error:'falta_fecha_hora', message:'Indícame la fecha (AAAA-MM-DD) y la hora (HH:mm) exactas de tu cita.' });
    continue;
  }

  const hhmm = normHHmm(hora);
  if (!hhmm) {
    console.log('[CANCEL] Hora inválida (normHHmm falló):', hora);
    results.push({ ok:false, error:'hora_invalida', message:'Formato de hora inválido. Usa 24h, por ejemplo: 08:00 o 14:30.' });
    continue;
  }

  console.log(`[CANCEL] Buscando evento por fecha/hora → ${fecha} ${hhmm} (${ZONE}) con tolerancia ±10min`);
  const found = await findEventByLocal({ fechaISO: fecha, horaHHmm: hhmm, toleranceMin: 10 });

  if (!found) {
    console.log('[CANCEL][ERR] No se encontró evento con fecha/hora dentro de la tolerancia.');
    results.push({ ok:false, error:'no_encontrada', message:'No encontré una cita exactamente con esos datos.' });
    continue;
  }

  console.log('[CANCEL] Cancelando eventId=', found.eventId, 'startLocal=', found.startLocal);
  const del = await cancelEventById(found.eventId);
  if (!del.ok) {
    console.log('[CANCEL][ERR] No se pudo cancelar:', del.code);
    results.push({ ok:false, error:'cancel_error', code:del.code, message:'No se pudo cancelar la cita.' });
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
function ensurePatient(session){ if(!session.patient) session.patient = {}; return session.patient; }

function extractCedula(s){ const m=(s||'').match(/\b(\d{6,12})\b/); return m?m[1]:null; }
function extractPhone(s){
  const clean=(s||'').replace(/\s+/g,'');
  const m=clean.match(/(\+?57)?3\d{9}/);
  if(!m) return null;
  const v=m[0]; 
  return v.startsWith('+') ? v : (v.startsWith('57')? ('+'+v) : ('+57'+v));
}
function extractEmail(s){ const m=(s||'').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i); return m?m[0]:null; }

// AAAA-MM-DD o dd/mm/aaaa
function extractFechaNacimiento(s){
  const m1=(s||'').match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if(m1) return `${m1[1]}-${m1[2]}-${m1[3]}`;
  const m2=(s||'').match(/\b(\d{2})\/(\d{2})\/(\d{4})\b/);
  if(m2) return `${m2[3]}-${m2[2]}-${m2[1]}`;
  return null;
}

// A+, A-, B+, B-, AB+, AB-, O+, O-
function extractBloodType(s){
  const m=(s||'').toUpperCase().match(/\b(AB|A|B|O)\s*([+-])\b/);
  return m ? (m[1].toUpperCase()+m[2]) : null;
}

const CIVILES=['soltero','soltera','casado','casada','union libre','unión libre','divorciado','divorciada','viudo','viuda'];
function extractEstadoCivil(s){
  const low=(s||'').toLowerCase();
  const f=CIVILES.find(x=>low.includes(x));
  return f ? (f[0].toUpperCase()+f.slice(1)) : null;
}

// heurísticas rápidas (opcional)
function extractDireccion(s){
  const m=(s||'').match(/\b(cr[ae]\.?|cra\.?|carrera|cll\.?|calle|av\.?|avenida|dg\.?|diagonal|tv\.?|transversal)\b[\s\S]{0,40}/i);
  return m? m[0].trim() : null;
}
function extractCiudad(s){
  const m=(s||'').match(/\b(barranquilla|bogotá|bogota|medell[ií]n|cali|soledad|cartagena|santa marta|valledupar|bucaramanga)\b/i);
  return m ? (m[0][0].toUpperCase()+m[0].slice(1)) : null;
}

const ENTIDADES = ['Sudamericana','Colsanitas','Medplus','Bolívar','Bolivar','Allianz','Colmédica','Colmedica','Coomeva','Particular'];
function extractEntidadSalud(s){
  for (const e of ENTIDADES){
    if (new RegExp(e,'i').test(s||'')) return e.replace('í','i');
  }
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
  p.entidad_salud     = p.entidad_salud     || extractEntidadSalud(t);
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
  
  const from = normJid(String(req.body.from || 'anon'));
  const userMsg = String(req.body.message || '').trim();

  // 1) OBTÉN SESIÓN Y NOW ANTES DE USARLA EN CUALQUIER BLOQUE
  const session = getSession(from);
  const now = DateTime.now().setZone(ZONE);

  // 2) DESBLOQUEO DE PRIORIDAD VENCIDA (usa session ya definida)
  if (session.priority?.active && now >= DateTime.fromISO(session.priority.lockUntilISO)) {
    session.priority = null;
  }
  if (session.priority?.active && session.priority.status === 'submitted') {
    return res.json({ reply: PRIORITY_LOCK_MESSAGE });
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

  // 5) RESET DURO
  if (userMsg === '__RESET__') {
    sessions.delete(from);
    return res.json({ ok: true, reset: true });
  }

  // ─────────────────────────────────────────────────────────
  // Fallbacks locales por si NO pegaste los helpers globales:
  // firstAllowedStart / monthPolicyFrom y constante MONTH_CUTOFF_DAY
  const _MONTH_CUTOFF_DAY = (typeof MONTH_CUTOFF_DAY === 'number' ? MONTH_CUTOFF_DAY : 24);

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

      // 🔓 Ya no cortamos al fin de mes: miramos hacia adelante N días
      const end = start.plus({ days: LOOKAHEAD_DAYS - 1 }).endOf('day');
      const diasMax = Math.max(0, Math.floor(end.diff(start, 'days').days) + 1);

      return {
        start,                // inicio permitido
        endOfMonth: end,      // (compat) no se usa como fin de mes ya
        blocked: false,       // 🔓 nunca bloqueado por “corte del mes”
        nextMonthStart: null, // (compat) ya no aplica
        diasMax               // típicamente = LOOKAHEAD_DAYS
      };
    };

  // ─────────────────────────────────────────────────────────

  // Desbloqueo de prioridad vencida
// Desbloqueo de prioridad vencida
if (session.priority?.active && now >= DateTime.fromISO(session.priority.lockUntilISO)) {
  console.log(`[PRIORITY] Expiró lock en ${from}, desbloqueando`);
  session.priority = null;
  panelState.aiDisabledChats.delete(from);
}

if (session.priority?.active) {
  console.log(`[PRIORITY] Chat bloqueado ${from} — se devuelve mensaje fijo`);
  return res.json({ reply: 'Atención prioritaria. Un asesor te contactará en breve.' });
}



  // Reset duro de sesión
  if (userMsg === '__RESET__') {
    sessions.delete(from);
    return res.json({ ok: true, reset: true });
  }

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
    if (/(biops)/.test(s)) return 'Biopsia guiada por ecografía';
    if (/(virtual|en\s*linea|en\s*l[ií]nea|online)/.test(s)) return 'Control virtual';
    if (/(primera\s*vez|primer[ao]\s*consulta|nueva\s*(cita|consulta))/i.test(s)) return 'Primera vez';
    if (/\bcontrol\b/.test(s) && !/virtual/.test(s)) return 'Control presencial';
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
    'No muestres JSON ni bloques de código al paciente.' +
    '***Las cancelaciones/reprogramaciones no se hacen por chat: remite siempre a Deivis.***';

  const epsNote =
    'Si la entidad es **Coomeva** y el plan es **Preferente**, NO se atiende ni se agenda. ' +
    'Si dicen Coomeva sin plan, pregunta explícitamente por el plan.';

  const actionNote =
    'Para ejecutar acciones usa SIEMPRE un bloque: ' +
    '```action\\n{"action":"...","data":{...}}\\n``` ' +
    'y además responde con texto natural para el paciente. Yo oculto el bloque. ' +
    'No confirmes citas en el texto visible hasta que el sistema te devuelva confirmación.';

  // Reglas duras de datos para "Primera vez"
// Reglas de datos para "Primera vez" (permisivas)
const firstTimeNote =
  'Si el motivo es "Primera vez": pide TODOS los datos en UN SOLO mensaje (usa la plantilla), ' +
  'pero **sí puedes consultar disponibilidad** aunque falte alguno. ' +
  'Solo BLOQUEA al **crear_cita** si falta un campo del núcleo: ' +
  'nombre completo, cédula, entidad_salud, correo, celular, dirección y ciudad. ' +
  'Los campos “señuelo” (fecha de nacimiento, tipo de sangre, estado civil) no bloquean.';

    

  session.history.push({ role: 'system', content: todayNote });
  session.history.push({ role: 'system', content: policyNote });
  session.history.push({ role: 'system', content: epsNote });
  session.history.push({ role: 'system', content: actionNote });
  session.history.push({ role: 'system', content: firstTimeNote });

  // Fijar tipo por mensaje explícito y guardar último texto
  const explicitTipo = guessTipo(userMsg);
  if (explicitTipo) session.tipoActual = explicitTipo;
  session.lastUserText = userMsg;

  // Tomar datos del mensaje actual para ir llenando session.patient
collectPatientFields(session, userMsg);

// ✅ Si ya está completo el núcleo de "Primera vez", NO volver a pedirlo
if (/primera\s*vez/i.test(tipoEfectivo) && missingForTipo(session, 'Primera vez').length === 0) {
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
  touchSession(session); 
  try {
   // ===== LLM con guard =====
   const completion = await callLLMWithGuard(session.history, {
    model: 'gpt-4o',
    temperature: 0.4,
    // max_tokens: 600,  // opcional si quieres acotar presupuesto
    retries: 3,          // 1º intenta gpt-4o, 2º gpt-4o-mini, 3º reintenta
   });

   const replyRaw = completion.choices?.[0]?.message?.content || '';
   const actionResult = await maybeHandleAssistantAction(replyRaw, session);

   // Texto visible (sin JSON ni bloques)
   let reply = stripActionBlocks(replyRaw);

    // ========== Si hubo acciones, formatear según resultado real ==========
   // ========= Si hubo acciones, ARMAR RESPUESTA SÓLO CON RESULTADOS =========
   if(actionResult?.handled && actionResult.makeResponse) {
   const mr = Array.isArray(actionResult.makeResponse)
    ? actionResult.makeResponse
    : [actionResult.makeResponse];

   const errors    = mr.filter(x => x && x.ok === false);
   const cancelled = mr.find(x => x && x.cancelled === true);
   const daysResp  = mr.find(x => Array.isArray(x?.dias_disponibles));
   const daySlots  = mr.find(x => Array.isArray(x?.slots));
   const created   = mr.find(x => x && x.ok === true && (x.eventId || x.confirmText));
   const saved     = mr.find(x => x && x.saved === true);

   let reply = ''; // <- IMPORTANTE: partimos en blanco, NO usamos texto del modelo

   if (cancelled) {
    // Log y respuesta de éxito al paciente
    console.log('[CANCEL][OK] Enviando confirmación de cancelación al paciente.');
    reply = '✅ Tu cita fue cancelada correctamente. ¿Deseas **reprogramarla**? Puedo mostrarte la disponibilidad actual.';
   } else if (errors.length) {
    // Si hubo error real en la acción, mostramos errores (si quieres aquí puedes meter el fallback Deivis)
    console.log('[CANCEL][ERR]', errors);
    // Si el error fue “no_encontrada” o “falta_fecha_hora” → dar número de Deivis
    const noEncontrada = errors.find(e => e?.error === 'no_encontrada' || /no_encontrad/i.test(e?.message||''));
    const faltaHora    = errors.find(e => e?.error === 'falta_fecha_hora');
    if (noEncontrada || faltaHora) {
      reply = `No pude ubicar la cita con la información dada. Para cancelar o reprogramar, por favor comunícate con nuestro asesor *Deivis* al *${STAFF_DEIVIS_PHONE}*.`;
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
   } else if (daySlots) {
  if (!daySlots.slots.length) {
    reply = `Para ${fmtFechaHumana(daySlots.fecha)} no hay cupos válidos. ¿Quieres otra fecha?`;
  } else {
    const fechaTxt = fmtFechaHumana(daySlots.fecha);
    const horas = daySlots.slots.map(s => fmtHoraHumana(s.inicio)).join(', ');
    reply = `Disponibilidad de citas — ${fechaTxt}:\n${horas}\n\n¿Te sirve alguna? Responde con la hora exacta (ej. "8:15").`;
  }
  // ⬇️ Guardar oferta
  session.lastOffered = {
    tipo: session.tipoActual || 'Control presencial',
    days: [{ fechaISO: daySlots.fecha, slots: (daySlots.slots||[]).map(s => ({ inicio: s.inicio, fin: s.fin })) }],
    singleDay: true
  };

} else if (daysResp) {
  if (!daysResp.dias_disponibles.length) {
    reply = `No tengo cupos en los próximos ${daysResp.dias} días. ¿Probamos otro rango?`;
  } else {
    const lineas = daysResp.dias_disponibles.map(d => {
      const fecha = fmtFechaHumana(d.fecha);
      const horas = (d.slots || []).map(s => fmtHoraHumana(s.inicio)).join(', ');
      return `- ${fecha}: ${horas}`;
    }).join('\n');
    reply = `Disponibilidad de citas:\n${lineas}\n\n¿Cuál eliges?`;
  }
  // ⬇️ Guardar oferta
  session.lastOffered = {
    tipo: session.tipoActual || 'Control presencial',
    days: (daysResp.dias_disponibles || []).map(d => ({
      fechaISO: d.fecha, slots: (d.slots||[]).map(s => ({ inicio: s.inicio, fin: s.fin }))
    })),
    singleDay: (daysResp.dias_disponibles || []).length === 1
  };
}


   reply = (reply || '').trim();
   if (!reply) reply = 'Listo ✅';

   // Traza para ver lo que se enviará
   console.log('[CHAT][FINAL-REPLY]', reply);

   session.history.push({ role: 'assistant', content: reply });
   capHistory(session);
   touchSession(session);
   return res.json({ reply, makeResponse: actionResult.makeResponse });
   }


   // Si el modelo "prometió" consultar pero NO mandó acción JSON → mostrar disponibilidad
const promisedToCheck =
  /consultar[ée]? la disponibilidad|voy a consultar la disponibilidad|un momento,\s*por favor/i.test(replyRaw);

if (!actionResult?.handled && promisedToCheck) {
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
if (!actionResult?.handled && dateWanted) {
  try {
    const tipo = session.tipoActual || 'Control presencial';
    const day = await disponibilidadPorDias({ tipo, desdeISO: dateWanted, dias: 1 });

    if (!day.length || !(day[0].slots || []).length) {
      reply = `Para ${fmtFechaHumana(dateWanted)} no hay cupos válidos. ¿Quieres otra fecha?`;
    } else {
      const horas = day[0].slots.map(s => fmtHoraHumana(s.inicio)).join(', ');
      reply = `Disponibilidad de citas — ${fmtFechaHumana(dateWanted)}:\n${horas}\n\n¿Te sirve alguna? Responde con la hora exacta (ej. "8:15").`;
    }
    console.log('[AUTO-DISPONIBILIDAD-DÍA] fecha del usuario → enviada');
  } catch (e) {
    console.error('❌ Auto-disponibilidad por día error:', e);
  }
}

// === AUTO-CREAR SI EL USUARIO ELIGE UN HORARIO DE LOS ÚLTIMOS OFRECIDOS ===
if (!actionResult?.handled && session.lastOffered && session.lastOffered.days?.length) {
  const hhmm = extractHour(userMsg);
  const dateFromMsg = parseUserDate(userMsg);

  // Determinar fecha candidata
  let chosenDay = null;
  if (dateFromMsg) {
    chosenDay = session.lastOffered.days.find(d => d.fechaISO === dateFromMsg);
  } else if (session.lastOffered.singleDay) {
    chosenDay = session.lastOffered.days[0];
  }

  // Si tenemos fecha y hora, buscar el slot
  if (chosenDay && hhmm) {
    const slot = (chosenDay.slots || []).find(s => {
      const h = DateTime.fromISO(s.inicio, { zone: ZONE }).toFormat('HH:mm');
      return h === hhmm;
    });

    if (slot) {
      // Validar núcleo (nombre, cédula, entidad_salud, correo, celular, dirección, ciudad)
      const P = session.patient || {};
      const core = ['nombre','cedula','entidad_salud','correo','celular','direccion','ciudad'];
      const missingCore = core.filter(k => !String(P[k]||'').trim());
      if (missingCore.length) {
        reply = `Antes de agendar necesito: ${missingCore.join(', ')}. Por favor envíalos en un solo mensaje.`;
      } else {
        // Construir acción crear_cita y ejecutarla por la misma ruta
        const payload = {
          action: 'crear_cita',
          data: {
            nombre: P.nombre,
            cedula: P.cedula,
            entidad_salud: P.entidad_salud,
            correo: P.correo,
            celular: P.celular,
            direccion: P.direccion,
            ciudad: P.ciudad,
            tipo: session.tipoActual || 'Control presencial',
            inicio: slot.inicio,
            fin: slot.fin
          }
        };
        const block = '```action\n' + JSON.stringify(payload, null, 2) + '\n```';
        const autoRes = await maybeHandleAssistantAction(block, session);

        if (autoRes?.handled && autoRes.makeResponse) {
          const mr = Array.isArray(autoRes.makeResponse) ? autoRes.makeResponse : [autoRes.makeResponse];
          const created = mr.find(x => x && x.ok === true && (x.eventId || x.confirmText));

          if (created) {
            // armar confirmación (mismo formato que ya usas)
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
  !session.lastOffered // para no repetir si ya ofrecimos
) {
  try {
    const replyAuto = await showAvailabilityNow(session, now, _firstAllowedStart, _monthPolicyFrom);
    // Guardamos la última oferta en session.lastOffered dentro de showAvailabilityNow
    console.log('[AUTO-DISPONIBILIDAD] Primera vez con núcleo completo → mostrando cupos');
    session.history.push({ role: 'assistant', content: replyAuto });
    capHistory(session); touchSession(session);
    // Evitar que se dispare de nuevo en el mismo hilo
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
      try {
        const pol = _monthPolicyFrom(_firstAllowedStart(now).toISODate());
        if (pol.blocked) {
          reply = `No agendamos esta semana. La agenda del mes está detenida desde el día ${_MONTH_CUTOFF_DAY}. Vuelve a escribir a partir del ${pol.nextMonthStart.setLocale('es').toFormat("d 'de' LLLL")}.`;
        } else {
          const desde = _firstAllowedStart(now).toISODate();
const tipo  = session.tipoActual || 'Control presencial';
const dias  = LOOKAHEAD_DAYS; // 🔓 cruza meses

const diasDisp = await disponibilidadPorDias({ tipo, desdeISO: desde, dias });
if (!diasDisp.length) {
  reply = `No tengo cupos en los próximos ${dias} días. ¿Probamos otro rango?`;
} else {
  const lineas = diasDisp.map(d => {
    const fecha = fmtFechaHumana(d.fecha);
    const horas = (d.slots || []).map(s => fmtHoraHumana(s.inicio)).join(', ');
    return `- ${fecha}: ${horas}`;
  }).join('\n');
  reply = `Disponibilidad de citas:\n${lineas}\n\n¿Cuál eliges?`;
}

        }
      } catch (e) {
        console.error('❌ Fallback disponibilidad error:', e);
        reply = '⚠️ No pude consultar la disponibilidad ahora. Intenta de nuevo en unos minutos.';
      }
    }

    reply = stripActionBlocks(reply);
    if (!reply) reply = 'Listo ✅';

    session.history.push({ role: 'assistant', content: reply });
    capHistory(session);
    touchSession(session);
    res.json({ reply, makeResponse: null });
  }catch (e) {
  // En vez de escupir todo el error y devolver 500,
  // desactivamos el chat y mandamos el mensaje al paciente.
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
    let { desde, dias = 60 } = req.body;
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

