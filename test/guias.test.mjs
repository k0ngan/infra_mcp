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
  redactarSecciones,
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

test("el encabezado repetido no se imprime debajo del que ya puso el codigo", () => {
  /*
   * SISTEMA_GUIA lo prohibe y los modelos lo escriben igual. Sin esto quedaba
   * el titulo dos veces en el PDF: el del \section y el del modelo.
   */
  const limpio = limpiarProsa(
    "Lo que dijo el profesor: fechas y alcance\n\nLa prueba 1 es el 14 de noviembre, segun el aviso del ramo.",
    PERMITIDAS,
    "Lo que dijo el profesor: fechas y alcance",
  );
  assert.match(limpio, /^La prueba 1/);
  assert.doesNotMatch(limpio, /dijo el profesor/);
});

test("el encabezado se reconoce con tildes, mayusculas o dos puntos de mas", () => {
  const variantes = [
    "COMO VIENE ORGANIZADA LA MATERIA",
    "Cómo viene organizada la materia:",
    "Como viene organizada la materia.",
  ];
  for (const variante of variantes) {
    const limpio = limpiarProsa(
      `${variante}\n\nLos modulos del ramo vienen ordenados por unidad, segun el material.`,
      PERMITIDAS,
      "Como viene organizada la materia",
    );
    assert.match(limpio, /^Los modulos/, `no reconocio "${variante}"`);
  }
});

test("un parrafo que solo se parece al encabezado no se borra", () => {
  // La regla compara el texto completo, no busca parecidos: borrar prosa de
  // verdad seria peor que dejar un titulo repetido.
  const texto = "Lo que dijo el profesor sobre las fechas fue que la prueba se adelanta al viernes.";
  assert.equal(limpiarProsa(texto, PERMITIDAS, "Lo que dijo el profesor: fechas y alcance"), texto);
});

test("el razonamiento del modelo no llega al PDF", () => {
  const limpio = limpiarProsa(
    "<think>Reviso el anuncio y armo dos parrafos.</think>\nLa unidad IV entra en la prueba del viernes.",
    PERMITIDAS,
  );
  assert.equal(limpio, "La unidad IV entra en la prueba del viernes.");
  assert.doesNotMatch(limpio, /think/i);
});

test("una cita permitida dentro del razonamiento tampoco sobrevive", () => {
  /*
   * El filtro de citas solo borra las que NO estan permitidas, asi que una clave
   * de verdad citada dentro del pensamiento pasaria el filtro y se imprimiria
   * como si fuera prosa. Por eso el razonamiento se saca antes.
   */
  const limpio = limpiarProsa(
    "<think>El anuncio (anuncio:131609) dice que entra la unidad IV, lo uso.</think>\nEntra hasta la unidad IV, segun el calendario del ramo.",
    PERMITIDAS,
  );
  assert.doesNotMatch(limpio, /lo uso/);
  assert.match(limpio, /^Entra hasta la unidad IV/);
});

test("un razonamiento cortado a medias no se publica: queda vacio y cae al extracto", () => {
  // Pasa cuando el presupuesto de tokens se agota pensando.
  assert.equal(limpiarProsa("<think>Voy a revisar el calendario del ramo y despues", PERMITIDAS), "");
});

test("un encabezado en medio del cuerpo tambien se saca, no solo al principio", () => {
  // El bucle de limpieza solo miraba las lineas de arriba, asi que un "###" en
  // medio llegaba al PDF impreso como \#\#\#.
  const limpio = limpiarProsa(
    ["Un AFD es una quintupla y entra en la prueba.", "### Ejemplo", "El del calendario del ramo."].join("\n"),
    PERMITIDAS,
  );
  assert.doesNotMatch(limpio, /#/);
  assert.match(limpio, /Ejemplo/);
});

test("las vinetas quedan en el formato que pide el prompt", () => {
  const limpio = limpiarProsa(
    ["* Lo primero que entra es la unidad III.", "• Lo segundo es la unidad IV."].join("\n"),
    PERMITIDAS,
  );
  assert.match(limpio, /^- Lo primero/m);
  assert.match(limpio, /^- Lo segundo/m);
});

test("la ficha del curso no se convierte en seccion: es un indice de enlaces", () => {
  /*
   * Su texto son enlaces de Obsidian, no materia. Cuando entraba como seccion,
   * el modelo devolvia o una lista de rutas copiadas o un parrafo diciendo que
   * no encontro nada; las dos cosas son una seccion perdida en el PDF.
   */
  const esqueleto = armarEsqueleto([
    fuente("curso", "curso", "Curso", "[[Canvas/ramo/Archivos/1230990 - Apunte.pdf]]\n[[Canvas/ramo/Archivos/1230865 - Algoritmos.pdf]]"),
    fuente("archivo:1", "archivo", "Apunte de automatas", "Un AFD es una quintupla."),
  ]);

  const citas = esqueleto.flatMap(s => s.fuentes);
  assert.ok(!citas.includes("curso"), "la ficha del curso no puede ser material de una seccion");
  assert.ok(citas.includes("archivo:1"));
  assert.ok(esqueleto.every(s => !s.material.includes("[[Canvas/")));
});

/* ───────── redactarSecciones ───────── */

const SECCIONES = [
  { encabezado: "Unidad I", material: "[anuncio:131609 — Aviso]\nla prueba 1 es el 12", fuentes: ["anuncio:131609"] },
  { encabezado: "Unidad II", material: "[archivo:1 — Apunte]\nteoria de automatas", fuentes: ["archivo:1"] },
  { encabezado: "Unidad III", material: "[archivo:2 — Apunte]\nlenguajes regulares", fuentes: ["archivo:2"] },
];

test("el modelo caido se intenta una vez y no una por seccion", async () => {
  let llamadas = 0;
  const avisos = [];

  const redactadas = await redactarSecciones(SECCIONES, {
    tema: "automatas",
    avisos,
    redactor: async () => {
      llamadas += 1;
      throw Object.assign(new Error("No se pudo hablar con Ollama"), { estado: 503 });
    },
  });

  // Lo que evita que una guia de puros extractos se demore seis timeouts.
  assert.equal(llamadas, 1);
  assert.equal(redactadas.length, 3);
  assert.ok(redactadas.every(s => s.origen === "extracto"));
  // Un aviso de que el modelo se cayo, no tres.
  assert.equal(avisos.filter(a => a.includes("dejo de responder")).length, 1);
  // Y ningun aviso por seccion: uno solo por toda la guia.
  assert.equal(avisos.filter(a => a.startsWith("La seccion")).length, 0);
  assert.ok(avisos.some(a => a.includes("El resto de las secciones")));
});

test("lo que ya se redacto se conserva cuando el modelo se cae a mitad", async () => {
  let llamadas = 0;
  const avisos = [];

  const redactadas = await redactarSecciones(SECCIONES, {
    tema: "automatas",
    avisos,
    redactor: async () => {
      llamadas += 1;
      if (llamadas === 1) return "La prueba 1 es el 12, segun el aviso del ramo (anuncio:131609).";
      throw Object.assign(new Error("No se pudo hablar con Ollama"), { estado: 503 });
    },
  });

  assert.equal(redactadas[0].origen, "modelo");
  assert.equal(redactadas[1].origen, "extracto");
  assert.equal(redactadas[2].origen, "extracto");
  // Dos llamadas: la que salio bien y la que fallo. La tercera ya no se intenta.
  assert.equal(llamadas, 2);
});

test("una seccion vacia se reintenta una vez y despues cae al extracto", async () => {
  let llamadas = 0;
  const avisos = [];

  const redactadas = await redactarSecciones([SECCIONES[0]], {
    tema: "automatas",
    avisos,
    redactor: async () => {
      llamadas += 1;
      return "ok.";  // mas corto que MINIMO_PROSA: limpiarProsa devuelve ""
    },
  });

  assert.equal(llamadas, 2, "un reintento, no mas");
  assert.equal(redactadas[0].origen, "extracto");
  assert.ok(avisos.some(a => a.includes("quedo como extracto literal")));
});

test("con sin_modelo no se llama al modelo ni una vez", async () => {
  let llamadas = 0;
  const avisos = [];

  const redactadas = await redactarSecciones(SECCIONES, {
    sinModelo: true,
    avisos,
    redactor: async () => { llamadas += 1; return "no deberia pasar"; },
  });

  assert.equal(llamadas, 0);
  assert.equal(avisos.length, 0, "pedir extractos a proposito no es una falla que avisar");
  assert.ok(redactadas.every(s => s.origen === "extracto"));
  assert.ok(redactadas.every(s => s.cuerpo.startsWith("Extracto literal")));
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
