/**
 * El limite que define a esta plataforma.
 *
 * Antes era "no escribe en Canvas, punto". Desde que la pantalla permite
 * entregar, el limite es mas estrecho y mas interesante: hacia Canvas no sale
 * NADA sin que una persona lo haya pedido explicitamente. Ni por una ruta nueva
 * que se descuide, ni por decision del modelo.
 *
 * Estos son los tests de eso. No hay red: el handler del MCP es de mentira y
 * solo registra lo que le piden.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  HERRAMIENTAS_DEL_AGENTE,
  HERRAMIENTAS_PERMITIDAS,
  HERRAMIENTAS_QUE_ESCRIBEN_EN_CANVAS,
  llamar,
  listarHerramientas,
} from "../web/src/canvas.mjs";

const ENTREGAR = "canvas_submit_assignment";

/** Un MCP de mentira que apunta lo que le pidieron y contesta que si. */
function usuarioFalso() {
  const pedidas = [];
  const argumentos = [];
  return {
    pedidas,
    argumentos,
    id: "prueba",
    handler: async mensaje => {
      if (mensaje.method === "tools/list") {
        return {
          result: {
            tools: [
              {
                name: "canvas_study_sources",
                description: "busca pasajes",
                inputSchema: { type: "object", properties: { course_id: { type: "integer" } } },
              },
              { name: "canvas_write_study_guide", description: "escribe la guia" },
              { name: ENTREGAR, description: "entrega una tarea" },
            ],
          },
        };
      }
      pedidas.push(mensaje.params.name);
      argumentos.push(mensaje.params.arguments || {});
      return { result: { structuredContent: { ok: true } } };
    },
  };
}

test("entregar sin pedirlo explicitamente no llega al MCP", async () => {
  /*
   * El caso que protege de un descuido: una ruta nueva que llame a `llamar` como
   * se llama a todo lo demas NO entrega. Hay que pasar la bandera a mano, y eso
   * se escribe una sola vez, en la ruta de entrega.
   */
  const usuario = usuarioFalso();
  await assert.rejects(
    () => llamar(usuario, ENTREGAR, { course_id: 1, assignment_id: 1 }),
    error => {
      assert.equal(error.estado, 403);
      assert.match(error.message, /escribe en Canvas/i);
      return true;
    },
  );
  assert.deepEqual(usuario.pedidas, [], "sin permiso explicito no puede llegar al MCP");
});

test("con el permiso explicito si llega, y sin confirm el MCP solo valida", async () => {
  const usuario = usuarioFalso();
  await llamar(usuario, ENTREGAR, { course_id: 1, assignment_id: 2 }, { escribirEnCanvas: true });
  assert.deepEqual(usuario.pedidas, [ENTREGAR]);
  // El paso 1 no manda `confirm`: es el propio MCP el que entonces solo valida.
  assert.ok(!("confirm" in usuario.argumentos[0]));
});

test("una herramienta que no esta en la lista se rechaza con 400", async () => {
  const usuario = usuarioFalso();
  await assert.rejects(
    () => llamar(usuario, "canvas_borrar_todo"),
    error => {
      assert.equal(error.estado, 400);
      assert.match(error.message, /no permitida/i);
      return true;
    },
  );
  assert.deepEqual(usuario.pedidas, []);
});

test("lo que necesitan las guias si esta permitido", async () => {
  // Si alguien saca una de estas dos de la lista, las guias dejan de armarse y
  // conviene que lo diga un test y no una demostracion.
  assert.ok(HERRAMIENTAS_PERMITIDAS.has("canvas_study_sources"));
  assert.ok(HERRAMIENTAS_PERMITIDAS.has("canvas_write_study_guide"));

  const usuario = usuarioFalso();
  await llamar(usuario, "canvas_study_sources", { course_id: 1 });
  await llamar(usuario, "canvas_write_study_guide", { course_id: 1 });
  assert.deepEqual(usuario.pedidas, ["canvas_study_sources", "canvas_write_study_guide"]);
});

test("entregar es la unica que escribe en Canvas, y esta nombrada como tal", () => {
  assert.deepEqual([...HERRAMIENTAS_QUE_ESCRIBEN_EN_CANVAS], [ENTREGAR]);
  // Esta permitida, pero estar permitida no alcanza: ver el test del guardian.
  assert.ok(HERRAMIENTAS_PERMITIDAS.has(ENTREGAR));
});

test("el listado que se expone la muestra, porque es para auditar", async () => {
  const herramientas = await listarHerramientas(usuarioFalso());
  const nombres = herramientas.map(h => h.nombre);
  assert.ok(nombres.includes("canvas_study_sources"));
  // Ocultarla del listado no la haria mas segura, solo menos visible.
  assert.ok(nombres.includes(ENTREGAR));
});

test("lo que puede ver un modelo es un subconjunto estricto de lo permitido", () => {
  for (const herramienta of HERRAMIENTAS_DEL_AGENTE) {
    assert.ok(
      HERRAMIENTAS_PERMITIDAS.has(herramienta),
      `${herramienta} se le ofrece al modelo pero no esta permitida`,
    );
  }
  assert.ok(HERRAMIENTAS_DEL_AGENTE.size < HERRAMIENTAS_PERMITIDAS.size);
});

test("un modelo no puede entregar tareas ni escribir la guia", () => {
  /*
   * Las dos exclusiones que sostienen lo que promete este repo, y por motivos
   * distintos: entregar escribe en Canvas y no se deshace; escribir la guia
   * pondria las citas en manos del modelo, y toda la auditabilidad depende de
   * que las ponga el codigo.
   */
  assert.ok(!HERRAMIENTAS_DEL_AGENTE.has(ENTREGAR));
  assert.ok(!HERRAMIENTAS_DEL_AGENTE.has("canvas_write_study_guide"));

  // Y tampoco las que se demoran minutos de red sin que nadie las haya pedido.
  for (const lenta of ["canvas_sync_course", "canvas_sync_all_courses", "canvas_download_course_files"]) {
    assert.ok(!HERRAMIENTAS_DEL_AGENTE.has(lenta), `${lenta} no la dispara un modelo`);
  }
});

test("el listado del agente trae el esquema, que es lo que necesita tool_calls", async () => {
  const herramientas = await listarHerramientas(usuarioFalso(), { soloDelAgente: true });
  const nombres = herramientas.map(h => h.nombre);
  assert.deepEqual(nombres, ["canvas_study_sources"], "del handler falso, solo esa es del agente");
  assert.equal(herramientas[0].esquema.type, "object");
});

test("un 401 de Canvas se traduce a sesion vencida, no a error de la plataforma", async () => {
  // Es la diferencia entre "renueva tu cookie" y una pantalla en blanco.
  const usuario = {
    id: "prueba",
    handler: async () => ({ result: { isError: true, content: [{ text: "Canvas respondio 401" }] } }),
  };

  await assert.rejects(
    () => llamar(usuario, "canvas_test_connection"),
    error => {
      assert.equal(error.estado, 401);
      assert.equal(error.sesionVencida, true);
      return true;
    },
  );
});
