/**
 * Traer los ramos de Canvas al vault, sin que un tropiezo bote todo.
 *
 * La primera version llamaba `canvas_sync_all_courses` y listo. El problema
 * aparecio en la practica: Canvas esta detras de Cloudflare y en una
 * sincronizacion completa son cientos de peticiones, asi que tarde o temprano
 * una devuelve **524** (tiempo agotado) o **429** (demasiadas peticiones). El
 * MCP lanza una excepcion ante cualquier respuesta que no sea 200, y esa
 * excepcion se llevaba por delante la sincronizacion entera: siete ramos
 * perdidos porque el quinto tardo de mas.
 *
 * Aca se sincroniza **ramo por ramo**:
 *
 *   - Un fallo afecta solo a ese ramo; los demas siguen.
 *   - Los errores pasajeros (429 y 5xx) se reintentan con una espera que crece.
 *   - Al final se informa que entro y que quedo fuera, con el motivo.
 *
 * Una sincronizacion a medias que dice cuales ramos faltan es util. Una que
 * falla entera y no dice nada, no.
 */
import { llamar } from "./canvas.mjs";

const INTENTOS = 3;
const ESPERAS_MS = [2_000, 6_000];

/** 429 y 5xx son del momento; 401, 403 y 404 no se arreglan reintentando. */
function esPasajero(mensaje) {
  return /\b(429|500|502|503|504|520|521|522|523|524)\b/.test(String(mensaje));
}

const dormir = ms => new Promise(listo => setTimeout(listo, ms));

async function conReintentos(tarea, descripcion) {
  let ultimo;
  for (let intento = 0; intento < INTENTOS; intento += 1) {
    try {
      return await tarea();
    } catch (error) {
      ultimo = error;
      if (!esPasajero(error.message) || intento === INTENTOS - 1) break;
      await dormir(ESPERAS_MS[intento] ?? 6_000);
    }
  }
  const error = new Error(`${descripcion}: ${ultimo.message}`);
  error.causaOriginal = ultimo;
  throw error;
}

/**
 * Sincroniza los ramos del semestre, o uno solo si se indica `cursoId`.
 *
 * @returns {{cursos: Array, fallidos: Array, total: number}}
 */
export async function sincronizarCursos(usuario, { descargarArchivos = false, cursoId = null, reportar = () => {} } = {}) {
  const opciones = {
    download_files: descargarArchivos === true,
    include_announcements: true,
  };

  // La lista de cursos tambien puede fallar, y sin ella no hay nada que hacer:
  // ese error si sube.
  const indice = cursoId
    ? { cursos: [{ id: cursoId, name: `curso ${cursoId}` }] }
    : await conReintentos(
        () => llamar(usuario, "canvas_list_courses", {}),
        "No se pudo listar tus cursos",
      );

  const lista = indice.cursos || indice.courses || [];
  const cursos = [];
  const fallidos = [];

  reportar({ total: lista.length, hechos: 0, paso: "listando ramos" });

  for (const curso of lista) {
    const id = curso.id ?? curso.course_id;
    if (!Number.isInteger(id)) continue;
    reportar({ paso: curso.name || `curso ${id}` });
    try {
      const r = await conReintentos(
        () => llamar(usuario, "canvas_sync_course", { ...opciones, course_id: id }),
        `No se pudo sincronizar "${curso.name || id}"`,
      );
      cursos.push({
        course_id: id,
        name: curso.name || r?.curso?.name || String(id),
        descargas: r?.descargas ?? r?.curso?.descargas ?? 0,
      });
    } catch (error) {
      fallidos.push({ course_id: id, name: curso.name || String(id), motivo: error.message });
    }
    reportar({ hechos: cursos.length + fallidos.length });
  }

  return { cursos, fallidos, total: lista.length };
}
