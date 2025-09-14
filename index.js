import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import OpenAI from 'openai';
import fetch from 'node-fetch';
import { google } from 'googleapis';
import { DateTime } from 'luxon';
import pdf from 'pdf-parse'; // lector de PDFs

const app = express();
app.use(bodyParser.json());

// =================== ENV / CONFIG ===================
const ZONE = 'America/Bogota';
const WA_VERIFY_TOKEN = process.env.WA_VERIFY_TOKEN;
const WA_PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID;
const WA_ACCESS_TOKEN = process.env.WA_ACCESS_TOKEN;
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID;

if (!process.env.OPENAI_API_KEY) console.warn('⚠️ Falta OPENAI_API_KEY');
if (!WA_VERIFY_TOKEN || !WA_PHONE_NUMBER_ID || !WA_ACCESS_TOKEN) {
  console.warn('⚠️ Falta alguna variable de WhatsApp (WA_VERIFY_TOKEN / WA_PHONE_NUMBER_ID / WA_ACCESS_TOKEN)');
}
if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.warn('⚠️ Falta GOOGLE_APPLICATION_CREDENTIALS (ruta del JSON de la cuenta de servicio).');
}
if (!CALENDAR_ID) console.warn('⚠️ Falta GOOGLE_CALENDAR_ID (email del calendario).');

// OpenAI
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Google Calendar auth con cuenta de servicio
const auth = new google.auth.GoogleAuth({
  keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
  scopes: ['https://www.googleapis.com/auth/calendar'],
});
const calendar = google.calendar({ version: 'v3', auth });

// ============== PROMPT MAESTRO ==============
const systemPrompt = `

Eres **Sana**, asistente virtual de la consulta de mastología del Dr. Juan Felipe Arias.

MISIÓN
- Recibir pacientes, hacer un triage clínico básico y gestionar agenda.
- Cuando necesites interactuar con el sistema (disponibilidad/agendar/guardar), **devuelve únicamente un bloque JSON** con la acción correspondiente, **sin texto antes ni después**.
- **Nunca** declares una cita “confirmada” en texto. Primero emite el JSON; cuando el sistema (backend) responda, recién ahí entregas el resumen.

ESTILO
- Saluda y pídele el **nombre completo** al inicio.
- Habla con claridad y brevedad, sin emojis ni adornos.
- Dirígete por el **nombre** del paciente.
- Mantente en el tema clínico; si se desvían, redirígelo.
- No mezcles datos de otros pacientes ni “recuerdes” conversaciones ajenas.

FLUJO ESTRICTO (en este orden)
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
   - Solicita el resultado más reciente de **mamografía/ecografía** y la **categoría BIRADS**.
   - Si no tiene imágenes recientes o BIRADS 0–3, pregunta por **síntomas de alarma** (p. ej., **masa/nódulo** de aparición **< 3 meses**).
   - **Triage y prioridad**:
     - **BIRADS 4 o 5** → **máxima prioridad**: intenta **agendar lo antes posible** (objetivo ≤ **3 días hábiles**). No transfieras a humano por defecto; solo si el sistema no devuelve cupos en ese rango.
     - **BIRADS 3** → citar en **≤ 7 días hábiles**.
     - **BIRADS 1–2** → mensaje tranquilizador; cita según disponibilidad estándar.
     - **Síntoma de masa/nódulo < 3 meses** → prioriza como **urgencia** (objetivo ≤ 3 días hábiles).
   - Si el paciente **envía un PDF** (informe), puedes usar su contenido (el sistema te lo adjunta como nota). Si no se detecta BIRADS en el PDF, **pídelo**.

5) **Datos obligatorios antes de agendar (para cualquier cita)**:
   - **Nombre y apellido**
   - **Cédula**
   - **Entidad de salud** (o “particular”)
   - **Correo electrónico**
   - **Celular**
   - **Dirección** y **Ciudad**
   Si falta algo, **pídelo**. **No** generes JSON de crear_cita hasta tenerlos.

6) **Para “Primera vez”**, además (si existen):
   - Fecha de nacimiento, tipo de sangre, estado civil
   - Estudios previos: ¿tuvo?, ¿cuándo?, ¿dónde?

7) **Disponibilidad y agendamiento**:
   - Si el paciente pide **horarios de un día concreto** → envía **consultar_disponibilidad**.
   - Si pide “qué días tienes libres” o no da fecha → envía **consultar_disponibilidad_rango** desde **hoy** por **14 días**.
   - Para **BIRADS 4–5** o **síntoma urgente**, intenta **el primer cupo disponible** dentro de los **próximos 3 días hábiles** (respetando las ventanas).
   - Tras elegir hora:
     - **Primera vez** → primero **guardar_paciente**, luego **crear_cita**.
     - **Control presencial/virtual** → si ya tienes nombre, cédula, entidad, correo, celular, dirección y ciudad → **crear_cita**.

8) **Confirmación**:
   - No confirmes en texto por tu cuenta.
   - Cuando el sistema responda “OK/creada”, entrega **resumen**: fecha, hora, duración y lugar + recordatorios/legales.

AGENDA (VENTANAS Y LÍMITES)
- **Lugar**: Clínica Portoazul, piso 7, consultorio 707, Barranquilla.
- **Duraciones**:
  - Primera vez: **20 min**
  - Control presencial: **15 min**
  - Control virtual (resultados): **10 min**
  - Biopsia: **30 min**
- **Ventanas por día/tipo** (**no romper**):
  - **Martes:** sin consulta (rechaza o ofrece otro día).
  - **Lunes (presencial):** 08:00–11:30 y 14:00–17:30.
  - **Miércoles/Jueves (presencial):** 14:00–16:30.
  - **Viernes presencial:** 08:00–11:30 (**no** presencial viernes tarde).
  - **Viernes virtual:** 14:00–16:30 (**solo** controles virtuales).
- **Límites**:
  - No fechas **pasadas**.
  - No **martes**.
  - No agendar **más allá de 15 días**.

COSTOS (si preguntan)
- Consulta de mastología: **350.000 COP**.
- Biopsia guiada por ecografía (solo particular): **800.000 COP** (incluye patología; **no** incluye consulta de lectura de patología).
- Medios de pago: **efectivo, transferencia**.

LEGALES Y RECORDATORIOS (al confirmar)
- Llegar **15 minutos** antes.
- Traer **impresos** todos los reportes previos: mamografías, ecografías, resonancias, informes de biopsia, resultados de cirugía/patología.
- **Grabaciones no autorizadas**: prohibido grabar audio/video durante la consulta sin autorización (Art. 15 Constitución Política de Colombia y Ley 1581 de 2012).

HANDOFF HUMANO
- Si corresponde: **Isa** o **Deivis** — WhatsApp **3108611759**.

REGLAS DURAS (NO ROMPER)
- Las fechas que ofrezcas dales en "9 de septiembre: 14:30, 14:15,..." asi no las pongas asi "- 2025-09-11 (15 min): 14:30, 14:45, " y omite poner la duracion de la cita cuando muestes el disponibilidad 
- Si ya leistes los resultados de pdf o sabes la categoria del birads primero dale un resumen de los resultados y sigue con el curso. 
- No martes, no fuera de ventana, no pasado.
- No >15 días.
- No confirmar sin respuesta del sistema.
- **No mezclar texto y JSON** en el mismo mensaje.
- **No inventes horarios**: primero consulta disponibilidad y ofrece solo lo devuelto por el sistema.
- Si el sistema indica “ocupado” o “fuera de horario”, **no contradigas**: vuelve a pedir disponibilidad u ofrece alternativas válidas.

ACCIONES (JSON ONLY) — **formatos exactos**
1) **Guardar paciente**
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

2) **Consultar disponibilidad (un día)**
{
  "action": "consultar_disponibilidad",
  "data": {
    "tipo": "Control presencial",
    "fecha": "2025-10-06"
  }
}

3) **Consultar días con cupo (rango)**
{
  "action": "consultar_disponibilidad_rango",
  "data": {
    "tipo": "Control presencial",
    "desde": "2025-10-01",
    "dias": 14
  }
}

4) **Crear cita (solo futura, dentro de ventana y ≤15 días)**
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

NOTAS OPERATIVAS
- Para urgencias (BIRADS 4–5 o masa <3m): si el usuario no da fecha, usa consultar_disponibilidad_rango desde hoy (14 días) y ofrece el **primer slot válido**.
- Si el paciente envía un **PDF**, intenta extraer BIRADS; si no se detecta, **solicítalo**.
- Si te piden “horarios” sin fecha → usa rango; con fecha → un día.
- Antes de crear_cita, debes tener **todos** los datos obligatorios del paciente.


`;

// ============== SESIONES POR USUARIO ==============
// Cada número (from) tiene su propio history y lastSystemNote.
const sessions = new Map(); // Map<from, {history, lastSystemNote, updatedAtISO}>
const SESSION_TTL_MIN = 60; // si pasan >60min sin hablar, resetea la sesión

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
    };
    sessions.set(userId, s);
  }
  return s;
}
function touchSession(s) {
  s.updatedAtISO = DateTime.now().setZone(ZONE).toISO();
}
// Opcional: limitar tamaño de history para no crecer infinito
function capHistory(session, max = 40) {
  if (session.history.length > max) {
    const firstSystem = session.history.findIndex(m => m.role === 'system');
    const base = firstSystem >= 0 ? [session.history[firstSystem]] : [];
    session.history = base.concat(session.history.slice(-(max - base.length)));
  }
}

// ============== HELPERS (agenda) ==============
const norm = (s = '') =>
  String(s || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim();

function duracionPorTipo(tipo = '') {
  const t = norm(tipo);
  if (t.includes('primera')) return 20;
  if (t.includes('control presencial')) return 15;
  if (t.includes('control virtual')) return 10;
  if (t.includes('biopsia')) return 30;
  return 15;
}

function ventanasPorDia(date, tipo = '') {
  const dow = date.weekday; // 1=Lun ... 7=Dom
  const t = norm(tipo);
  const v = [];
  const H = (h, m = 0) => date.set({ hour: h, minute: m, second: 0, millisecond: 0 });
  const push = (start, end) => { if (end > start) v.push({ start, end }); };

  if (dow === 2) return v; // Martes: NO consulta

  if (dow === 1) { // Lunes presencial
    if (t.includes('control virtual')) return v;
    push(H(8, 0), H(11, 30));
    push(H(14, 0), H(17, 30));
    return v;
  }

  if (dow === 3 || dow === 4) { // Miércoles/Jueves presencial tarde
    if (t.includes('control virtual')) return v;
    push(H(14, 0), H(16, 30));
    return v;
  }

  if (dow === 5) { // Viernes
    if (t.includes('control virtual')) {
      push(H(14, 0), H(16, 30)); // virtual solo tarde
    } else {
      push(H(8, 0), H(11, 30));  // presencial viernes mañana
    }
    return v;
  }

  return v; // sáb/dom: sin consulta
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
      slots.push({
        inicio: cursor.toISO({ suppressMilliseconds: true }),
        fin: fin.toISO({ suppressMilliseconds: true }),
      });
      cursor = fin;
      if (slots.length >= maxSlots) break;
    }
    if (slots.length >= maxSlots) break;
  }
  return { dur, ventanas, slots };
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && aEnd > bStart;
}

async function consultarBusy(ventanas) {
  if (!ventanas.length) return [];
  const timeMin = ventanas[0].start.toUTC().toISO();
  const timeMax = ventanas[ventanas.length - 1].end.toUTC().toISO();
  const resp = await calendar.freebusy.query({
    requestBody: {
      timeMin,
      timeMax,
      items: [{ id: CALENDAR_ID }],
      timeZone: ZONE,
    },
  });
  const cal = resp.data.calendars?.[CALENDAR_ID];
  const busy = (cal?.busy || []).map(b => ({
    start: DateTime.fromISO(b.start, { zone: ZONE }),
    end: DateTime.fromISO(b.end, { zone: ZONE }),
  }));
  return busy;
}

function filtrarSlotsLibres(slots, busy) {
  if (!busy.length) return slots;
  return slots.filter(s => {
    const s1 = DateTime.fromISO(s.inicio, { zone: ZONE });
    const s2 = DateTime.fromISO(s.fin, { zone: ZONE });
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
  if (!d.isValid) return DateTime.now().setZone(ZONE).toISODate();
  const today = DateTime.now().setZone(ZONE).startOf('day');
  while (d < today) d = d.plus({ years: 1 });
  return d.toISODate();
}

function coerceFutureISODateOrToday(dateStr) {
  let d = DateTime.fromISO(dateStr, { zone: ZONE });
  if (!d.isValid) return DateTime.now().setZone(ZONE).toISODate();
  const today = DateTime.now().setZone(ZONE).startOf('day');
  if (d < today) return today.toISODate();
  return d.toISODate();
}

// 👉 NUEVO: formato humano para respuestas
function fmtFechaHumana(isoDate) {
  return DateTime.fromISO(isoDate, { zone: ZONE }).setLocale('es').toFormat('d LLLL');
}
function fmtHoraHumana(isoDateTime) {
  return DateTime.fromISO(isoDateTime, { zone: ZONE }).toFormat('H:mm');
}

async function disponibilidadPorDias({ tipo, desdeISO, dias = 14, maxSlotsPorDia = 6 }) {
  if (dias > 15) dias = 15;
  if (dias > 10) dias = 10;

  console.time(`disponibilidad:${desdeISO}:${dias}:${tipo}`);
  const start = DateTime.fromISO(desdeISO, { zone: ZONE });
  const diasLista = [];
  for (let i = 0; i < dias; i++) diasLista.push(start.plus({ days: i }));

  const CONCURRENCY = 3;
  const out = [];
  let idx = 0;

  async function worker() {
    while (true) {
      let d;
      if (idx < diasLista.length) {
        d = diasLista[idx];
        idx += 1;
      } else break;

      try {
        const dISO = d.toISODate();
        const { dur, ventanas, slots } = generarSlots(dISO, tipo, 200);
        if (!ventanas.length) continue;
        console.time(`fb:${dISO}`);
        const busy = await consultarBusy(ventanas);
        console.timeEnd(`fb:${dISO}`);
        const libres = filtrarSlotsLibres(slots, busy);
        if (libres.length > 0) {
          out.push({
            fecha: dISO,
            duracion_min: dur,
            total: libres.length,
            ejemplos: libres.slice(0, maxSlotsPorDia).map(s =>
              DateTime.fromISO(s.inicio, { zone: ZONE }).toFormat('H:mm') // 8:00 en vez de 08:00
            ),
            slots: libres.slice(0, maxSlotsPorDia),
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

// ============== WhatsApp send ==============
async function sendWhatsAppText(to, body) {
  const url = `https://graph.facebook.com/v20.0/${WA_PHONE_NUMBER_ID}/messages`;
  const payload = {
    messaging_product: 'whatsapp',
    to,
    text: { body: String(body || '').slice(0, 4096) },
  };
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${WA_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    console.error('❌ WA send error:', r.status, txt);
    throw new Error('wa_send_error');
  }
  return r.json();
}

// ============== NUEVO: helpers de Media (WhatsApp) + BI-RADS + resumen PDF ==============
async function getMediaMeta(mediaId) {
  const url = `https://graph.facebook.com/v20.0/${mediaId}`;
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${WA_ACCESS_TOKEN}` },
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error(`media_meta_error:${r.status}:${txt}`);
  }
  return r.json(); // { url, mime_type, ... }
}

async function downloadMedia(url) {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${WA_ACCESS_TOKEN}` } });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error(`media_download_error:${r.status}:${txt}`);
  }
  const ab = await r.arrayBuffer();
  return Buffer.from(ab);
}

// Regex robusto para BI-RADS (1–6)
function detectarBirads(raw = '') {
  const s = String(raw || '')
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .replace(/\s+/g, ' ')
    .toUpperCase();
  const m = s.match(/\bBI\s*[-\s]?RADS?\s*[:\-]?\s*([0-6](?:\.[0-9])?)/);
  return m ? m[1] : null;
}

// Resumen breve de PDF (2–3 líneas)
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
  } catch (e) {
    console.error('⚠️ Error resumiendo PDF:', e);
    return null;
  }
}

// ============== Webhook VERIFY (GET /whatsapp) ==============
app.get('/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === WA_VERIFY_TOKEN) {
    console.log('✅ Webhook verificado correctamente');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ============== Webhook INBOX (POST /whatsapp) ==============
app.post('/whatsapp', async (req, res) => {
  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const msg = value?.messages?.[0];

    if (!msg) return res.sendStatus(200);

    const from = msg.from; // <-- ID único del usuario (número)
    let userText = '';

    // SOPORTE PDF por usuario con RESUMEN
    if (msg.type === 'document') {
      const mime = msg.document?.mime_type || msg.document?.mime || '';
      if (mime.includes('pdf')) {
        try {
          const meta = await getMediaMeta(msg.document.id);
          const fileUrl = meta.url;
          const buf = await downloadMedia(fileUrl);
          const parsed = await pdf(buf);
          const birads = detectarBirads(parsed.text || '');
          const resumen = await resumirPDF(parsed.text || '', birads || '');

          if (resumen) {
            await sendWhatsAppText(from, `📝 Resumen del PDF:\n${resumen}`);
          }
          if (birads) {
            userText = `Se detectó BI-RADS ${birads} en el PDF. Continúa el flujo clínico y ofrece horarios disponibles conforme a las reglas.`;
          } else {
            userText = 'Leí tu PDF pero no detecté la categoría BI-RADS. Pídeme ese dato y luego ofrece horarios.';
          }
        } catch (e) {
          console.error('❌ Error procesando PDF:', e);
          userText = 'Recibí tu PDF pero tuve un problema al leerlo. ¿Puedes confirmar la categoría BI-RADS o reenviarlo?';
        }
      } else {
        userText = '📎 Recibí tu archivo. Por ahora solo puedo leer PDFs para extraer un breve resumen y BI-RADS.';
      }
    } else if (msg.type === 'text') {
      userText = msg.text?.body || '';
    } else if (msg.type === 'interactive') {
      userText =
        msg.interactive?.button_reply?.title ||
        msg.interactive?.list_reply?.title ||
        msg.interactive?.button_reply?.id ||
        msg.interactive?.list_reply?.id || '';
    } else {
      userText = 'Recibí tu mensaje. ¿Cómo quieres continuar?';
    }

    // Respuesta rápida para evitar timeout
    await sendWhatsAppText(from, '⏳ Un momento, estoy consultando…');

    // Procesar en segundo plano y mandar el resultado
    (async () => {
      try {
        const r = await fetch('http://localhost:3000/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ from, message: userText }), // <-- PASAMOS from
        });
        const data = await r.json();
        const botReply = data?.reply || 'Ups, no pude procesar tu mensaje.';
        await sendWhatsAppText(from, botReply);
      } catch (e) {
        console.error('❌ Error en procesamiento diferido:', e);
        await sendWhatsAppText(from, '⚠️ Hubo un problema consultando. Intenta otra vez.');
      }
    })();

    return res.sendStatus(200);
  } catch (e) {
    console.error('❌ Webhook error:', e);
    return res.sendStatus(500);
  }
});

// ====== Reparador y parser de acciones JSON tolerante ======
function repairJSON(raw = '') {
  let s = String(raw || '');
  s = s.replace(/```/g, '').replace(/\bjson\b/gi, '');
  s = s.replace(/[\u00A0\u200B\uFEFF]/g, ' ');
  s = s.replace(/[“”«»„‟]/g, '"').replace(/[‘’‚‛]/g, "'");
  s = s.replace(/:\s*'([^']*)'/g, ': "$1"');
  s = s.replace(/,\s*([}\]])/g, '$1');
  return s.trim();
}

function extractActionJSONBlocks(text = '') {
  const cleaned = repairJSON(text);
  const out = [];

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
          try {
            const obj = JSON.parse(candidate);
            if (obj && typeof obj === 'object' && obj.action) out.push(obj);
          } catch { /* ignore */ }
          break;
        }
      }
    }
  }

  if (out.length === 0) {
    const objs = cleaned.match(/\{[\s\S]*?\}/g) || [];
    for (const raw of objs) {
      try {
        const obj = JSON.parse(raw);
        if (obj && typeof obj === 'object' && obj.action) out.push(obj);
      } catch { /* ignore */ }
    }
  }

  return out;
}

// ====== Acciones de la IA (usa sesión del usuario) ======
async function maybeHandleAssistantAction(text, session) {
  const payloads = extractActionJSONBlocks(text);
  if (!payloads.length) return null;

  const results = [];
  const now = DateTime.now().setZone(ZONE);

  for (const payload of payloads) {
    const action = norm(payload.action);
    console.log('▶️ Acción detectada:', action);

    // ---- DISPONIBILIDAD (un día) ----
    if (action === 'consultar_disponibilidad') {
      const { tipo = 'Control presencial' } = payload.data || {};
      let { fecha } = payload.data || {};
      if (fecha) fecha = coerceFutureISODate(fecha);

      const { dur, ventanas, slots } = generarSlots(fecha, tipo, 60);
      if (!ventanas.length) {
        results.push({ ok: true, fecha, tipo, duracion_min: dur, slots: [], note: 'Día sin consulta según reglas' });
        continue;
      }
      const busy = await consultarBusy(ventanas);
      const libres = filtrarSlotsLibres(slots, busy).slice(0, 12);
      results.push({ ok: true, fecha, tipo, duracion_min: dur, slots: libres });
      continue;
    }

    // ---- DISPONIBILIDAD (rango) ----
    if (action === 'consultar_disponibilidad_rango') {
      const { tipo = 'Control presencial' } = payload.data || {};
      let { desde, dias = 14 } = payload.data || {};
      const desdeFixed = desde ? coerceFutureISODateOrToday(desde) : now.toISODate();
      if (dias > 15) dias = 15;
      const lista = await disponibilidadPorDias({ tipo, desdeISO: desdeFixed, dias });
      results.push({ ok: true, tipo, desde: desdeFixed, dias, dias_disponibles: lista });
      continue;
    }

    // ---- CREAR CITA (directo a Google Calendar) ----
    if (action === 'crear_cita') {
      const d = payload.data || {};
      const s = DateTime.fromISO(d.inicio, { zone: ZONE });
      const e = DateTime.fromISO(d.fin, { zone: ZONE });

      if (!s.isValid || !e.isValid || s >= e) {
        results.push({ ok: false, error: 'fecha_invalida', message: 'Fecha/hora inválida.' });
        session.lastSystemNote = 'El último intento falló: fecha/hora inválida.';
        continue;
      }

      const maxDay = now.plus({ days: 15 }).endOf('day');
      if (s < now) {
        const alt = await alternativasCercanas({ tipo: d.tipo, desdeISO: now.toISODate(), dias: 10, limite: 6 });
        results.push({ ok: false, error: 'fecha_pasada', message: 'La hora elegida ya pasó. Elige una fecha futura.', alternativas: alt });
        session.lastSystemNote = 'Falló por fecha pasada. Se propusieron alternativas.';
        continue;
      }
      if (s > maxDay) {
        const alt = await alternativasCercanas({ tipo: d.tipo, desdeISO: now.toISODate(), dias: 15, limite: 6 });
        results.push({ ok: false, error: 'fuera_rango', message: 'No agendamos más allá de 15 días.', alternativas: alt });
        session.lastSystemNote = 'Falló por más de 15 días. Se propusieron alternativas.';
        continue;
      }

      if (!slotDentroDeVentanas(d.inicio, d.fin, d.tipo)) {
        const alt = await alternativasCercanas({ tipo: d.tipo, desdeISO: s.toISODate(), dias: 10, limite: 6 });
        results.push({
          ok: false,
          error: 'fuera_horario',
          message: 'Ese día/horario no es válido según las reglas.',
          alternativas: alt
        });
        session.lastSystemNote = 'Falló por fuera de horario. Se propusieron alternativas.';
        continue;
      }

      // Verificar solapamiento puntual
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
        end: DateTime.fromISO(b.end, { zone: ZONE }),
      }));
      const solapa = busy.some(b => overlaps(s, e, b.start, b.end));
      if (solapa) {
        const alt = await alternativasCercanas({ tipo: d.tipo, desdeISO: s.toISODate(), dias: 10, limite: 6 });
        results.push({ ok: false, error: 'slot_ocupado', message: 'Ese horario ya está reservado. Elige otra opción.', alternativas: alt });
        session.lastSystemNote = 'Falló por slot ocupado. Se propusieron alternativas.';
        continue;
      }

      // Crear evento en Google Calendar
      try {
        const ins = await calendar.events.insert({
          calendarId: CALENDAR_ID,
          requestBody: {
            summary: `[${d.tipo}] ${d.nombre} (${d.entidad_salud})`,
            location: 'Clínica Portoazul, piso 7, consultorio 707, Barranquilla',
            description: `Cédula: ${d.cedula}\nEntidad: ${d.entidad_salud}\nTipo: ${d.tipo}`,
            start: { dateTime: s.toISO(), timeZone: ZONE },
            end:   { dateTime: e.toISO(), timeZone: ZONE },
          },
        });
        console.log('✅ Evento creado:', ins.data.id, ins.data.htmlLink || '');
        results.push({ ok: true, eventId: ins.data.id, htmlLink: ins.data.htmlLink || null });
        session.lastSystemNote = 'La última cita fue creada correctamente en el calendario.';
      } catch (err) {
        console.error('❌ Error creando evento:', err?.response?.data || err);
        results.push({ ok: false, error: 'gcal_insert_error', message: 'No se pudo crear la cita en Google Calendar.' });
        session.lastSystemNote = 'No se pudo crear la cita en Google Calendar.';
      }
      continue;
    }

    // ---- GUARDAR PACIENTE (si lo usas con Make o Sheets) ----
    if (action === 'guardar_paciente') {
      results.push({ ok: true, saved: true });
      continue;
    }
  }

  if (results.length === 1) return { handled: true, makeResponse: results[0] };
  return { handled: true, makeResponse: results };
}

// ============== /chat (lógica IA por sesión) ==============
app.post('/chat', async (req, res) => {
  const from = String(req.body.from || 'anon');     // <-- ID de sesión
  const userMsg = String(req.body.message || '').trim();

  const session = getSession(from);

  if (userMsg === '__RESET__') {
    sessions.delete(from);
    return res.json({ ok: true, reset: true });
  }

  const todayNote = `Hoy es ${DateTime.now().setZone(ZONE).toISODate()} (${ZONE}). Reglas: Martes sin consulta; virtual sólo viernes tarde; no más de 15 días (presencial) ni fechas pasadas.`;
  session.history.push({ role: 'system', content: todayNote });
  if (session.lastSystemNote) {
    session.history.push({ role: 'system', content: session.lastSystemNote });
    session.lastSystemNote = null;
  }
  session.history.push({ role: 'user', content: userMsg });
  capHistory(session);
  touchSession(session);

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: session.history,
    });

    let reply = completion.choices[0].message.content || '';
    const actionResult = await maybeHandleAssistantAction(reply, session);

    if (actionResult?.handled && actionResult.makeResponse) {
      const mr = actionResult.makeResponse;
      const many = Array.isArray(mr) ? mr : [mr];
      const errors = many.filter(x => x && x.ok === false);
      const daysResp = many.find(x => Array.isArray(x?.dias_disponibles));
      const daySlots = many.find(x => Array.isArray(x?.slots));

      if (errors.length) {
        let msg = errors.map(e => {
          let linea = `⚠️ ${e.message || 'No se pudo crear la cita.'}`;
          if (Array.isArray(e.alternativas) && e.alternativas.length) {
            const opts = e.alternativas.map((s) => {
              const h = fmtHoraHumana(s.inicio);
              const f = fmtFechaHumana(s.inicio);
              return `${f} ${h}`;
            }).join(', ');
            linea += `\nOpciones: ${opts}`;
          }
          return linea;
        }).join('\n\n');
        reply = msg;

      } else if (daySlots) {
        // 👉 NUEVO FORMATO: "13 septiembre: 8:00, 8:15, ..."
        if (!daySlots.slots.length) {
          reply = `Para ${fmtFechaHumana(daySlots.fecha)} no hay cupos válidos. ¿Quieres otra fecha?`;
        } else {
          const fechaTxt = fmtFechaHumana(daySlots.fecha);
          const horas = daySlots.slots.map(s => fmtHoraHumana(s.inicio)).join(', ');
          reply = `${fechaTxt}: ${horas}\n\n¿Te sirve alguna hora? Responde con la hora exacta (ej. "8:15").`;
        }

      } else if (daysResp) {
        // 👉 NUEVO FORMATO: por día, sin duración
        if (!daysResp.dias_disponibles.length) {
          reply = `No tengo cupos en los próximos ${daysResp.dias} días. ¿Probamos otro rango?`;
        } else {
          const lineas = daysResp.dias_disponibles.map(d => {
            const fecha = fmtFechaHumana(d.fecha);
            const horas = (d.slots || []).map(s => fmtHoraHumana(s.inicio)).join(', ');
            return `- ${fecha}: ${horas}`;
          }).join('\n');
          reply = `Horarios disponibles:\n${lineas}\n\n¿Cuál eliges?`;
        }
      }

      session.history.push({ role: 'assistant', content: reply });
      capHistory(session);
      touchSession(session);
      return res.json({ reply, makeResponse: actionResult.makeResponse });
    }

    // ===== Fallback simple si NO hubo JSON pero pidió disponibilidad (nuevo formato) =====
    const u = userMsg.toLowerCase();
    const pideDispon = /disponibilidad|horarios|agenda|qué días|que dias|que horarios|que horario/.test(u);
    if (!actionResult && pideDispon) {
      try {
        const desde = DateTime.now().setZone(ZONE).toISODate();
        const tipo = 'Control presencial';
        const dias = 14;
        const diasDisp = await disponibilidadPorDias({ tipo, desdeISO: desde, dias });
        if (!diasDisp.length) {
          reply = `No tengo cupos en los próximos ${dias} días. ¿Probamos otro rango o tipo (virtual viernes tarde)?`;
        } else {
          const lineas = diasDisp.map(d => {
            const fecha = fmtFechaHumana(d.fecha);
            const horas = (d.slots || []).map(s => fmtHoraHumana(s.inicio)).join(', ');
            return `- ${fecha}: ${horas}`;
          }).join('\n');
          reply = `Horarios disponibles:\n${lineas}\n\n¿Cuál eliges?`;
        }
      } catch (e) {
        console.error('❌ Fallback disponibilidad error:', e);
        reply = '⚠️ No pude consultar la disponibilidad ahora. Intenta de nuevo en unos minutos.';
      }
    }

    session.history.push({ role: 'assistant', content: reply });
    capHistory(session);
    touchSession(session);
    res.json({ reply, makeResponse: null });
  } catch (e) {
    console.error('OpenAI error:', e);
    res.status(500).json({ error: 'ai_error' });
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
    const libres = filtrarSlotsLibres(slots, busy).slice(0, 20);
    res.json({ ok: true, fecha, tipo, duracion_min: dur, slots: libres });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

app.post('/availability-range', async (req, res) => {
  try {
    const { tipo = 'Control presencial' } = req.body;
    let { desde, dias = 14 } = req.body;
    if (!desde) return res.status(400).json({ ok: false, error: 'falta_desde' });
    if (dias > 15) dias = 15;

    const desdeFixed = coerceFutureISODateOrToday(desde);
    const diasDisp = await disponibilidadPorDias({ tipo, desdeISO: desdeFixed, dias });
    res.json({ ok: true, tipo, desde: desdeFixed, dias, dias_disponibles: diasDisp });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// ====== ARRANQUE ======
app.listen(3000, () => {
  console.log('🚀 Servidor en http://localhost:3000');
});
