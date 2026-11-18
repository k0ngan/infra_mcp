/**
 * La medicion de adopcion: quien termino, cuanto usa, si vuelve y si respondio.
 *
 * Lo que se prueba aqui es lo que haria quedar mal al informe: que medir tumbe
 * una peticion, que quien se registro y nunca volvio desaparezca del cuadro
 * —justo el que hay que mirar—, que "termino" se ponga en verdadero sin haber
 * generado una guia, y que el resumen arrastre el hash de una contrasena.
 *
 * Sin red y sin tocar el disco de nadie: cada prueba usa su propia carpeta
 * temporal via PLATAFORMA_METRICAS.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { EVENTOS, guardarEncuesta, leerEventos, registrar, resumen } from "../web/src/metricas.mjs";

/** Carpeta temporal propia, apuntada por la variable de entorno. */
function enCarpetaNueva(cuerpo) {
  const previo = process.env.PLATAFORMA_METRICAS;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "metricas-"));
  process.env.PLATAFORMA_METRICAS = dir;
  try {
    return cuerpo(dir);
  } finally {
    if (previo === undefined) delete process.env.PLATAFORMA_METRICAS;
    else process.env.PLATAFORMA_METRICAS = previo;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const usuario = (id, nombre = id) => ({
  id,
  nombre,
  correo: `${id}@ejemplo.cl`,
  rol: "estudiante",
  contrasena: "scrypt$16384$8$1$deadbeef$cafe",
});

/** Escribe eventos con fecha puesta a mano, para poder probar la retencion. */
function eventoEn(dir, usuarioId, evento, iso) {
  fs.appendFileSync(
    path.join(dir, "eventos.jsonl"),
    JSON.stringify({ t: iso, u: usuarioId, e: evento }) + "\n",
    "utf8",
  );
}

test("registrar no lanza aunque la carpeta sea imposible", () => {
  const previo = process.env.PLATAFORMA_METRICAS;
  // Un archivo donde deberia ir la carpeta: mkdir falla seguro.
  const archivo = path.join(os.tmpdir(), `metricas-choque-${process.pid}`);
  fs.writeFileSync(archivo, "no soy una carpeta", "utf8");
  process.env.PLATAFORMA_METRICAS = archivo;
  try {
    assert.doesNotThrow(() => registrar("pepe", EVENTOS.GUIA));
  } finally {
    if (previo === undefined) delete process.env.PLATAFORMA_METRICAS;
    else process.env.PLATAFORMA_METRICAS = previo;
    fs.rmSync(archivo, { force: true });
  }
});

test("un evento sin usuario o sin tipo no se escribe", () => {
  enCarpetaNueva(() => {
    registrar("", EVENTOS.GUIA);
    registrar("pepe", "");
    assert.equal(leerEventos().length, 0);
  });
});

test("una linea corrupta no invalida las que si estan bien", () => {
  enCarpetaNueva(dir => {
    registrar("pepe", EVENTOS.SESION);
    fs.appendFileSync(path.join(dir, "eventos.jsonl"), "{esto no es json\n", "utf8");
    registrar("pepe", EVENTOS.GUIA);
    assert.equal(leerEventos().length, 2);
  });
});

test("quien se registro y nunca volvio aparece en el cuadro, en cero", () => {
  enCarpetaNueva(() => {
    const cuadro = resumen([usuario("fantasma")]);
    assert.equal(cuadro.usuarios, 1);
    assert.equal(cuadro.filas.length, 1);
    assert.equal(cuadro.filas[0].termino, false);
    assert.equal(cuadro.filas[0].uso.eventos, 0);
    assert.equal(cuadro.filas[0].actividad.ultima, null);
    assert.equal(cuadro.filas[0].actividad.dias_desde_ultima, null);
  });
});

test("terminar exige los tres pasos: cookie, sincronizacion y guia", () => {
  enCarpetaNueva(() => {
    registrar("pepe", EVENTOS.COOKIE);
    registrar("pepe", EVENTOS.SINCRONIZACION);
    let fila = resumen([usuario("pepe")]).filas[0];
    assert.equal(fila.termino, false, "sin guia no termino");
    assert.deepEqual(fila.pasos, { cookie: true, sincronizacion: true, guia: false });

    registrar("pepe", EVENTOS.GUIA);
    fila = resumen([usuario("pepe")]).filas[0];
    assert.equal(fila.termino, true);
    assert.equal(fila.uso.guias, 1);
  });
});

test("entrar diez veces en un dia no es volver; dos dias distintos si", () => {
  enCarpetaNueva(dir => {
    for (let i = 0; i < 10; i++) {
      eventoEn(dir, "pepe", EVENTOS.SESION, `2026-11-10T1${i}:00:00.000Z`);
    }
    assert.equal(resumen([usuario("pepe")]).filas[0].actividad.vuelve, false);

    eventoEn(dir, "pepe", EVENTOS.SESION, "2026-11-12T09:00:00.000Z");
    const fila = resumen([usuario("pepe")]).filas[0];
    assert.equal(fila.actividad.vuelve, true);
    assert.equal(fila.actividad.dias_activos, 2);
  });
});

test("los dias desde la ultima vez se cuentan contra el ahora que se le pasa", () => {
  enCarpetaNueva(dir => {
    eventoEn(dir, "pepe", EVENTOS.SESION, "2026-11-01T12:00:00.000Z");
    const ahora = Date.parse("2026-11-16T12:00:00.000Z");
    const fila = resumen([usuario("pepe")], ahora).filas[0];
    assert.equal(fila.actividad.dias_desde_ultima, 15);
    assert.equal(fila.actividad.activo_ultimos_7_dias, false);
  });
});

test("el cuadro no arrastra el hash de la contrasena", () => {
  enCarpetaNueva(() => {
    const serializado = JSON.stringify(resumen([usuario("pepe")]));
    assert.ok(!serializado.includes("scrypt"), "el hash no puede salir en el informe");
  });
});

test("la encuesta valida la escala, las opciones y lo obligatorio", () => {
  enCarpetaNueva(() => {
    assert.throws(() => guardarEncuesta("pepe", {}), /Falta responder/);
    assert.throws(() => guardarEncuesta("pepe", { sirvio: 9 }), /entre 1 y 5/);
    assert.throws(
      () => guardarEncuesta("pepe", { sirvio: 4, seguiria: "Quizas no se" }),
      /no es una opcion/,
    );
    assert.doesNotThrow(() => guardarEncuesta("pepe", { sirvio: 4, seguiria: "Sí" }));
  });
});

test("responder de nuevo reemplaza las respuestas y conserva la primera fecha", () => {
  enCarpetaNueva(() => {
    const primera = guardarEncuesta("pepe", { sirvio: 2, falta: "nada" });
    const segunda = guardarEncuesta("pepe", { sirvio: 5 });
    assert.equal(segunda.respondida, primera.respondida);
    assert.equal(segunda.respuestas.sirvio, 5);
    assert.equal(segunda.respuestas.falta, undefined, "la respuesta vieja no se queda pegada");
  });
});

test("responder la encuesta queda registrado como evento", () => {
  enCarpetaNueva(() => {
    guardarEncuesta("pepe", { sirvio: 3 });
    const fila = resumen([usuario("pepe")]).filas[0];
    assert.equal(fila.encuesta.respondida, true);
    assert.equal(fila.encuesta.respuestas.sirvio, 3);
    assert.ok(leerEventos().some(e => e.e === EVENTOS.ENCUESTA));
  });
});

test("los totales promedian solo a quienes respondieron", () => {
  enCarpetaNueva(() => {
    guardarEncuesta("ana", { sirvio: 5 });
    guardarEncuesta("beto", { sirvio: 3 });
    const cuadro = resumen([usuario("ana"), usuario("beto"), usuario("sin_responder")]);
    assert.equal(cuadro.totales.respondieron_encuesta, 2);
    assert.equal(cuadro.totales.respondieron_pct, 66.7);
    assert.equal(cuadro.totales.promedio_sirvio, 4);
  });
});

test("sin nadie que haya respondido, el promedio es null y no NaN", () => {
  enCarpetaNueva(() => {
    const cuadro = resumen([usuario("pepe")]);
    assert.equal(cuadro.totales.promedio_sirvio, null);
    assert.equal(cuadro.totales.terminaron_pct, 0);
  });
});

test("sin usuarios los porcentajes son 0, no una division por cero", () => {
  enCarpetaNueva(() => {
    const cuadro = resumen([]);
    assert.equal(cuadro.usuarios, 0);
    assert.equal(cuadro.totales.terminaron_pct, 0);
    assert.equal(cuadro.totales.respondieron_pct, 0);
  });
});

test("el texto libre se recorta y no se guarda entero", () => {
  enCarpetaNueva(() => {
    const guardada = guardarEncuesta("pepe", { sirvio: 1, costo: "x".repeat(5000) });
    assert.equal(guardada.respuestas.costo.length, 2000);
  });
});
