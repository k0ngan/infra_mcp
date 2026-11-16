/**
 * La cookie de sesion de Canvas, una por usuario.
 *
 * Este camino no pasa por el modelo ni por el agente, a proposito. Pegar una
 * cookie es una operacion de dos lineas: guardarla donde el MCP la busca y
 * probar si sirve. Meter un LLM en el medio solo agregaria una forma nueva de
 * equivocarse con la credencial de otra persona.
 *
 * Reglas que se cumplen aqui y conviene que sigan asi:
 *
 *   - El valor de la cookie NUNCA se devuelve por la API, ni se escribe en el
 *     log, ni se guarda en el vault. Solo se informa si existe, cuanto pesa y
 *     cuando se guardo.
 *   - El archivo vive fuera del repositorio. Por defecto en
 *     %LOCALAPPDATA%\plataforma-estudio\<usuario>\canvas_session.
 *   - Al reemplazar una cookie, la anterior se conserva al lado como
 *     `.anterior`: pegar algo mal no puede dejarte sin la sesion que si servia.
 *
 * El MCP relee el archivo en cada peticion (`cookieHeader()` en su canvas.mjs),
 * asi que no hay que reiniciar nada: se guarda y la siguiente llamada ya la usa.
 */
import fs from "node:fs";
import path from "node:path";

import { llamar } from "./canvas.mjs";

// El mismo tope que aplica el MCP (MAX_COOKIE_BYTES en su config.mjs). Si se
// pasa, el error conviene darlo aca y no despues de haber escrito el archivo.
const MAXIMO_BYTES = 16_384;

function fallo(mensaje, estado = 400) {
  return Object.assign(new Error(mensaje), { estado });
}

/** Donde esta la cookie de un usuario, sin revelar su contenido. */
export function estadoDeArchivo(usuario) {
  const ruta = usuario.config.cookieFile;
  if (!fs.existsSync(ruta)) {
    return { ruta, existe: false, bytes: 0, modificado: null };
  }
  const info = fs.statSync(ruta);
  return {
    ruta,
    existe: true,
    bytes: info.size,
    modificado: info.mtime.toISOString(),
  };
}

/** Estado del archivo mas una prueba real contra Canvas. */
export async function estado(usuario) {
  const archivo = estadoDeArchivo(usuario);
  const respuesta = { ...archivo, sesion: { viva: false, mensaje: null } };
  if (!archivo.existe) {
    respuesta.sesion.mensaje = "Todavia no has guardado una cookie para este usuario.";
    return respuesta;
  }
  try {
    const detalle = await llamar(usuario, "canvas_test_connection");
    respuesta.sesion = { viva: true, mensaje: null, detalle };
  } catch (error) {
    respuesta.sesion = { viva: false, mensaje: error.message, vencida: Boolean(error.sesionVencida) };
  }
  return respuesta;
}

/**
 * Guarda la cookie de un usuario y prueba si sirve.
 *
 * Devuelve el resultado de la prueba tal cual: si Canvas la rechaza, lo dice.
 * No se inventa un "guardado con exito" cuando la sesion sigue muerta.
 */
export async function guardar(usuario, valorCrudo) {
  if (typeof valorCrudo !== "string") throw fallo('Falta "cookie" en el cuerpo.');

  // Se aceptan saltos de linea porque pegar desde las herramientas del navegador
  // los arrastra, pero el header Cookie es de una sola linea.
  const valor = valorCrudo.replace(/[\r\n]+/g, " ").trim();
  if (!valor) throw fallo("La cookie viene vacia.");

  const bytes = Buffer.byteLength(valor, "utf8");
  if (bytes > MAXIMO_BYTES) {
    throw fallo(`La cookie pesa ${bytes} bytes y el maximo es ${MAXIMO_BYTES}.`);
  }

  const ruta = usuario.config.cookieFile;
  fs.mkdirSync(path.dirname(ruta), { recursive: true });

  // La anterior se conserva: si lo pegado no sirve, no se perdio la sesion que si.
  let anteriorGuardada = false;
  if (fs.existsSync(ruta)) {
    fs.copyFileSync(ruta, `${ruta}.anterior`);
    anteriorGuardada = true;
  }

  // mode 0o600 no significa gran cosa en Windows, pero es lo correcto en el resto
  // y no cuesta nada declararlo.
  fs.writeFileSync(ruta, valor, { encoding: "utf8", mode: 0o600 });

  const resultado = await estado(usuario);
  return {
    ...resultado,
    guardada: true,
    anterior_conservada: anteriorGuardada ? `${ruta}.anterior` : null,
    aviso: resultado.sesion.viva
      ? null
      : "Se guardo, pero Canvas sigue rechazando la sesion. Revisa que hayas copiado el valor completo del header Cookie.",
  };
}
