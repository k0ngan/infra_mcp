/**
 * Deja el disco listo para `docker compose up`.
 *
 * Son tres carpetas y un archivo, y existe por un detalle feo de Docker: un
 * bind mount cuyo origen no existe se crea como CARPETA. Si `usuarios.json` no
 * esta, `docker compose up` deja una carpeta llamada `usuarios.json` y el
 * servidor muere con un EISDIR que no le dice nada a nadie.
 *
 *   node scripts/preparar.mjs     (o: npm run preparar)
 *
 * No toca nada de lo que ya existe.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const PLANTILLA = {
  _nota: "Lo escribe la plataforma sola cuando creas el primer administrador en la pantalla de acceso. Las rutas relativas se entienden desde la raiz del proyecto, asi que sirven igual en Windows y dentro del contenedor.",
  canvas_base_url: "https://utem.instructure.com",
  usuarios: {},
};

const hecho = [];

for (const carpeta of ["vaults", "secretos"]) {
  const destino = path.join(RAIZ, carpeta);
  if (!fs.existsSync(destino)) {
    fs.mkdirSync(destino, { recursive: true });
    hecho.push(`carpeta ${carpeta}/`);
  }
}

const usuarios = path.join(RAIZ, "usuarios.json");
if (!fs.existsSync(usuarios)) {
  fs.writeFileSync(usuarios, `${JSON.stringify(PLANTILLA, null, 2)}\n`, "utf8");
  hecho.push("usuarios.json vacio (el primer administrador se crea en la pantalla de acceso)");
} else if (fs.statSync(usuarios).isDirectory()) {
  console.error(
    "usuarios.json es una CARPETA. La dejo ahi por si tiene algo adentro, pero hay que borrarla:\n" +
    "  docker compose down\n" +
    `  rmdir "${usuarios}"\n` +
    "  npm run preparar",
  );
  process.exit(1);
}

console.log(hecho.length ? `Listo: ${hecho.join(", ")}.` : "Ya estaba todo listo.");
