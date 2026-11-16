/**
 * Las partes puras del pipeline de guias.
 *
 * La propiedad que de verdad importa esta en el primer bloque: TODA seccion sale
 * con al menos una cita, y todas sus citas vienen del material. Es lo que hace
 * que `canvas_write_study_guide` no pueda fallar por una cita inventada, que es
 * justo la validacion que hace auditable a la guia.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  MINIMO_PROSA,
  armarEsqueleto,
  limpiarProsa,
  nombreDeGuia,
  resumirExcluidas,
  tituloDeFuente,
  tituloPorDefecto,
  validarCitas,
} from "../web/src/guias.mjs";

const fuente = (cita, tipo, titulo, texto = "x".repeat(400)) => ({
  cita,
  tipo,
  titulo,
  pasajes: texto ? [texto] : [],
});

const MATERIAL = [
  fuente("anuncio:131609", "anuncio", "131609 - Fecha Prueba 2", "La prueba 2 es el 27 de noviembre."),
  fuente("tarea:999", "tarea", "999 - Tarea 3", "Entregar el AFD minimizado."),
  fuente("modulo:84182", "modulo", "84182 - Grafos"),
  fuente("archivo:512099", "archivo", "512099 - 143867_EJERCICIOSSEMANA7.pdf", "y".repeat(1500)),
  fuente("archivo:512100", "archivo", "512100 - escaneado.pdf", ""),
  fuente("pagina:7", "pagina", "7 - Bienvenida"),
];

/* ───────── armarEsqueleto ───────── */

test("toda seccion sale con al menos una cita, y todas vienen del material", () => {
  const validas = new Set(MATERIAL.map(f => f.cita));
  for (const seccion of armarEsqueleto(MATERIAL)) {
    assert.ok(seccion.fuentes.length >= 1, `"${seccion.encabezado}" quedo sin citas`);
    for (const cita of seccion.fuentes) {
      assert.ok(validas.has(cita), `"${cita}" no salio del material`);
    }
  }
});

test("las fuentes sin pasajes se descartan", () => {
  // Es el caso real del vault: un adjunto sin texto extraido existe, pero no
  // aporta ni una palabra.
  const esqueleto = armarEsqueleto(MATERIAL);
  assert.ok(!JSON.stringify(esqueleto).includes("512100"));
});

test("anuncios y tareas van juntos y primero", () => {
  const [primera] = armarEsqueleto(MATERIAL);
  assert.match(primera.encabezado, /profesor/i);
  assert.deepEqual(primera.fuentes, ["anuncio:131609", "tarea:999"]);
});

test("los modulos tienen su propia seccion", () => {
  const seccion = armarEsqueleto(MATERIAL).find(s => s.fuentes.includes("modulo:84182"));
  assert.match(seccion.encabezado, /organizada/i);
});

test("respeta el tope de secciones", () => {
  assert.equal(armarEsqueleto(MATERIAL, { maximo: 2 }).length, 2);
  assert.ok(armarEsqueleto(MATERIAL, { maximo: 99 }).length >= 3);
});

test("sin fuentes utiles no hay esqueleto", () => {
  assert.deepEqual(armarEsqueleto([]), []);
  assert.deepEqual(armarEsqueleto([fuente("archivo:1", "archivo", "sin texto", "")]), []);
});

test("las fuentes cortas se fusionan y la larga se queda sola", () => {
  const cortas = [
    fuente("pagina:1", "pagina", "1 - Una", "corta"),
    fuente("pagina:2", "pagina", "2 - Otra", "corta"),
  ];
  assert.equal(armarEsqueleto(cortas).length, 1);

  const larga = [fuente("archivo:1", "archivo", "1 - Larga", "z".repeat(2000))];
  assert.equal(armarEsqueleto(larga).length, 1);
});

test("el material de cada seccion lleva las citas rotuladas", () => {
  const [primera] = armarEsqueleto(MATERIAL);
  assert.match(primera.material, /\[anuncio:131609/);
});

/* ───────── tituloDeFuente ───────── */

test("el titulo de seccion se limpia del id y la extension", () => {
  assert.equal(
    tituloDeFuente({ tipo: "archivo", titulo: "512099 - 143867_EJERCICIOSSEMANA7.pdf" }),
    "EJERCICIOSSEMANA7",
  );
});

test("la ficha del curso no se llama 'Curso'", () => {
  // "Curso" como encabezado de seccion no le dice nada a nadie.
  assert.equal(tituloDeFuente({ tipo: "curso", titulo: "Curso" }), "Vista general del ramo");
});

/* ───────── validarCitas ───────── */

test("deja pasar las citas validas", () => {
  const { secciones, descartadas } = validarCitas(
    [{ encabezado: "A", fuentes: ["anuncio:1", "pagina:2"] }],
    ["anuncio:1", "pagina:2"],
  );
  assert.equal(descartadas.length, 0);
  assert.deepEqual(secciones[0].fuentes, ["anuncio:1", "pagina:2"]);
});

test("una cita que no es del ramo se descarta y se anota", () => {
  const { secciones, descartadas } = validarCitas(
    [{ encabezado: "A", fuentes: ["anuncio:1", "archivo:inventado"] }],
    ["anuncio:1"],
  );
  assert.deepEqual(secciones[0].fuentes, ["anuncio:1"]);
  assert.deepEqual(descartadas, [{ seccion: "A", cita: "archivo:inventado" }]);
});

test("una seccion que se queda sin citas se elimina entera", () => {
  // El MCP la rechazaria con "no declara fuentes" y se perderia la guia
  // completa por culpa de una seccion.
  const { secciones } = validarCitas([{ encabezado: "A", fuentes: ["nada:1"] }], ["anuncio:1"]);
  assert.deepEqual(secciones, []);
});

/* ───────── limpiarProsa ───────── */

const PERMITIDAS = ["anuncio:131609"];

test("quita el preambulo, el encabezado y la linea de fuentes que el modelo cuela igual", () => {
  const sucio = [
    "Claro, aqui esta la seccion:",
    "## Automatas finitos",
    "Un AFD es una quintupla y entra en la prueba, segun el calendario del ramo.",
    "Fuentes: anuncio:131609",
  ].join("\n");

  const limpio = limpiarProsa(sucio, PERMITIDAS);
  assert.doesNotMatch(limpio, /Claro/);
  assert.doesNotMatch(limpio, /^##/m);
  assert.doesNotMatch(limpio, /Fuentes:/);
  assert.match(limpio, /^Un AFD/);
});

test("conserva una cita del material y borra una inventada", () => {
  const limpio = limpiarProsa(
    "Entra hasta la unidad IV (anuncio:131609) y tambien lo otro (archivo:999). Nada mas que agregar.",
    PERMITIDAS,
  );
  assert.match(limpio, /\(anuncio:131609\)/);
  assert.doesNotMatch(limpio, /archivo:999/);
  // Y no deja el hueco antes del punto.
  assert.match(limpio, /lo otro\./);
});

test("un parentesis normal sobrevive", () => {
  const texto = "Conviene repasar la unidad 2 (ver los apuntes) antes de la prueba del viernes.";
  assert.equal(limpiarProsa(texto, PERMITIDAS), texto);
});

test("quita las negritas y los bloques de codigo", () => {
  const limpio = limpiarProsa("```\nUn **AFD** es una quintupla y entra en la prueba del viernes.\n```", []);
  assert.doesNotMatch(limpio, /\*\*/);
  assert.doesNotMatch(limpio, /```/);
});

test("lo que queda demasiado corto no es prosa: devuelve vacio", () => {
  assert.equal(limpiarProsa("ok.", []), "");
  assert.equal(limpiarProsa("", []), "");
  assert.equal(limpiarProsa("x".repeat(MINIMO_PROSA), []).length, MINIMO_PROSA);
});

/* ───────── nombres y resumenes ───────── */

test("el nombre del archivo es el mismo que elige el MCP", () => {
  // Espejo de sanitizeName: si los dos dejan de estar de acuerdo, el PDF no
  // aparece al lado de la nota y el listado queda sin enlace.
  assert.equal(nombreDeGuia("Guia: automatas/finitos"), "Guia_ automatas_finitos");
  assert.equal(nombreDeGuia("  con espacios  "), "con espacios");
  assert.equal(nombreDeGuia("termina en punto."), "termina en punto");
  assert.equal(nombreDeGuia(""), "sin-nombre");
  assert.equal(nombreDeGuia("a".repeat(200)).length, 150);
});

test("el titulo por defecto lleva el tema y la fecha", () => {
  const titulo = tituloPorDefecto({ tema: "automatas", fecha: new Date(2026, 10, 15) });
  assert.equal(titulo, "Guia - automatas - 2026-11-15");
});

test("lo excluido se resume por motivo y concuerda en plural", () => {
  assert.deepEqual(
    resumirExcluidas([
      { motivo: "sin texto extraído" },
      { motivo: "sin texto extraído" },
      { motivo: "no menciona el tema" },
    ]),
    ["2 fuentes sin texto extraído", "1 fuente no menciona el tema"],
  );
  assert.deepEqual(
    resumirExcluidas([{ motivo: "no menciona el tema" }, { motivo: "no menciona el tema" }]),
    ["2 fuentes no mencionan el tema"],
  );
  assert.deepEqual(resumirExcluidas([]), []);
  assert.deepEqual(resumirExcluidas(undefined), []);
});
