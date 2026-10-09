# Contexto para continuar con Parte 2 de Banana Bank

El proyecto es el challenge de Banana Bank: preparar un asistente bancario fiable para su lanzamiento y desarrollar después una mejora útil y diferenciadora del agente. Parte 1 está cerrada. Las correcciones posteriores de usabilidad ya están integradas en `main`. La rama activa es `part-2`; su funcionalidad todavía está pendiente de definición con el usuario.

## Research inicial y arquitectura

Al principio se estudió el challenge y su contexto: clientes y operadores ficticios, conversaciones, documentación bancaria, contratos y escenarios de fallo. Se identificaron como prioridades la fiabilidad de las operaciones, la confirmación del cliente, la correspondencia entre lo comunicado y los efectos reales, y la trazabilidad para soporte.

Se dejó documentada la arquitectura: interfaz web y API, agente con herramientas y recuperación documental, integración bancaria, persistencia de la aplicación, telemetría y soporte. El banco en `simulator/` se trata como una dependencia externa; la aplicación accede a él exclusivamente por HTTP. La información operativa del banco y los datos de conversación de la aplicación tienen responsabilidades separadas.

El contexto y la arquitectura están en [el challenge](challenge.md), [los contratos](contracts.md) y [la visión del sistema](system-overview/README.md).

## Parte 1 y contexto heredado

Parte 1 se centró en evitar pagos duplicados, exigir revisión y confirmación explícitas, proteger las aprobaciones y gestionar resultados bancarios inciertos sin atribuir efectos no verificados. Se incorporaron trazas, pruebas y demostraciones reproducibles del antes y el después.

La base del challenge es `684d232`. Parte 1 terminó en `1d9c825`, integrada en `main` y etiquetada como `part-1-complete`, con 37/37 tests, typecheck y build correctos.

Ese fue el handoff recibido al inicio de esta conversación: Parte 1 cerrada, Parte 2 sin definir y una rama limpia, `app-usability-fixes`, destinada a pequeñas molestias de uso sin reabrir el alcance bancario validado.

## Trabajo de esta conversación

Se acordaron y resolvieron cuatro tareas de backlog, cada una en su propio commit:

- **USABILITY-01:** respuestas y campos basados en evidencia. Si faltan datos necesarios del usuario, pedir aclaración; si falta evidencia documental, reconocerlo y ofrecer un siguiente paso útil, sin inventar ni estimar. Los hechos operativos requieren resultados verificados.
- **USABILITY-03:** asociar `Checking…` a la conversación que está procesando el mensaje y evitar que respuestas o errores tardíos se muestren en otra.
- **USABILITY-02:** limitar el asistente al contexto de Banana Bank, su documentación y las operaciones autorizadas. Rechazar cultura general y programación; admitir saludos y aclaraciones. Estas restricciones se aplican mediante instrucciones del modelo.
- **USABILITY-04:** eliminar el cursor de espera de los botones que solo están deshabilitados.

Después se corrigió, en otro commit, la opción permanente «Loading…» del selector de persona para mostrarla únicamente durante la carga.

Se verificaron cinco pruebas live de evidencia, cinco de ámbito, 20 invariantes, tipos y build. El último ajuste del selector pasó typecheck. Las comprobaciones visuales de la interfaz quedaron a cargo del usuario; no se ha registrado su confirmación final. Las reproducciones y validaciones están en [HowToDemo](demo/HowToDemo.md).

## Punto de partida de Parte 2

`main` contiene las cinco correcciones hasta `19e6bc9`, marcado con la etiqueta `app-usability-fixes-complete`. `part-2` nace de ese cierre y añade este handoff. La integración y las etiquetas siguen en local.

El siguiente paso es definir con el usuario la mejora diferenciadora de Parte 2 antes de implementarla, preservando los contratos y las garantías existentes.

Seguir [AGENTS.md](../AGENTS.md): alcance explícito, reproducción y evidencia, cambio mínimo, validación, demo y commit. Consultar las guías locales de Next.js antes de escribir código. Trabajar en el entorno habitual, sin montar otros entornos ni nuevos puertos. Resolver las tareas una a una con commits separados. Cuando el usuario pide tareas, se refiere a backlog, no a crear hilos de Codex.
