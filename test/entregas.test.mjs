/**
 * Entregar es lo unico irreversible de esta plataforma.
 *
 * Asi que lo que se prueba aca no es que funcione —eso se ve usandolo— sino las
 * cuatro cosas que no pueden pasar nunca:
 *
 *   1. que se entregue sin que una persona haya confirmado;
 *   2. que se entregue un archivo que no esta en la carpeta de esta persona;
 *   3. que un nombre con "../" saque el archivo de esa carpeta;
 *   4. que se cuele una extension que Canvas no acepta por esta via.
 *
 * Sin red y sin Canvas: el handler del MCP es de mentira y la carpeta de
 * entregas se redirige con PLATAFORMA_ENTREGAS a una temporal.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const RAIZ = fs.mkdtempSync(path.join(os.tmpdir(), "entregas-prueba-"));
process.env.PLATAFORMA_ENTREGAS = RAIZ;

const { archivosListos, entregar, guardarArchivo, nombreSeguro, olvidarArchivo, revisar } =
  await import("../web/src/entregas.mjs");
const { carpetaDeEntregas } = await import("../web/src/usuarios.mjs");

after(() => fs.rmSync(RAIZ, { recursive: true, force: true }));

/** Un MCP de mentira que apunta lo que le pidieron. */
function usuarioFalso(id = "pepe") {
  const pedidas = [];
  const argumentos = [];
  return {
    id,
    pedidas,
    argumentos,
    describir: () => ({ subida_extensiones: [".pdf", ".sql", ".pbix"] }),
    handler: async mensaje => {
      pedidas.push(mensaje.params.name);
      argumentos.push(mensaje.params.arguments || {});
      return { result: { structuredContent: { ok: true, tarea: "Tarea 3", vence: "2026-12-01" } } };
    },
  };
}

const PDF = Buffer.from("%PDF-1.4 contenido de prueba").toString("base64");

/* ───────── Nombres que no pueden escapar ───────── */

test("un nombre con ruta se queda en el nombre, no en la ruta", () => {
  assert.equal(nombreSeguro("../../.ollama/models/robado.pdf"), "robado.pdf");
  assert.equal(nombreSeguro("C:\\Windows\\System32\\config.pdf"), "config.pdf");
  assert.equal(nombreSeguro("subcarpeta/tarea.pdf"), "tarea.pdf");
  assert.equal(nombreSeguro("....//tarea.pdf"), "tarea.pdf");
});

test("se conservan los acentos, que es como la gente nombra sus archivos", () => {
  assert.equal(nombreSeguro("Informe Métodos Numéricos.pdf"), "Informe Métodos Numéricos.pdf");
});

test("un nombre que no deja nada usable falla en vez de inventar uno", () => {
  assert.throws(() => nombreSeguro(""), /nombre usable/);
  assert.throws(() => nombreSeguro("..."), /nombre usable/);
});

/* ───────── Subir ───────── */

test("subir deja el archivo en la carpeta de ESE usuario y en ninguna otra", () => {
  const pepe = usuarioFalso("pepe");
  const ana = usuarioFalso("ana");

  const r = guardarArchivo(pepe, { nombre: "tarea1.pdf", contenido_base64: PDF });
  assert.equal(r.archivo, "tarea1.pdf");
  assert.ok(r.bytes > 0);

  assert.ok(fs.existsSync(path.join(carpetaDeEntregas("pepe"), "tarea1.pdf")));
  assert.deepEqual(archivosListos(ana), [], "el archivo de pepe no aparece en la lista de ana");
});

test("un nombre con ../ no escribe fuera de la carpeta del usuario", () => {
  const pepe = usuarioFalso("pepe");
  guardarArchivo(pepe, { nombre: "../../escapado.pdf", contenido_base64: PDF });

  assert.ok(fs.existsSync(path.join(carpetaDeEntregas("pepe"), "escapado.pdf")));
  assert.ok(!fs.existsSync(path.join(RAIZ, "escapado.pdf")), "no salio de la carpeta");
  assert.ok(!fs.existsSync(path.join(RAIZ, "..", "escapado.pdf")));
});

test("una extension que Canvas no acepta se rechaza nombrando las que si", () => {
  const pepe = usuarioFalso("pepe");
  assert.throws(
    () => guardarArchivo(pepe, { nombre: "informe.docx", contenido_base64: PDF }),
    error => {
      assert.equal(error.estado, 415);
      assert.match(error.message, /\.pdf/);
      assert.match(error.message, /a mano en Canvas/);
      return true;
    },
  );
  assert.ok(!fs.existsSync(path.join(carpetaDeEntregas("pepe"), "informe.docx")));
});

test("un archivo sin extension o vacio no se guarda", () => {
  const pepe = usuarioFalso("pepe");
  assert.throws(() => guardarArchivo(pepe, { nombre: "informe", contenido_base64: PDF }), /extension/);
  assert.throws(() => guardarArchivo(pepe, { nombre: "x.pdf", contenido_base64: "" }), /vacio/);
});

test("borrar lo subido es reversible y no toca lo de otros", () => {
  const pepe = usuarioFalso("pepe");
  guardarArchivo(pepe, { nombre: "borrable.pdf", contenido_base64: PDF });
  assert.ok(archivosListos(pepe).some(a => a.archivo === "borrable.pdf"));

  olvidarArchivo(pepe, "borrable.pdf");
  assert.ok(!archivosListos(pepe).some(a => a.archivo === "borrable.pdf"));
  assert.throws(() => olvidarArchivo(pepe, "borrable.pdf"), /no esta subido/);
});

/* ───────── Los dos pasos ───────── */

test("revisar no manda confirm: el MCP solo valida y devuelve el plan", async () => {
  const pepe = usuarioFalso("pepe");
  guardarArchivo(pepe, { nombre: "tarea1.pdf", contenido_base64: PDF });

  const r = await revisar(pepe, { course_id: 31151, assignment_id: 99, archivo: "tarea1.pdf" });

  assert.equal(r.confirmado, false);
  assert.equal(r.paso, "revision");
  assert.deepEqual(pepe.pedidas, ["canvas_submit_assignment"]);
  assert.ok(!("confirm" in pepe.argumentos[0]), "el paso 1 NO puede mandar confirm");
  // Y la ruta que se le pasa al MCP es la de la carpeta de este usuario.
  assert.ok(pepe.argumentos[0].file_path.startsWith(carpetaDeEntregas("pepe")));
});

test("entregar sin confirmacion de la persona no llama al MCP", async () => {
  const pepe = usuarioFalso("pepe");
  guardarArchivo(pepe, { nombre: "tarea1.pdf", contenido_base64: PDF });

  await assert.rejects(
    () => entregar(pepe, { course_id: 31151, assignment_id: 99, archivo: "tarea1.pdf" }),
    error => {
      assert.equal(error.estado, 428);
      assert.match(error.message, /confirmacion/i);
      return true;
    },
  );
  assert.deepEqual(pepe.pedidas, [], "sin confirmar no sale nada hacia Canvas");
});

test("con la confirmacion, y solo entonces, se manda confirm:true", async () => {
  const pepe = usuarioFalso("pepe");
  guardarArchivo(pepe, { nombre: "tarea1.pdf", contenido_base64: PDF });

  const r = await entregar(pepe, {
    course_id: 31151,
    assignment_id: 99,
    archivo: "tarea1.pdf",
    comentario: "Va la tarea 1.",
    confirmar: true,
  });

  assert.equal(r.confirmado, true);
  assert.equal(pepe.argumentos[0].confirm, true);
  assert.equal(pepe.argumentos[0].comment, "Va la tarea 1.");
});

test("no se puede entregar un archivo que no se subio", async () => {
  const pepe = usuarioFalso("pepe");
  await assert.rejects(
    () => revisar(pepe, { course_id: 1, assignment_id: 1, archivo: "no-existe.pdf" }),
    error => {
      assert.equal(error.estado, 404);
      assert.match(error.message, /Subelo primero/);
      return true;
    },
  );
  assert.deepEqual(pepe.pedidas, []);
});

test("no se puede entregar el archivo de otra persona", async () => {
  const ana = usuarioFalso("ana");
  const pepe = usuarioFalso("pepe");
  guardarArchivo(pepe, { nombre: "privado.pdf", contenido_base64: PDF });

  // Ana nombra el archivo de pepe: para ella no existe, porque se busca en SU
  // carpeta y el nombre no puede salir de ahi.
  await assert.rejects(
    () => revisar(ana, { course_id: 1, assignment_id: 1, archivo: "privado.pdf" }),
    /Subelo primero/,
  );
  await assert.rejects(
    () => revisar(ana, { course_id: 1, assignment_id: 1, archivo: "../pepe/entregas/privado.pdf" }),
    /Subelo primero/,
  );
  assert.deepEqual(ana.pedidas, []);
});

test("falta el ramo, la tarea o el archivo: se dice y no se llama al MCP", async () => {
  const pepe = usuarioFalso("pepe");
  guardarArchivo(pepe, { nombre: "tarea1.pdf", contenido_base64: PDF });

  await assert.rejects(() => revisar(pepe, { assignment_id: 1, archivo: "tarea1.pdf" }), /Falta el ramo/);
  await assert.rejects(() => revisar(pepe, { course_id: 1, archivo: "tarea1.pdf" }), /Falta la tarea/);
  await assert.rejects(() => revisar(pepe, { course_id: 1, assignment_id: 1 }), /Falta el archivo/);
  assert.deepEqual(pepe.pedidas, []);
});
