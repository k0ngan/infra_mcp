/**
 * El limite que define a esta plataforma: lee Canvas y escribe en tu vault,
 * pero no escribe en Canvas.
 *
 * `canvas.mjs` ya decia que la herramienta prohibida estaba "nombrada para que
 * se vea en el codigo y en los tests". Estos son esos tests. No hay red: el
 * handler del MCP es de mentira y solo registra lo que le piden.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  HERRAMIENTAS_PERMITIDAS,
  HERRAMIENTA_PROHIBIDA,
  llamar,
  listarHerramientas,
} from "../web/src/canvas.mjs";

/** Un MCP de mentira que apunta lo que le pidieron y contesta que si. */
function usuarioFalso() {
  const pedidas = [];
  return {
    pedidas,
    id: "prueba",
    handler: async mensaje => {
      if (mensaje.method === "tools/list") {
        return {
          result: {
            tools: [
              { name: "canvas_study_sources", description: "busca pasajes" },
              { name: "canvas_write_study_guide", description: "escribe la guia" },
              { name: HERRAMIENTA_PROHIBIDA, description: "entrega una tarea" },
            ],
          },
        };
      }
      pedidas.push(mensaje.params.name);
      return { result: { structuredContent: { ok: true } } };
    },
  };
}

test("entregar una tarea esta prohibido y ni siquiera llega al MCP", async () => {
  const usuario = usuarioFalso();
  await assert.rejects(
    () => llamar(usuario, HERRAMIENTA_PROHIBIDA, { assignment_id: 1 }),
    error => {
      assert.equal(error.estado, 403);
      assert.match(error.message, /no entrega tareas/i);
      return true;
    },
  );
  assert.deepEqual(usuario.pedidas, [], "la herramienta prohibida no puede llegar al MCP");
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

test("la herramienta prohibida no esta en la lista de permitidas", () => {
  assert.ok(!HERRAMIENTAS_PERMITIDAS.has(HERRAMIENTA_PROHIBIDA));
});

test("el listado que se expone deja fuera la prohibida", async () => {
  const herramientas = await listarHerramientas(usuarioFalso());
  const nombres = herramientas.map(h => h.nombre);
  assert.ok(nombres.includes("canvas_study_sources"));
  assert.ok(!nombres.includes(HERRAMIENTA_PROHIBIDA));
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
