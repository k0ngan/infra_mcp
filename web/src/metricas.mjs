/**
 * Adopcion: quien termino el recorrido, cuanto usa la plataforma, si vuelve y
 * si respondio la encuesta.
 *
 * ───────── Por que existe esto ─────────
 *
 * Una plataforma que nadie usa no se distingue de una que funciona, si lo unico
 * que se mira es que las pruebas pasen. Las cuatro preguntas que hay que poder
 * contestar son concretas: **si la termino**, **cuanto la usa**, **si sigue
 * entrando** y **si respondio la encuesta**. Esto las contesta con datos, no con
 * impresiones.
 *
 * ───────── Dos reglas que no se negocian ─────────
 *
 * **Medir no puede romper la plataforma.** `registrar()` nunca lanza. Si el
 * disco esta lleno o la carpeta no existe, se pierde el evento y la peticion del
 * usuario sigue su curso. Es preferible un hueco en la medicion a una guia que
 * no se genero porque fallo una estadistica.
 *
 * **Esto son datos personales de companeros de curso.** Quien entro, cuando y
 * cuantas veces. Por eso la carpeta vive fuera del repositorio igual que
 * `secretos/` y `vaults/`, el resumen es solo para administradores, y la
 * encuesta de cada quien solo la ve esa persona y quien administra. No se
 * registra nunca el contenido: ni el tema de una guia, ni lo que se pregunta en
 * el chat, ni que ramo se sincronizo. Solo que la accion ocurrio.
 *
 * ───────── Que se guarda ─────────
 *
 * `eventos.jsonl`, una linea por evento, que se agrega y no se reescribe: si el
 * proceso muere a mitad de una escritura se pierde a lo sumo la ultima linea, y
 * las anteriores siguen siendo legibles. Es el formato mas barato de append y el
 * mas facil de leer con cualquier cosa despues.
 *
 * `encuestas.json`, un objeto por usuario, que si se reescribe entero: son pocas
 * y se responden una vez.
 */
import fs from "node:fs";
import path from "node:path";

import { RAIZ } from "./usuarios.mjs";

/** Los eventos que se registran. Mas no hacen falta para las cuatro preguntas. */
export const EVENTOS = {
  SESION: "sesion.abierta",
  ALTA: "usuario.creado",
  COOKIE: "cookie.guardada",
  SINCRONIZACION: "sincronizacion.lanzada",
  GUIA: "guia.creada",
  CHAT: "chat.mensaje",
  ENCUESTA: "encuesta.respondida",
};

/**
 * La encuesta. Cinco preguntas y ninguna obligatoria salvo la primera: una
 * encuesta larga se responde menos, y lo que importa es saber si la herramienta
 * sirvio para estudiar.
 */
export const PREGUNTAS = [
  {
    id: "sirvio",
    texto: "¿Te sirvió para estudiar?",
    tipo: "escala",
    min: 1,
    max: 5,
    ayuda: "1 = no me sirvió · 5 = estudié con esto",
    obligatoria: true,
  },
  {
    id: "guia_fiel",
    texto: "Las guías, ¿salieron del material de tu ramo o se notaban inventadas?",
    tipo: "opcion",
    opciones: ["Salieron de mi material", "Mezcladas", "Se notaban inventadas", "No alcancé a generar una"],
  },
  {
    id: "seguiria",
    texto: "¿La seguirías usando el próximo semestre?",
    tipo: "opcion",
    opciones: ["Sí", "Tal vez", "No"],
  },
  {
    id: "costo",
    texto: "¿Qué fue lo más molesto de usarla?",
    tipo: "texto",
    ayuda: "Lo que te hizo perder tiempo o casi te hace abandonar.",
  },
  {
    id: "falta",
    texto: "¿Qué le falta?",
    tipo: "texto",
  },
];

function carpeta() {
  return path.resolve(RAIZ, process.env.PLATAFORMA_METRICAS || "metricas");
}

const archivoEventos = () => path.join(carpeta(), "eventos.jsonl");
const archivoEncuestas = () => path.join(carpeta(), "encuestas.json");

/**
 * Deja constancia de que algo paso. **Nunca lanza.**
 *
 * Se escribe de forma sincrona a proposito: son decenas de bytes y un `appendFile`
 * asincrono sin await dejaria escrituras compitiendo entre si por el mismo
 * descriptor, que es justo como se corrompe un archivo de lineas.
 *
 * @param {string} usuarioId  de quien es la accion
 * @param {string} evento     una de las constantes de EVENTOS
 * @param {object} [datos]    nada que identifique contenido: solo contadores
 */
export function registrar(usuarioId, evento, datos = {}) {
  if (!usuarioId || !evento) return;
  try {
    fs.mkdirSync(carpeta(), { recursive: true });
    const linea = JSON.stringify({
      t: new Date().toISOString(),
      u: String(usuarioId),
      e: String(evento),
      ...(Object.keys(datos).length ? { d: datos } : {}),
    });
    fs.appendFileSync(archivoEventos(), linea + "\n", "utf8");
  } catch {
    // A proposito en silencio: perder una medicion no justifica tumbar la
    // peticion de alguien que esta tratando de estudiar.
  }
}

/** Lee el registro entero. Las lineas corruptas se saltan en vez de reventar. */
export function leerEventos() {
  let crudo;
  try {
    crudo = fs.readFileSync(archivoEventos(), "utf8");
  } catch {
    return [];
  }
  const eventos = [];
  for (const linea of crudo.split("\n")) {
    if (!linea.trim()) continue;
    try {
      const e = JSON.parse(linea);
      if (e && e.t && e.u && e.e) eventos.push(e);
    } catch {
      // Una linea a medias (un corte de luz a mitad de escritura) no invalida
      // las 500 anteriores.
    }
  }
  return eventos;
}

function leerEncuestas() {
  try {
    const datos = JSON.parse(fs.readFileSync(archivoEncuestas(), "utf8"));
    return datos && typeof datos === "object" ? datos : {};
  } catch {
    return {};
  }
}

/** La encuesta de una persona, o null si no la ha respondido. */
export function encuestaDe(usuarioId) {
  return leerEncuestas()[String(usuarioId)] || null;
}

/**
 * Guarda la encuesta. Se puede responder de nuevo: la ultima reemplaza a la
 * anterior y se conserva cuando se respondio la primera vez.
 */
export function guardarEncuesta(usuarioId, respuestas) {
  const id = String(usuarioId);
  const limpias = {};
  for (const pregunta of PREGUNTAS) {
    const valor = respuestas?.[pregunta.id];
    if (valor === undefined || valor === null || valor === "") continue;
    if (pregunta.tipo === "escala") {
      const n = Number(valor);
      if (!Number.isFinite(n) || n < pregunta.min || n > pregunta.max) {
        throw Object.assign(
          new Error(`"${pregunta.texto}" espera un numero entre ${pregunta.min} y ${pregunta.max}.`),
          { estado: 400 },
        );
      }
      limpias[pregunta.id] = n;
      continue;
    }
    if (pregunta.tipo === "opcion" && !pregunta.opciones.includes(String(valor))) {
      throw Object.assign(new Error(`"${valor}" no es una opcion de "${pregunta.texto}".`), {
        estado: 400,
      });
    }
    // El texto libre se recorta: es un campo de comentario, no un deposito.
    limpias[pregunta.id] = String(valor).slice(0, 2000);
  }

  const obligatorias = PREGUNTAS.filter(p => p.obligatoria).map(p => p.id);
  for (const id of obligatorias) {
    if (limpias[id] === undefined) {
      const pregunta = PREGUNTAS.find(p => p.id === id);
      throw Object.assign(new Error(`Falta responder: "${pregunta.texto}".`), { estado: 400 });
    }
  }

  const todas = leerEncuestas();
  const previa = todas[id];
  todas[id] = {
    respondida: previa?.respondida || new Date().toISOString(),
    actualizada: new Date().toISOString(),
    respuestas: limpias,
  };

  fs.mkdirSync(carpeta(), { recursive: true });
  // Escritura atomica: un archivo temporal y un rename. Si el proceso muere a
  // mitad, el archivo bueno sigue siendo el de antes y no uno truncado.
  const tmp = archivoEncuestas() + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(todas, null, 2), "utf8");
  fs.renameSync(tmp, archivoEncuestas());

  registrar(id, EVENTOS.ENCUESTA);
  return todas[id];
}

const DIA_MS = 24 * 60 * 60 * 1000;
const dia = iso => String(iso).slice(0, 10);

/**
 * El resumen de una persona: las cuatro preguntas, contestadas.
 *
 * "Termino" no es una opinion: el recorrido completo de la plataforma es pegar
 * la cookie, sincronizar un ramo y generar una guia. Quien hizo las tres cosas
 * llego hasta el final; quien no, se quedo en algun punto, y el resumen dice en
 * cual. Por eso se informan los tres pasos y no solo el booleano.
 */
function resumirUsuario(eventos, encuesta, ahora) {
  const porTipo = {};
  const dias = new Set();
  for (const e of eventos) {
    porTipo[e.e] = (porTipo[e.e] || 0) + 1;
    dias.add(dia(e.t));
  }

  const tiempos = eventos.map(e => Date.parse(e.t)).filter(Number.isFinite).sort((a, b) => a - b);
  const primera = tiempos[0] ?? null;
  const ultima = tiempos[tiempos.length - 1] ?? null;

  const pasos = {
    cookie: (porTipo[EVENTOS.COOKIE] || 0) > 0,
    sincronizacion: (porTipo[EVENTOS.SINCRONIZACION] || 0) > 0,
    guia: (porTipo[EVENTOS.GUIA] || 0) > 0,
  };

  const diasDesdeUltima = ultima === null ? null : Math.floor((ahora - ultima) / DIA_MS);

  return {
    // 1. ¿Lo termino?
    termino: pasos.cookie && pasos.sincronizacion && pasos.guia,
    pasos,

    // 2. ¿Cuanto lo usa?
    uso: {
      eventos: eventos.length,
      sesiones: porTipo[EVENTOS.SESION] || 0,
      sincronizaciones: porTipo[EVENTOS.SINCRONIZACION] || 0,
      guias: porTipo[EVENTOS.GUIA] || 0,
      mensajes_chat: porTipo[EVENTOS.CHAT] || 0,
    },

    // 3. ¿Sigue entrando?
    actividad: {
      primera: primera === null ? null : new Date(primera).toISOString(),
      ultima: ultima === null ? null : new Date(ultima).toISOString(),
      dias_activos: dias.size,
      dias_desde_ultima: diasDesdeUltima,
      // "Vuelve" exige dos dias distintos: entrar diez veces en una tarde y no
      // aparecer nunca mas no es retencion, es una prueba.
      vuelve: dias.size >= 2,
      activo_ultimos_7_dias: diasDesdeUltima !== null && diasDesdeUltima <= 7,
    },

    // 4. ¿Respondio la encuesta?
    encuesta: {
      respondida: Boolean(encuesta),
      cuando: encuesta?.respondida || null,
      respuestas: encuesta?.respuestas || null,
    },
  };
}

/**
 * El cuadro completo, una fila por usuario registrado, mas los totales.
 *
 * Recibe los usuarios porque las metricas no conocen la configuracion: quien
 * nunca hizo nada tiene que aparecer igual, con todo en cero. Si solo se
 * recorrieran los eventos, los que se registraron y no volvieron —que son
 * justo los que hay que mirar— desaparecerian del informe.
 */
export function resumen(usuarios, ahora = Date.now()) {
  const eventos = leerEventos();
  const encuestas = leerEncuestas();

  const porUsuario = new Map();
  for (const e of eventos) {
    if (!porUsuario.has(e.u)) porUsuario.set(e.u, []);
    porUsuario.get(e.u).push(e);
  }

  const filas = usuarios.map(u => ({
    id: u.id,
    nombre: u.nombre,
    correo: u.correo,
    rol: u.rol,
    ...resumirUsuario(porUsuario.get(u.id) || [], encuestas[u.id] || null, ahora),
  }));

  const total = filas.length;
  const cuenta = pred => filas.filter(pred).length;
  const pct = n => (total === 0 ? 0 : Math.round((n / total) * 1000) / 10);

  const terminaron = cuenta(f => f.termino);
  const vuelven = cuenta(f => f.actividad.vuelve);
  const activos = cuenta(f => f.actividad.activo_ultimos_7_dias);
  const respondieron = cuenta(f => f.encuesta.respondida);

  const notas = filas
    .map(f => f.encuesta.respuestas?.sirvio)
    .filter(n => typeof n === "number");

  return {
    generado: new Date(ahora).toISOString(),
    usuarios: total,
    totales: {
      terminaron,
      terminaron_pct: pct(terminaron),
      vuelven,
      vuelven_pct: pct(vuelven),
      activos_ultimos_7_dias: activos,
      activos_pct: pct(activos),
      respondieron_encuesta: respondieron,
      respondieron_pct: pct(respondieron),
      guias_generadas: filas.reduce((s, f) => s + f.uso.guias, 0),
      eventos_registrados: eventos.length,
      promedio_sirvio:
        notas.length === 0
          ? null
          : Math.round((notas.reduce((s, n) => s + n, 0) / notas.length) * 10) / 10,
    },
    filas,
  };
}
