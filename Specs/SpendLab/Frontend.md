# Frontend de SpendLab

SpendLab presenta la compra de un móvil, su efecto sobre el presupuesto y una reflexión personalizada. El recorrido conserva la estética de Banana Bank y utiliza los contratos de [Backend](Backend.md) y el alcance de [Plan](Plan.md).

V1 describe la interfaz actual. V1.1 amplía categorías, producto y revisión del presupuesto sin sustituir el recorrido existente. Es una propuesta pendiente de validación; este documento no implica que esos cambios o un historial estén implementados.

## V1 · Interfaz actual

### Integración pequeña

Añadir `Spend Lab` al menú de cliente después de Assistant, con un icono SVG del sistema actual. `app/page.tsx` monta la sección; los componentes propios mantienen formulario, contexto, gráfica y análisis dentro de `app/components/spend-lab/`. No se cambian las otras pestañas, la navegación de operadores ni los flujos de chat o transferencias.

Usar colores, tipografía, tarjetas, botones y focos existentes. Clases CSS con prefijo `spend-lab-`, sin redefinir reglas globales. Mantener inglés y EUR; no añadir librerías de gráficos o UI. La gráfica se construye con SVG y el cálculo puro compartido.

El estado pertenece a la sección, sin reutilizar `busy`, `pendingChat` o errores del chat. Salir de la pestaña o cambiar de persona desmonta y descarta la evaluación local. No hay persistencia, historial de decisiones ni localStorage.

### Formulario y presupuesto

Encabezado `Spend Lab`, subtítulo `Think through your next phone`. La compra es un móvil: no hay selector de categorías, marcas o fecha de compra. El producto muestra hoy desde `simulationStartDate` del servidor; no hereda la fecha fija del Overview o del sistema documental.

El primer bloque tiene:

| Campo                  | Control                                                                                       |
| ---------------------- | --------------------------------------------------------------------------------------------- |
| Precio del nuevo móvil | Importe obligatorio en euros, con dos decimales. Conversión de texto decimal a céntimos.      |
| Motivo                 | Selección única: Replace something broken, Work or study, Upgrade, Just for enjoyment.        |
| Contexto               | Texto opcional: qué móvil tiene, qué le falta y qué espera del nuevo. Máximo 1000 caracteres. |

Motivo sin preselección. El contexto es una ayuda breve para personalizar el análisis, no una conversación. No exigir modelo anterior, antigüedad, precio original o especificaciones técnicas.

La carga de contexto empieza al entrar. Tras `Continue`, un segundo bloque compacto muestra cuentas, presupuesto y colchón:

- Cuentas propias y saldo actual como checkboxes; selección explícita de al menos una y total visible. Ahorros solo cuentan al seleccionarlos.
- Para Lucía, cinco campos de presupuesto precargados con badge `Demo budget`. Para el resto, los mismos campos vacíos para completar manualmente.
- Ingreso mensual, esenciales, discrecionales y próximas fechas de cobro y pago esencial. Se muestran como previsiones; gastos esenciales son un agregado mensual, no un listado de recibos.
- Colchón editable con sugerencia visible de tres meses de esenciales y explicación corta. Usar el valor aceptado, incluido cero explícito. Cambiar presupuesto no sustituye silenciosamente un colchón que el usuario ya eligió.
- Venta opcional del móvil anterior: importe esperado y fecha de cobro, sin valores inventados. Sin venta declarada se envía `resale: null` y `Sell first` no está disponible. Si se activa esta opción, ambos campos son obligatorios antes de evaluar.

Editar el presupuesto de Lucía lo identifica como `Your budget assumptions` para esa evaluación. El resto de clientes también usa ese origen; no se muestran como datos bancarios. Se permite ingreso cero sin pedir fecha de cobro, y esenciales cero sin pedir fecha de pago. No hay editores de gastos individuales, gastos extra, histórico ficticio ni paneles de configuración secundarios.

El presupuesto puede incluir cuotas u otros compromisos existentes dentro de esenciales; no se promete detectar toda la situación financiera del cliente. Una ayuda pide incorporar los gastos conocidos pendientes para que las hipótesis tengan sentido.

`Evaluate purchase` valida y envía el input. La evaluación usa hoy; la fecha introducida para reventa o presupuesto no cambia la fecha de inicio. Los rangos de fechas se toman del servidor. Si cambia el día durante el recorrido, se actualiza contexto o se muestra el error por fecha para corregirla, sin reutilizar una fecha de inicio antigua.

### Gráfica y tres alternativas

El resultado reúne una gráfica amplia y tres tarjetas: `Buy now`, `Sell first` y `Wait`. El baseline sin comprar puede mostrarse como línea neutra de referencia, sin una cuarta tarjeta o recorrido. No hay comparación adicional de comprar y vender después.

La gráfica utiliza el mismo horizonte de 90 días y escala para todos los escenarios, muestra la línea del colchón y curvas escalonadas de saldo. Se representan los eventos y mínimos intradía; no se suavizan caídas que pueden producir falta de liquidez. Las tarjetas muestran fecha efectiva, mínimo, colchón y dependencia de hipótesis.

`Buy now` paga hoy sin contar con reventa. `Sell first` cobra el importe previsto y compra después; su tarjeta indica esa condición. `Wait` muestra la primera fecha compatible calculada o que no existe una dentro del horizonte. Los problemas preexistentes se distinguen del impacto añadido por la compra.

Los controles de precio, colchón, importe de venta y fecha de cobro permiten explorar la gráfica. La fecha de venta se puede mover con un control de días de 0 a 60 desde hoy y un campo de fecha equivalente. No se añaden controles para otras compras o nuevos compromisos.

La preview usa el último contexto validado y el motor compartido, sin llamada al modelo por cada cambio. Al editar, se retira el análisis personalizado anterior y se muestra `Preview — update analysis`. `Update analysis` vuelve a enviar la evaluación completa; el servidor refresca saldo y fecha y sustituye contexto, cifras e interpretación juntos. Inputs incompletos muestran su error, sin conservar cifras que dependan de un dato antiguo.

### Análisis que ayuda a decidir

El análisis se presenta como una tarjeta editorial breve, junto a la comparación, con estos contenidos:

1. **Qué buscas conseguir:** lectura del motivo y contexto, distinguiendo una necesidad descrita de un gusto o una mejora deseada.
2. **Qué sacrificas:** uno o dos tradeoffs concretos ligados al margen mensual, colchón, espera o dependencia de vender.
3. **Qué alternativa encaja:** recomendación con razones, condicionada al presupuesto y al valor personal expresado.
4. **Una reflexión útil:** una pregunta específica del caso, visible sin abrir un chat.

La reflexión no necesita respuesta para terminar el recorrido. El cliente puede ajustar el contexto y volver a evaluar si quiere explorarla. No se implementa un diálogo de preguntas sucesivas.

Un deseo asumible no se condena por ser un capricho. Una necesidad laboral no autoriza inventar mayor productividad o ingresos. La capa personal debe cambiar al cambiar motivo/contexto, aunque la gráfica permanezca idéntica. Las cifras y la clasificación siguen siendo del motor.

`Data and assumptions` permite ver saldo y hora de consulta, origen del presupuesto, actividad bancaria disponible y fuentes metodológicas. No requiere una biblioteca nueva. Si falta histórico se reconoce sin bloquear una evaluación que tenga saldo y presupuesto suficientes.

Si la IA falla, se conservan gráfica, cifras y flags con `Personal analysis unavailable`; no se muestra una pregunta genérica simulando reflexión personalizada. Se puede reintentar con el mismo formulario. No hay scores morales o promesas de compra segura.

### Estados y validación

Estados: `purchase`, `budget`, `evaluating` y `results`, con carga de contexto independiente. Durante el POST hay una evaluación activa y sus inputs quedan bloqueados; cambiar de pestaña o persona sigue permitido. No se añade un botón o subsistema de cancelación propio.

Usar AbortController y contador de solicitudes; solo aplicar respuestas si siguen vigentes componente, actor y revisión. Comprobar `userId` del resultado. Un resultado tardío no navega de vuelta ni aparece en otra persona. No hay streaming o progreso ficticio por etapas.

`needs_input` vuelve al bloque correspondiente y enfoca cuentas, presupuesto o colchón. Los 400 tienen errores por campo; el fallo de saldo bancario permite reintentar sin sustituirlo por demo. La falta de IA tiene fallback numérico diferenciado. Los errores quedan dentro de SpendLab.

La disposición apila gráfica y tarjetas en móvil. Los controles tienen labels, foco y alternativa de teclado; los cambios de estado usan `aria-live`. Las señales combinan texto y color. La gráfica incorpora un resumen textual de fechas y mínimos para no depender del puntero o de la vista; no se desarrolla una tabla completa de eventos en v1.

Recorridos para HowToDemo: Lucía con presupuesto de demo, otro cliente manual, comparación de las tres alternativas, colchón comprometido, preview sin análisis viejo y dos motivos con las mismas cifras que produzcan análisis personales distintos. Añadir cambio de persona/pestaña durante una petición, errores de datos/banco/modelo y revisión en móvil y teclado.

En el cierre se comprueban Overview, Assistant, Transfers, Documents y selector de persona, junto a typecheck, tests y build. No se añaden dependencias de navegador o tests que solo repliquen CSS. La validación visual se hace en la aplicación habitual con el usuario y se registra como realizada u omitida.

## V1.1 · Evolución visual propuesta, pendiente de implementación

### Mismo recorrido, compra concreta

Se conserva `Spend Lab` en el menú y los tres bloques: compra → presupuesto → resultado. El subtítulo pasa a `Think through your next tech purchase`. No se añade chat, otra sección por categoría, buscador o catálogo. Se reutilizan componentes, colores, tipografía, estilos con prefijo, gráfica SVG y estado local.

El primer bloque amplía el formulario:

| Campo     | Control V1.1                                                                                                                                                                                                             |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Categoría | Cuatro opciones visuales de selección única: `Phones`, `Computers`, `Gaming & consoles`, `Other tech`. Sin preselección silenciosa.                                                                                      |
| Producto  | Campo obligatorio `What would you like to buy?`, de 1 a 160 caracteres. Placeholder según categoría: `iPhone 17`, `MacBook Air`, `Nintendo Switch 2`, `Headphones…`. Son ejemplos de texto, no catálogo o recomendación. |
| Precio    | El mismo control en EUR, ahora `Purchase price`; sigue siendo el precio que aporta la persona.                                                                                                                           |
| Motivo    | Los cuatro motivos actuales, sin preselección.                                                                                                                                                                           |
| Contexto  | Opcional, máximo 1000 caracteres. Ayuda contextual: uso esperado, qué falta, qué se tiene ya o urgencia. Sin exigir una ficha técnica.                                                                                   |

El nombre no necesita marca/modelo comercial: una descripción concreta también sirve. No se consulta o autocompleta especificaciones, precio o disponibilidad. Cambiar categoría conserva el texto ya escrito y los otros datos, permite corregirlos y no calcula un precio distinto. La coincidencia entre categoría y producto no requiere un clasificador de IA; los límites de input se validan con el contrato compartido.

La ilustración y textos que hoy hablan de un teléfono se adaptan al dispositivo elegido con SVG/CSS del repositorio, sin assets generados, librerías o animaciones adicionales. Se conserva el protagonismo de las tres alternativas. Los textos de formularios y resultados dejan de presuponer que ya existe un teléfono anterior.

### Presupuesto común para todos los clientes

Al entrar se consultan cuentas, saldo, actividad y evidencia agregada. Todos siguen el mismo bloque de presupuesto. Seleccionar cuentas sigue siendo explícito; no se incluyen ahorros automáticamente. Se muestra un resumen compacto de las entradas y salidas observadas por mes para las cuentas elegidas, con fechas, número de movimientos y advertencia de cobertura limitada.

El resumen se sitúa junto a la ayuda del presupuesto, sin convertirlo en otro dashboard. Etiqueta `Observed bank activity`, no `Your monthly income` o `Your spending forecast`. Las cifras pueden incluir aperturas de cuenta y transferencias; no se presentan como nómina o clasificación de consumo. Un mes sin registros no se muestra como gasto cero. La actividad antigua conserva sus fechas reales, sin desplazarla al mes actual.

Los cinco campos de previsión actuales siguen editables y se confirman antes de evaluar. No se rellenan automáticamente a partir de totales históricos: ingresos futuros, esenciales/discrecionales y próximas fechas necesitan declaración. La ayuda explica que deben incluirse compromisos conocidos; no se abre un editor de gastos individuales. Mantener ceros explícitos, fechas deshabilitadas cuando corresponda y colchón elegido por el usuario.

Lucía utiliza también este recorrido sin depender de su fixture. Si el contexto ofrece `demoBudget`, aparece una acción secundaria `Load Lucía’s demo budget` que carga el ejemplo completo y sus fechas futuras, claramente etiquetado. No se selecciona por defecto. Editarlo lo convierte en `Your budget assumptions`, como en V1. No se ofrece el perfil de Lucía a otros clientes. La sugerencia de tres meses de esenciales se conserva, sin sobrescribir silenciosamente el colchón al cargar o editar datos.

Si no hay histórico, aparece `No observed activity available` y los campos manuales siguen disponibles. Si no hay movimientos en las cuentas elegidas, se explica ese alcance sin afirmar que no hay gastos. Si falla la consulta de saldo, se mantiene el bloqueo y reintento existentes. El resultado y `Data and assumptions` distinguen saldo/actividad bancaria, presupuesto previsto y ejemplo de demo.

### Venta, preview y resultado

La venta opcional pasa a `Sell a device you already own first`. Precio y fecha siguen declarados, sin estimación de mercado ni necesidad de identificar otro producto. Puede financiar la compra vendiendo cualquier dispositivo propio; no se asume reemplazo. Sin venta, `Sell first` permanece no disponible. El backend conserva exactamente su cálculo actual.

Gráfica, horizonte de 90 días, escala común, mínimos intradía, colchón, tarjetas y controles mantienen el comportamiento V1. `Buy now`, `Sell first` y `Wait` comparan el mismo producto/precio declarado. El baseline significa no realizar esta compra; no implica que ya se tenga un equivalente. No se añaden curvas por categoría ni un comparador de modelos o financiación.

En el resultado se muestra categoría y producto evaluados. `Edit budget & reason` permite regresar al formulario y corregir también producto/categoría. Cualquier cambio de producto, categoría, motivo o contexto retira la interpretación anterior; las cifras solo cambian si cambia un input financiero. Se mantiene `Preview — update analysis`. Actualizar envía todos los datos y sustituye contexto, cifras e interpretación juntos.

La tarjeta editorial conserva su estructura:

- `What you’re looking for`: compra concreta, motivo y utilidad según lo declarado, con condiciones si faltan datos.
- `What you give up`: sacrificio de margen/colchón o dependencia de venta/espera, con las cifras del motor.
- Recomendación: alternativa coherente y opciones cualitativas pertinentes, sin precios inventados.
- Pregunta: reflexión específica sobre uso, urgencia o prioridad, sin necesidad de responder en un chat.

El texto debe distinguir un ordenador que se necesita para un problema laboral declarado de un móvil deseado por disfrute, sin inventar prestaciones ni penalizar caprichos. Gaming puede tener utilidad de ocio expresada por el usuario; el análisis no exige rentabilidad financiera. Las ideas de reparar o elegir algo más económico no se muestran como escenarios calculados. El fallback de IA conserva cálculos y reintento, sin simular un consejo personalizado.

### Estados y verificación de V1.1

Se conservan carga de contexto, errores por campo, bloqueo durante POST, AbortController, revisión de solicitud, identidad y desmontaje al cambiar persona o pestaña. Un producto nuevo no recupera texto antiguo mientras llega el análisis. El contexto del ejemplo no aparece en otra persona. No se añaden estados de guardado o lista de decisiones en el alcance propuesto.

La implementación afectará a `SpendLab.tsx`, `form.ts`, estilos/textos propios y el contrato compartido. `ScenarioChart.tsx` solo necesita textos neutrales si los hubiera; se conserva la gráfica. `app/page.tsx` mantiene la integración existente y el core no cambia.

HowToDemo deberá cubrir las cuatro categorías, todos los clientes sin demo obligatoria, histórico limitado/ausente, ejemplo explícito de Lucía, modificación de producto sin alterar cifras y retirada de análisis obsoleto, dos utilidades/motivos distintos, fallback y cambios de persona/pestaña durante POST. Revisar móvil, teclado y las pestañas actuales. Se actualiza cuando se implemente; esta revisión solo edita las tres especificaciones.

### Historial · Diseño posible, pendiente de decisión

Actualmente salir de SpendLab o cambiar de persona elimina el estado local. V1.1 mantiene ese comportamiento mientras no se apruebe persistencia. No se añade localStorage como solución intermedia.

Un historial posterior podría integrarse en SpendLab con una lista compacta de producto, fecha, precio y estado del análisis, un detalle del snapshot y la acción `Re-evaluate with current data`. No requiere reutilizar el chat ni crear otra aplicación. Ver una evaluación antigua mostraría fecha y condiciones originales, con aviso de que el saldo no es actual.

Recuperar una decisión cargaría declaraciones como borrador y consultaría contexto actual. Habría que revisar cuentas que ya no estén disponibles, presupuesto, fechas pasadas y reventa; nunca presentar el resultado antiguo como una evaluación nueva. La nueva decisión tendría su propio registro y podría relacionarse con la anterior.

La comparación inicial más pequeña sería una tabla entre el snapshot original y la nueva evaluación: producto/precio, fechas, saldo, presupuesto, colchón, mínimos y recomendación. Mostraría qué condiciones cambiaron y las versiones utilizadas. No requeriría un LLM comparador ni nuevas gráficas, y no atribuiría toda diferencia a cambiar de producto.

Esto añade carga/lista/detalle, selección de registro, restauración, comparación y errores de guardado, además de autorización y persistencia en Backend. Por esa complejidad se recomienda una entrega posterior V1.2. Quedan por decidir inclusión en V1.1, guardado explícito o automático, retención/borrado y comparación desde la primera entrega. Estos controles no se diseñan como funcionalidad comprometida ni se implementan hasta que el usuario cierre el alcance.
