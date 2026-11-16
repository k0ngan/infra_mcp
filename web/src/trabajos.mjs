/**
 * Trabajos en segundo plano.
 *
 * ───────── Por que existe esto ─────────
 *
 * La sincronizacion tardaba 31 segundos con la peticion HTTP abierta, y con
 * adjuntos son minutos. En local aguanta. Por un tunel de Cloudflare, no:
 * Cloudflare corta el origen a los 100 segundos y devuelve **524**, que es
 * exactamente el error que aparecio al abrir la plataforma por
 * trycloudflare.com. No habia forma de arreglarlo apurando la sincronizacion:
 * el problema es tener la peticion esperando.
 *
 * Entonces el trabajo se encola y la peticion vuelve de inmediato con un
 * identificador. La pagina pregunta por el avance cada pocos segundos. Ninguna
 * peticion dura mas de un parpadeo, y da lo mismo si el trabajo demora diez
 * minutos.
 *
 * Esta es, ademas, la pieza de "orquestacion asincrona" de la unidad 4: no se
 * agrego para cumplir el temario, se agrego porque hacia falta.
 *
 * Los trabajos viven en memoria. Si el servidor se reinicia a mitad, el trabajo
 * se pierde y hay que volver a lanzarlo; no se pierde material, porque cada
 * ramo se escribe en el vault apenas termina.
 */
import crypto from "node:crypto";

const VIDA_MS = 30 * 60 * 1000; // media hora despues de terminar
const trabajos = new Map();

function limpiarViejos() {
  const ahora = Date.now();
  for (const [id, t] of trabajos) {
    if (t.terminado && ahora - t.terminado > VIDA_MS) trabajos.delete(id);
  }
}

/**
 * Lanza una tarea en segundo plano y devuelve su identificador.
 *
 * @param {string}   usuarioId  dueno del trabajo; nadie mas puede consultarlo
 * @param {string}   tipo       para mostrarlo en pantalla
 * @param {Function} tarea      recibe (reportar) para ir informando el avance
 */
export function lanzar(usuarioId, tipo, tarea) {
  limpiarViejos();

  const id = crypto.randomBytes(12).toString("hex");
  const trabajo = {
    id,
    usuarioId,
    tipo,
    estado: "corriendo",
    avance: { hechos: 0, total: null, paso: "empezando" },
    resultado: null,
    error: null,
    iniciado: Date.now(),
    terminado: null,
  };
  trabajos.set(id, trabajo);

  const reportar = avance => {
    Object.assign(trabajo.avance, avance);
  };

  // A proposito sin await: la peticion que lanza el trabajo ya respondio.
  Promise.resolve()
    .then(() => tarea(reportar))
    .then(resultado => {
      trabajo.estado = "listo";
      trabajo.resultado = resultado;
    })
    .catch(error => {
      trabajo.estado = "fallido";
      trabajo.error = error?.message || "Error desconocido";
    })
    .finally(() => {
      trabajo.terminado = Date.now();
    });

  return id;
}

/** Devuelve el trabajo si pertenece a quien pregunta. Si no, no existe. */
export function consultar(usuarioId, id) {
  const trabajo = trabajos.get(String(id || ""));
  if (!trabajo || trabajo.usuarioId !== usuarioId) {
    throw Object.assign(new Error("No existe ese trabajo."), { estado: 404 });
  }
  const { usuarioId: _, ...publico } = trabajo;
  return publico;
}

/** El trabajo en curso de un usuario, si lo hay. Evita lanzar dos a la vez. */
export function enCurso(usuarioId, tipo) {
  for (const t of trabajos.values()) {
    if (t.usuarioId === usuarioId && t.tipo === tipo && t.estado === "corriendo") return t.id;
  }
  return null;
}
