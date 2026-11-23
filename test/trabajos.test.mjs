/**
 * Los trabajos en segundo plano.
 *
 * Lo que se prueba no es que corran —eso se ve usando la plataforma— sino las
 * dos cosas que importan cuando algo sale mal: que un trabajo de una persona no
 * se pueda consultar desde otra cuenta, y que cuando el trabajo ya no esta, el
 * mensaje diga que hacer. Esto ultimo se agrego despues de recrear el contenedor
 * a mitad de una sincronizacion: la pantalla decia "No existe ese trabajo", que
 * es exacto y no le sirve a nadie.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { consultar, enCurso, lanzar } from "../web/src/trabajos.mjs";

/** Espera hasta que el trabajo deje de estar corriendo, sin dormir de mas. */
async function esperarFin(usuario, id) {
  for (let intento = 0; intento < 200; intento += 1) {
    const t = consultar(usuario, id);
    if (t.estado !== "corriendo") return t;
    await new Promise(listo => setTimeout(listo, 5));
  }
  throw new Error("el trabajo no termino");
}

test("un trabajo que termina bien deja su resultado", async () => {
  const id = lanzar("ana", "prueba", async reportar => {
    reportar({ hechos: 1, total: 2, paso: "a mitad" });
    return { cursos: 2 };
  });

  const t = await esperarFin("ana", id);
  assert.equal(t.estado, "listo");
  assert.deepEqual(t.resultado, { cursos: 2 });
  assert.equal(t.error, null);
});

test("un trabajo que falla guarda el motivo y no lanza al consultarlo", async () => {
  const id = lanzar("ana", "prueba", async () => {
    throw new Error("Canvas rechazo la sesion (401).");
  });

  const t = await esperarFin("ana", id);
  assert.equal(t.estado, "fallido");
  assert.match(t.error, /401/);
});

test("el avance se puede ir mirando mientras corre", async () => {
  let seguir;
  const bloqueo = new Promise(listo => { seguir = listo; });

  const id = lanzar("ana", "prueba", async reportar => {
    reportar({ hechos: 3, total: 10, paso: "trayendo Grafos" });
    await bloqueo;
    return "listo";
  });

  // Sin esperar el final: el avance tiene que verse ya.
  await new Promise(listo => setTimeout(listo, 10));
  const enMarcha = consultar("ana", id);
  assert.equal(enMarcha.estado, "corriendo");
  assert.equal(enMarcha.avance.hechos, 3);
  assert.equal(enMarcha.avance.paso, "trayendo Grafos");

  seguir();
  await esperarFin("ana", id);
});

test("el trabajo de una persona no existe para otra cuenta", async () => {
  const id = lanzar("ana", "prueba", async () => "de ana");
  await esperarFin("ana", id);

  // Para pepe no es un 403 sino un 404: ni siquiera se le confirma que exista.
  assert.throws(() => consultar("pepe", id), error => {
    assert.equal(error.estado, 404);
    return true;
  });
});

test("el trabajo que ya no esta dice que hacer, no solo que no esta", () => {
  /*
   * El caso de verdad: el servidor se reinicia a mitad de una sincronizacion.
   * La sesion sobrevive porque vive en un volumen, pero los trabajos son de
   * memoria. La pantalla quedaba diciendo "No existe ese trabajo".
   */
  assert.throws(() => consultar("ana", "no-existe"), error => {
    assert.equal(error.estado, 404);
    assert.match(error.message, /volver a lanzarlo/);
    assert.match(error.message, /vault esta a salvo/);
    return true;
  });
});

test("un id vacio o ausente no revienta", () => {
  for (const id of [undefined, null, "", 0]) {
    assert.throws(() => consultar("ana", id), error => error.estado === 404);
  }
});

test("enCurso evita lanzar dos del mismo tipo a la vez", async () => {
  let seguir;
  const bloqueo = new Promise(listo => { seguir = listo; });

  assert.equal(enCurso("bruno", "sincronizacion"), null);
  const id = lanzar("bruno", "sincronizacion", async () => { await bloqueo; return "ok"; });

  await new Promise(listo => setTimeout(listo, 10));
  assert.equal(enCurso("bruno", "sincronizacion"), id, "mientras corre, se encuentra");
  assert.equal(enCurso("bruno", "guia"), null, "pero solo del mismo tipo");
  assert.equal(enCurso("otra", "sincronizacion"), null, "y solo de la misma persona");

  seguir();
  await esperarFin("bruno", id);
  assert.equal(enCurso("bruno", "sincronizacion"), null, "al terminar, deja de estar en curso");
});

test("el dueno del trabajo no sale en lo que se devuelve", async () => {
  const id = lanzar("ana", "prueba", async () => "x");
  const t = await esperarFin("ana", id);
  assert.ok(!("usuarioId" in t), "el id de la persona no cruza al cliente");
});
