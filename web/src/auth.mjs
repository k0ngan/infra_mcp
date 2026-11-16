/**
 * Autenticacion, al modo del proyecto ODS: correo y contrasena, sesion de
 * servidor y roles.
 *
 * Dos diferencias con ODS, y las dos son a proposito:
 *
 *   - ODS usa bcrypt por passlib. Aca el proyecto no tiene dependencias, asi
 *     que la contrasena se deriva con **scrypt**, que viene en el nucleo de
 *     Node y es una funcion de derivacion dura en memoria, igual de defendible
 *     que bcrypt para esto. Lo que NO se hace es inventar un hash propio ni
 *     usar sha256 pelado.
 *   - La sesion es un token opaco al azar guardado en memoria del servidor, no
 *     una cookie firmada con el usuario adentro. Asi cerrar sesion la invalida
 *     de verdad, que es como se comporta la sesion de servidor de ODS.
 *
 * La contrasena nunca se guarda en claro, nunca se devuelve por la API y nunca
 * se escribe en el log.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SCRYPT = { N: 16_384, r: 8, p: 1, bytes: 64 };
const DURACION_SESION_MS = 12 * 60 * 60 * 1000; // 12 horas
const NOMBRE_COOKIE = "sesion";

export const ROL_ADMIN = "admin";
export const ROL_ESTUDIANTE = "estudiante";
export const ROLES = new Set([ROL_ADMIN, ROL_ESTUDIANTE]);

// Pimienta opcional: si se declara, se mezcla con la contrasena antes de
// derivar. No se inventa una ni se guarda en el repositorio; sin ella el
// esquema sigue siendo correcto, solo pierde esa capa extra.
const PIMIENTA = process.env.PLATAFORMA_SECRETO || "";

/**
 * Las sesiones se guardan en disco, fuera del repositorio.
 *
 * Al principio vivian solo en memoria, y la primera vez que reinicie el
 * servidor pasó lo previsible: la pagina seguia mostrando al usuario adentro,
 * pero la siguiente peticion respondia "Inicia sesion" sin explicacion. Un
 * reinicio no deberia echar a nadie.
 *
 * El archivo guarda tokens, asi que va junto a las cookies de Canvas y con los
 * mismos permisos: nunca en el repositorio.
 */
const ARCHIVO_SESIONES = process.env.PLATAFORMA_SESIONES || path.join(
  process.env.LOCALAPPDATA ||
    path.join(process.env.USERPROFILE || process.env.HOME || process.cwd(), "AppData", "Local"),
  "plataforma-estudio",
  "sesiones.json",
);

const sesiones = new Map();

function cargarSesiones() {
  try {
    if (!fs.existsSync(ARCHIVO_SESIONES)) return;
    const guardadas = JSON.parse(fs.readFileSync(ARCHIVO_SESIONES, "utf8"));
    const ahora = Date.now();
    for (const [token, sesion] of Object.entries(guardadas)) {
      if (sesion?.expira > ahora) sesiones.set(token, sesion);
    }
  } catch {
    // Un archivo corrupto no puede impedir que la plataforma arranque: se
    // ignora y todos vuelven a entrar.
  }
}

function guardarSesiones() {
  try {
    fs.mkdirSync(path.dirname(ARCHIVO_SESIONES), { recursive: true });
    fs.writeFileSync(
      ARCHIVO_SESIONES,
      JSON.stringify(Object.fromEntries(sesiones)),
      { encoding: "utf8", mode: 0o600 },
    );
  } catch {
    // Si no se pudo escribir, la sesion sigue valiendo en memoria. Se pierde al
    // reiniciar, que es como se comportaba antes: degrada, no rompe.
  }
}

cargarSesiones();

function derivar(contrasena, sal) {
  return new Promise((resolver, rechazar) => {
    crypto.scrypt(
      `${PIMIENTA}:${contrasena}`,
      sal,
      SCRYPT.bytes,
      { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p },
      (error, clave) => (error ? rechazar(error) : resolver(clave)),
    );
  });
}

/** Devuelve el registro completo a guardar: scrypt$N$r$p$sal$clave */
export async function hashearContrasena(contrasena) {
  if (typeof contrasena !== "string" || contrasena.length < 8) {
    throw Object.assign(new Error("La contrasena necesita al menos 8 caracteres."), { estado: 400 });
  }
  const sal = crypto.randomBytes(16);
  const clave = await derivar(contrasena, sal);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${sal.toString("hex")}$${clave.toString("hex")}`;
}

/** Comparacion en tiempo constante; nunca revela si fallo la sal o la clave. */
export async function verificarContrasena(contrasena, registro) {
  if (typeof contrasena !== "string" || typeof registro !== "string") return false;

  const partes = registro.split("$");
  if (partes.length !== 6 || partes[0] !== "scrypt") return false;

  const [, n, r, p, salHex, claveHex] = partes;
  let candidata;
  try {
    candidata = await new Promise((resolver, rechazar) => {
      crypto.scrypt(
        `${PIMIENTA}:${contrasena}`,
        Buffer.from(salHex, "hex"),
        Buffer.from(claveHex, "hex").length,
        { N: Number(n), r: Number(r), p: Number(p) },
        (error, clave) => (error ? rechazar(error) : resolver(clave)),
      );
    });
  } catch {
    return false;
  }

  const esperada = Buffer.from(claveHex, "hex");
  if (candidata.length !== esperada.length) return false;
  return crypto.timingSafeEqual(candidata, esperada);
}

/* ───────── Sesiones ───────── */

export function abrirSesion(usuarioId) {
  const token = crypto.randomBytes(32).toString("hex");
  sesiones.set(token, { usuarioId, expira: Date.now() + DURACION_SESION_MS });
  guardarSesiones();
  return token;
}

export function leerSesion(token) {
  if (!token) return null;
  const sesion = sesiones.get(token);
  if (!sesion) return null;
  if (sesion.expira < Date.now()) {
    sesiones.delete(token);
    guardarSesiones();
    return null;
  }
  return sesion;
}

export function cerrarSesion(token) {
  const habia = sesiones.delete(token);
  if (habia) guardarSesiones();
  return habia;
}

/** Cierra todas las sesiones de un usuario; se usa al quitarlo o cambiarle la clave. */
export function cerrarSesionesDe(usuarioId) {
  let alguna = false;
  for (const [token, sesion] of sesiones) {
    if (sesion.usuarioId === usuarioId) {
      sesiones.delete(token);
      alguna = true;
    }
  }
  if (alguna) guardarSesiones();
}

/* ───────── Cookie de sesion ───────── */

export function leerCookieDeSesion(cabecera) {
  if (!cabecera) return null;
  for (const trozo of cabecera.split(";")) {
    const [nombre, ...resto] = trozo.trim().split("=");
    if (nombre === NOMBRE_COOKIE) return decodeURIComponent(resto.join("="));
  }
  return null;
}

/**
 * HttpOnly para que el JavaScript de la pagina no pueda leerla, y SameSite=Strict
 * para que no viaje desde otro sitio. Sin `Secure` porque la plataforma corre en
 * http://127.0.0.1; si alguna vez se publica por https, hay que agregarlo.
 */
export function cabeceraDeCookie(token) {
  const segundos = Math.floor(DURACION_SESION_MS / 1000);
  return `${NOMBRE_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${segundos}`;
}

export function cabeceraDeCookieVacia() {
  return `${NOMBRE_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}
