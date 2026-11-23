/**
 * El agente contra un Ollama de mentira.
 *
 * Un servidor `node:http` en un puerto al azar, no un `fetch` parcheado: asi se
 * ejercita el fetch de verdad, el AbortSignal de verdad y los codigos de estado
 * de verdad, y cuesta un milisegundo. Corre en CI sin Ollama y sin modelo.
 *
 * El modelo y la URL se leen al importar el modulo, asi que cada variante se
 * importa con la query cambiada para saltarse el cache de ESM.
 */
import assert from "node:assert/strict";
import http from "node:http";
import test, { after } from "node:test";

/* ───────── El Ollama de mentira ───────── */

/** Lo ultimo que se le pidio, para poder revisar el cuerpo de la peticion. */
let ultimoPedido = null;
/** Lo que va a contestar el proximo /api/chat. */
let respuestaDelModelo = { message: { content: "" } };
/** Con que estado HTTP lo contesta. */
let estadoDeChat = 200;
/** Lo que reporta /api/tags. */
let instalados = [];

const servidor = http.createServer((pedido, respuesta) => {
  let crudo = "";
  pedido.on("data", trozo => { crudo += trozo; });
  pedido.on("end", () => {
    const json = (estado, cuerpo) => {
      respuesta.writeHead(estado, { "content-type": "application/json" });
      respuesta.end(JSON.stringify(cuerpo));
    };

    if (pedido.url === "/api/tags") {
      json(200, { models: instalados.map(name => ({ name })) });
      return;
    }

    ultimoPedido = { url: pedido.url, cuerpo: crudo ? JSON.parse(crudo) : null };
    json(estadoDeChat, estadoDeChat === 200 ? respuestaDelModelo : { error: "a proposito" });
  });
});

await new Promise(listo => servidor.listen(0, "127.0.0.1", listo));
const base = `http://127.0.0.1:${servidor.address().port}`;

/* Un puerto que ya nadie escucha, para el caso de Ollama apagado. */
const cerrado = http.createServer();
await new Promise(listo => cerrado.listen(0, "127.0.0.1", listo));
const baseMuerta = `http://127.0.0.1:${cerrado.address().port}`;
await new Promise(listo => cerrado.close(listo));

after(() => servidor.close());

/* ───────── Las variantes del modulo ───────── */

process.env.OLLAMA_URL = base;
process.env.PLATAFORMA_MODELO = "qwen3.5:4b-q4_K_M";
delete process.env.PLATAFORMA_TOOLS;
delete process.env.PLATAFORMA_MODELO_TIMEOUT;

/** El caso normal: modelo que razona, herramientas apagadas. */
const agente = await import("../web/src/agente.mjs");

/** El mismo modelo configurado sin la cuantizacion en el nombre. */
process.env.PLATAFORMA_MODELO = "qwen3.5:4b";
const sinCuantizacion = await import("../web/src/agente.mjs?sinCuantizacion");

/** Un modelo que no esta en el registro: tiene que caer al perfil generico. */
process.env.PLATAFORMA_MODELO = "modelo-que-nadie-conoce:1b";
const desconocido = await import("../web/src/agente.mjs?desconocido");

/** Con el canal de herramientas prendido. */
process.env.PLATAFORMA_MODELO = "qwen3.5:4b-q4_K_M";
process.env.PLATAFORMA_TOOLS = "1";
const conHerramientas = await import("../web/src/agente.mjs?conHerramientas");
delete process.env.PLATAFORMA_TOOLS;

/** Apuntando a un Ollama que no esta. */
process.env.OLLAMA_URL = baseMuerta;
const apagado = await import("../web/src/agente.mjs?apagado");
process.env.OLLAMA_URL = base;

/** Un modelo del registro que NO razona. */
process.env.PLATAFORMA_MODELO = "llama3.1:latest";
const noRazona = await import("../web/src/agente.mjs?noRazona");

const redactar = (modulo = agente) => modulo.redactarProsa({
  sistema: "sistema",
  instruccion: "instruccion",
  material: "MATERIAL",
});

/* ───────── mismoModelo ───────── */

test("el mismo modelo escrito de varias formas", () => {
  const { mismoModelo } = agente;

  // El :latest implicito, en las dos direcciones.
  assert.ok(mismoModelo("llama3.1", "llama3.1:latest"));
  assert.ok(mismoModelo("llama3.1:latest", "llama3.1"));

  // La cuantizacion pegada al tamano, que es el caso que daba el falso negativo.
  assert.ok(mismoModelo("qwen3.5:4b", "qwen3.5:4b-q4_K_M"));
  assert.ok(mismoModelo("qwen3.5:4b-q4_K_M", "qwen3.5:4b"));

  // Un tag de tamano sobre la familia.
  assert.ok(mismoModelo("llama3.1", "llama3.1:8b"));

  // Mayusculas y espacios no cuentan.
  assert.ok(mismoModelo(" QWEN3.5:4B ", "qwen3.5:4b"));
});

test("dos modelos distintos no se confunden aunque el nombre empiece igual", () => {
  const { mismoModelo } = agente;

  // El caso que importa: sin exigir separador, "llama3" calzaria con "llama3.1".
  assert.ok(!mismoModelo("llama3", "llama3.1:latest"));
  assert.ok(!mismoModelo("qwen3.5:4b", "qwen3.5:9b"));
  assert.ok(!mismoModelo("gemma4:e2b", "gemma3:e2b"));
  assert.ok(!mismoModelo("", "qwen3.5:4b"));
  assert.ok(!mismoModelo(undefined, undefined));
});

/* ───────── Perfiles ───────── */

test("el perfil sale del nombre del modelo, con la cuantizacion o sin ella", () => {
  assert.equal(agente.PERFIL.clave, "qwen3.5:4b");
  assert.equal(sinCuantizacion.PERFIL.clave, "qwen3.5:4b");
  assert.equal(noRazona.PERFIL.clave, "llama3.1");
});

test("un modelo fuera del registro cae al perfil generico, no se queda sin arrancar", () => {
  assert.equal(desconocido.PERFIL.clave, "generico");
  // Y el generico es conservador: no le manda a un modelo desconocido el
  // presupuesto del mas grande del registro.
  assert.equal(desconocido.PERFIL.presupuesto, 8000);
  assert.equal(desconocido.PERFIL.razona, false);
  assert.equal(desconocido.PERFIL.herramientas, false);
});

/* ───────── El cuerpo de la peticion ───────── */

test("la peticion lleva num_ctx, que es lo que evitaba el truncado silencioso", async () => {
  estadoDeChat = 200;
  respuestaDelModelo = { message: { content: "Una seccion con suficiente largo para pasar el minimo." } };

  await redactar();

  assert.equal(ultimoPedido.url, "/api/chat");
  assert.equal(ultimoPedido.cuerpo.options.num_ctx, agente.PERFIL.contexto);
  assert.equal(ultimoPedido.cuerpo.options.num_predict, agente.PERFIL.tokensProsa);
  assert.equal(ultimoPedido.cuerpo.stream, false);
  assert.equal(ultimoPedido.cuerpo.model, "qwen3.5:4b-q4_K_M");
});

test("el modelo se queda cargado entre llamadas", async () => {
  respuestaDelModelo = { message: { content: "Una seccion con suficiente largo para pasar el minimo." } };
  await redactar();
  assert.ok(ultimoPedido.cuerpo.keep_alive, "sin keep_alive, una guia paga la carga en cada seccion");
});

test("think: false solo se manda a los modelos que razonan", async () => {
  respuestaDelModelo = { message: { content: "Una seccion con suficiente largo para pasar el minimo." } };

  await redactar();
  assert.equal(ultimoPedido.cuerpo.think, false);

  await redactar(noRazona);
  // Hay builds de Ollama que responden 400 si se les manda el campo.
  assert.ok(!("think" in ultimoPedido.cuerpo));
});

test("sin la bandera prendida, el cuerpo no lleva herramientas", async () => {
  respuestaDelModelo = { message: { content: "Una seccion con suficiente largo para pasar el minimo." } };
  await redactar();
  assert.ok(!("tools" in ultimoPedido.cuerpo));
  assert.equal(agente.HERRAMIENTAS, false);
});

/* ───────── El razonamiento ───────── */

test("el razonamiento que viene en su propio campo no se usa", async () => {
  respuestaDelModelo = {
    message: {
      thinking: "A ver, el estudiante pregunta por la unidad IV, deberia revisar...",
      content: "La unidad IV entra en la prueba, segun el calendario del ramo.",
    },
  };
  const texto = await redactar();
  assert.equal(texto, "La unidad IV entra en la prueba, segun el calendario del ramo.");
  assert.doesNotMatch(texto, /A ver/);
});

test("el razonamiento que se cuela dentro del contenido se saca", async () => {
  respuestaDelModelo = {
    message: {
      content: "<think>Primero reviso el anuncio (anuncio:131609) y despues redacto.</think>\nLa unidad IV entra en la prueba del viernes.",
    },
  };
  const texto = await redactar();
  assert.equal(texto, "La unidad IV entra en la prueba del viernes.");
  assert.doesNotMatch(texto, /Primero reviso/);
});

test("un bloque de razonamiento sin cerrar no se publica a medias", async () => {
  // Pasa cuando num_predict se agota en medio del pensamiento.
  respuestaDelModelo = { message: { content: "<think>Voy a revisar el calendario y despues" } };
  await assert.rejects(redactar(), error => {
    // El remedio es otro que el de una respuesta vacia: hay que subir los
    // tokens o apagarle el razonamiento, no reintentar.
    assert.match(error.message, /razonando/i);
    return true;
  });
});

test("sinRazonamiento aguanta las etiquetas de los distintos modelos", () => {
  const { sinRazonamiento } = agente;
  assert.equal(sinRazonamiento("<thinking>bla</thinking>Hola."), "Hola.");
  assert.equal(sinRazonamiento("<reasoning>bla</reasoning>\n\nHola."), "Hola.");
  assert.equal(sinRazonamiento("<THINK>bla</THINK>Hola."), "Hola.");
  // Cierre huerfano: el bloque se abrio antes del primer token que llego.
  assert.equal(sinRazonamiento("bla bla</think>Hola."), "Hola.");
  // Y un texto sin razonamiento queda intacto.
  assert.equal(sinRazonamiento("Hola, esto no tiene razonamiento."), "Hola, esto no tiene razonamiento.");
  assert.equal(sinRazonamiento(null), "");
});

test("el modelo que responde vacio y el que se gasto pensando dan mensajes distintos", async () => {
  respuestaDelModelo = { message: { content: "" } };
  await assert.rejects(redactar(), /respondio vacio/);

  respuestaDelModelo = { message: { content: "", thinking: "pensando y pensando" } };
  await assert.rejects(redactar(), /razonando/i);
});

/* ───────── Los errores ───────── */

test("un 404 dice como bajar el modelo, con el nombre configurado", async () => {
  estadoDeChat = 404;
  await assert.rejects(redactar(), error => {
    assert.equal(error.estado, 503);
    assert.match(error.message, /ollama pull qwen3\.5:4b-q4_K_M/);
    return true;
  });
  estadoDeChat = 200;
});

test("cualquier otro estado de Ollama es un 502", async () => {
  estadoDeChat = 500;
  await assert.rejects(redactar(), error => {
    assert.equal(error.estado, 502);
    return true;
  });
  estadoDeChat = 200;
});

test("Ollama apagado es un 503 que nombra la direccion", async () => {
  await assert.rejects(redactar(apagado), error => {
    assert.equal(error.estado, 503);
    assert.match(error.message, /No se pudo hablar con Ollama/);
    assert.ok(error.message.includes(baseMuerta));
    return true;
  });
});

/* ───────── Estado del modelo ───────── */

test("el modelo bajado con la cuantizacion en el tag cuenta como disponible", async () => {
  instalados = ["qwen3.5:4b-q4_K_M", "llama3.1:latest"];

  const exacto = await agente.estadoDelModelo();
  assert.equal(exacto.vivo, true);
  assert.equal(exacto.disponible, true);
  assert.equal(exacto.mensaje, null);

  // El caso que mandaba al estudiante a los extractos literales sin necesidad.
  const parcial = await sinCuantizacion.estadoDelModelo();
  assert.equal(parcial.disponible, true, "qwen3.5:4b configurado contra qwen3.5:4b-q4_K_M bajado");
  assert.equal(parcial.modelo, "qwen3.5:4b");
});

test("si de verdad falta el modelo, lo dice con el comando para bajarlo", async () => {
  instalados = ["llama3.1:latest"];
  const estado = await agente.estadoDelModelo();
  assert.equal(estado.vivo, true);
  assert.equal(estado.disponible, false);
  assert.match(estado.mensaje, /ollama pull qwen3\.5:4b-q4_K_M/);
});

test("si hay otro de la misma familia bajado, el mensaje lo nombra", async () => {
  // El error de dedo tipico: tener el 9b y haber configurado el 4b.
  instalados = ["qwen3.5:9b-q4_K_M"];
  const estado = await agente.estadoDelModelo();
  assert.equal(estado.disponible, false);
  assert.match(estado.mensaje, /qwen3\.5:9b-q4_K_M/);
});

test("el estado no filtra la lista de modelos que tiene la maquina", async () => {
  instalados = ["qwen3.5:4b-q4_K_M", "un-modelo-privado:latest"];
  const estado = await agente.estadoDelModelo();
  assert.ok(!("instalados" in estado));
  assert.ok(!JSON.stringify(estado).includes("un-modelo-privado"));
});

test("Ollama apagado no lanza: devuelve vivo:false para que la pantalla lo diga", async () => {
  const estado = await apagado.estadoDelModelo();
  assert.equal(estado.vivo, false);
  assert.ok(estado.mensaje.includes(baseMuerta));
});

/* ───────── El canal de herramientas ───────── */

test("con la bandera apagada, pedir herramientas falla en vez de llamar al modelo", async () => {
  await assert.rejects(
    agente.preguntarConHerramientas([{ role: "user", content: "hola" }], { tools: [{ name: "x" }] }),
    error => {
      assert.equal(error.estado, 409);
      assert.match(error.message, /PLATAFORMA_TOOLS/);
      return true;
    },
  );
});

test("con la bandera prendida, las herramientas van en el cuerpo y las tool_calls vuelven", async () => {
  assert.equal(conHerramientas.HERRAMIENTAS, true);
  respuestaDelModelo = {
    message: {
      content: "",
      tool_calls: [{ function: { name: "canvas_study_sources", arguments: { course_id: 1 } } }],
    },
  };

  const tools = [{ type: "function", function: { name: "canvas_study_sources" } }];
  const salida = await conHerramientas.preguntarConHerramientas(
    [{ role: "user", content: "hola" }],
    { tools },
  );

  assert.deepEqual(ultimoPedido.cuerpo.tools, tools);
  assert.equal(salida.herramientas.length, 1);
  assert.equal(salida.herramientas[0].function.name, "canvas_study_sources");
});

/* ───────── armarBloques y limpiarTema ───────── */

const fuente = (cita, tipo, texto) => ({ cita, tipo, titulo: `titulo de ${cita}`, pasajes: [texto] });

test("los anuncios y las tareas van primero, aunque lleguen al final", () => {
  const bloques = agente.armarBloques([
    fuente("archivo:1", "archivo", "teoria de automatas"),
    fuente("anuncio:2", "anuncio", "la prueba 1 es el 12"),
    fuente("tarea:3", "tarea", "entrega el viernes"),
  ]);

  assert.match(bloques[0], /anuncio:2/);
  assert.match(bloques[1], /tarea:3/);
  assert.match(bloques[2], /archivo:1/);
});

test("una fuente larga no se come el presupuesto entero", () => {
  const largo = "x".repeat(10_000);
  const bloques = agente.armarBloques(
    [fuente("archivo:1", "archivo", largo), fuente("anuncio:2", "anuncio", "la prueba 1 es el 12")],
    { presupuesto: 3000, tope: 500 },
  );

  // El anuncio entra igual, que es el punto del tope por fuente.
  assert.ok(bloques.some(b => b.includes("anuncio:2")));
  assert.ok(bloques.every(b => b.length < 700));
});

test("el indice de un libro no desplaza al contenido", () => {
  /*
   * Desde que los adjuntos se extraen, una fuente puede ser un libro entero y
   * su primer pasaje es el indice. Como el tope recorta por el principio, ese
   * indice se comia el cupo y la seccion salia enumerando titulos.
   */
  const indice = [
    "2.2.4.",
    "Extension a cadenas de la funcion de transicion . . . . . . . . . . . . . . 41",
    "2.2.5.",
    "El lenguaje de un AFD . . . . . . . . . . . . . . . . . . 43",
    "2.2.6.",
    "Ejercicios de la Seccion 2.2 . . . . . . . . . . . . . . . 45",
  ].join("\n");
  const materia = "Un AFD acepta una cadena w si delta(q0, w) pertenece a F, segun el apunte.";

  const bloques = agente.armarBloques([
    { cita: "archivo:1", tipo: "archivo", titulo: "Libro", pasajes: [indice, materia] },
  ]);

  assert.ok(bloques[0].includes("Un AFD acepta"));
  assert.doesNotMatch(bloques[0], /\. \. \. \./);
});

test("si todo lo que vino es indice, se usa igual", () => {
  // Desaparecer la fuente seria peor: nadie sabria por que falta.
  const indice = [
    "Capitulo 1 . . . . . . . . . . 3",
    "Capitulo 2 . . . . . . . . . . 9",
    "Capitulo 3 . . . . . . . . . . 17",
  ].join("\n");
  const bloques = agente.armarBloques([
    { cita: "archivo:1", tipo: "archivo", titulo: "Solo indice", pasajes: [indice] },
  ]);
  assert.equal(bloques.length, 1);
  assert.ok(bloques[0].includes("Capitulo 1"));
});

test("esIndice no confunde una frase con puntos suspensivos", () => {
  assert.ok(!agente.esIndice("Y entonces... bueno... eso fue todo.\nSegunda linea.\nTercera."));
});

test("una fuente sin texto no genera bloque", () => {
  const bloques = agente.armarBloques([
    { cita: "archivo:1", tipo: "archivo", titulo: "vacio", pasajes: [] },
    fuente("anuncio:2", "anuncio", "la prueba 1 es el 12"),
  ]);
  assert.equal(bloques.length, 1);
  assert.match(bloques[0], /anuncio:2/);
});

test("limpiarTema deja los terminos que buscan algo", () => {
  assert.equal(agente.limpiarTema("que entra en la prueba 1"), "prueba 1");
  assert.equal(agente.limpiarTema("¿Cuándo es la Prueba 2?"), "prueba 2");
  // Si no queda nada, es mejor buscar de mas que no buscar.
  assert.equal(agente.limpiarTema("que es"), "que es");
});
