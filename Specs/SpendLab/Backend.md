# Backend de SpendLab

El backend ejecuta un workflow pequeño: validar, obtener contexto, comprobar presupuesto, calcular tres escenarios e interpretar la decisión con una única llamada de IA. [Plan](Plan.md) define el alcance y [Frontend](Frontend.md) consume el contrato.

La sección V1 documenta la implementación actual. V1.1 especifica cambios propuestos, pendientes de validación; no describe código ya implementado. La persistencia se analiza aparte y no forma parte del alcance de implementación de V1.1 mientras no se decida expresamente.

## V1 · Implementación actual

### Integración y fuentes

La lógica se mantiene en `src/spend-lab/`: esquemas y tipos compartidos, contexto, motor puro, interpretación y función de workflow. La API existente solo despacha sus dos endpoints al módulo. No se crea un framework de workflows ni una arquitectura adicional.

Se reutilizan `actor`, `sameOrigin`, `HttpError`, `bankRequest`, `openai()`, `config.chatModel` y `traceLog`. El cálculo y los schemas utilizados por la preview no importan filesystem, SQLite, SDK OpenAI ni configuración de servidor. No se modifica `simulator/`, el agente existente o las transferencias.

Se distinguen tres orígenes:

| Origen | Uso                                                                       |
| ------ | ------------------------------------------------------------------------- |
| `bank` | Saldo actual de cuentas y actividad observada por HTTP.                   |
| `demo` | Presupuesto ficticio de Lucía, identificado como hipótesis de demo.       |
| `user` | Precio, motivo, contexto, presupuesto manual, colchón y reventa prevista. |

`GET /v1/accounts` es imprescindible. Los IDs elegidos deben pertenecer a las cuentas devueltas para la sesión. `GET /v1/movements` aporta contexto limitado: se conserva su cobertura de hasta 100 movimientos y fechas reales, sin inferir ingresos recurrentes o un presupuesto mensual completo a partir de descripciones. Si falla solo esta lectura, se indica que no hay histórico disponible y puede continuar el análisis con saldo y presupuesto; si falla cuentas, la evaluación no continúa.

Los movimientos no alimentan una nueva clasificación de gastos ni se suman al saldo o al presupuesto. No se crean históricos sintéticos de cinco meses. Las fechas de los movimientos se mantienen, incluso cuando sean antiguas respecto a la simulación actual.

### Un presupuesto de demo y entrada manual

`fixtures/spend-lab/lucia.json` contiene exclusivamente el presupuesto de Lucía, versión `spend-lab-demo-v1`: ingresos mensuales de 175000 céntimos, esenciales de 90000 y discrecionales de 30000, con ingreso previsto el día 2 y pago esencial agregado el día 25. Sus próximas fechas se generan a partir de hoy, usando la siguiente ocurrencia estrictamente futura de cada día del mes. Son supuestos de demo, no nóminas garantizadas o cargos verificados.

No se modifican seed, setup, reset o tablas. Para los demás clientes no hay presupuesto precargado: se solicita uno manual. Todos pueden corregir el presupuesto mediante los mismos cinco campos:

- `monthlyIncomeCents`: ingreso mensual previsto.
- `monthlyEssentialExpensesCents`: compromisos esenciales mensuales, incluidas cuotas existentes si el usuario las considera.
- `monthlyDiscretionaryExpensesCents`: gasto discrecional mensual previsto.
- `nextIncomeDate`: próxima fecha de cobro; null solo si el ingreso es cero.
- `nextEssentialExpensesDate`: próxima fecha de pago del agregado esencial; null solo si los esenciales son cero.

El usuario confirma que el agregado incorpora sus compromisos conocidos; no se desarrolla un editor de recibos, lista de gastos extra o cálculo de préstamos. El agregado en una fecha es una simplificación visible del modelo. Los discrecionales se distribuyen por días del calendario para construir una proyección comprensible, sin afirmar que ese sea el patrón real de consumo.

El GET devuelve un `demoBudget` para Lucía y null para el resto. El POST recibe `budget: null` para utilizar el de demo o un objeto completo para utilizar el manual, que se etiqueta `user`. Editar cualquier campo de demo lo convierte en presupuesto declarado para esa evaluación, sin modificar el fixture. El saldo inicial siempre procede del banco y suma únicamente las cuentas seleccionadas.

### Fecha actual y cálculo reproducible

Cada petición captura una sola vez el reloj real mediante una dependencia `now(): Date`. El valor por defecto es el reloj del servidor; los tests inyectan una fecha fija. `simulationStartDate` es la fecha UTC actual `YYYY-MM-DD`; no se importa ni se utiliza `referenceDate` documental para iniciar compras.

El horizonte comprende el día inicial y los 90 días siguientes. Reventa y fechas iniciales de presupuesto se validan respecto a esa fecha: la venta entre hoy y el día 60; las próximas fechas mensuales entre hoy y los 31 días siguientes. Compra ahora siempre significa el día inicial; no se añade un selector de fecha de compra.

Las recurrencias conservan el día del mes de su primera fecha declarada y se ajustan al último día de meses cortos. La primera fecha declarada es un evento todavía pendiente, incluso si es hoy; el usuario debe indicar el próximo pago/cobro, no uno ya reflejado en el saldo. No se generan eventos de fechas anteriores al inicio.

Para discrecionales, dividir el importe mensual entero por los días del mes y repartir los céntimos restantes en sus últimos días. Solo se incluyen días del horizonte, incluido el gasto futuro supuesto para hoy. Mostrar este reparto como aproximación del presupuesto, no como movimientos del banco.

El motor utiliza fechas ISO y aritmética UTC. `observedAt` y `evaluatedAt` son timestamps reales. El front muestra la fecha enviada por el servidor; un POST posterior a un cambio de día vuelve a capturar hoy y devuelve su contexto actualizado. Si una fecha declarada ya quedó en el pasado, devuelve error por campo para corregirla.

Dinero en céntimos enteros seguros. Precio y reventa son positivos, hasta 10000000 céntimos como límite técnico del input. Presupuesto mensual admite importes no negativos con ese límite por campo. El colchón es un entero seguro no negativo. Las sumas se validan; las ratios se redondean solo para presentar.

### API y contrato compartido

Se conservan dos endpoints en el catch-all, con `Cache-Control: no-store`, sesión de cliente y 405 para métodos distintos de los previstos. La identidad procede de la cookie, nunca del body.

`GET /api/spend-lab/context` devuelve `userId`, `observedAt`, `simulationStartDate`, `horizonEnd`, cuentas, actividad bancaria y cobertura/disponibilidad, `demoBudget` y versión de demo. La actividad visible puede limitarse a los cinco movimientos más recientes; no requiere una pantalla de histórico adicional.

`POST /api/spend-lab/evaluate` aplica `sameOrigin` y schemas Zod estrictos. Input:

| Campo              | Contrato                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------- |
| `purchase`         | `{amountCents, motive, context}`; móvil como categoría fija.                                            |
| `purchase.motive`  | `replace_broken`, `work_study`, `upgrade` o `treat`.                                                    |
| `purchase.context` | Texto opcional de hasta 1000 caracteres; puede explicar qué móvil tiene y qué problema quiere resolver. |
| `accountIds`       | IDs sin duplicados de las cuentas propias elegidas; máximo 12.                                          |
| `budget`           | Null para el presupuesto de demo, o los cinco campos del presupuesto manual.                            |
| `reserveCents`     | Entero no negativo o null si falta fijarlo.                                                             |
| `resale`           | Null o `{amountCents, date}`, aportados por el usuario.                                                 |

El POST vuelve a consultar el banco. No acepta saldos, fecha de inicio, trayectorias o diagnósticos calculados por el navegador. El presupuesto y la venta previstos son inputs de simulación, no hechos bancarios.

Con HTTP 200 se devuelve `needs_input` para cuentas, presupuesto o colchón ausentes, sin llamar al modelo; o `complete` con input normalizado, contexto actualizado, baseline, tres escenarios, métricas, metodología y `assessment`. Todas las respuestas incluyen `runId` y `userId`.

Errores de forma, fechas e importes: 400 con campo asociado; sesión: 401; rol, origen o cuenta ajena: 403; forma inválida de cuentas bancarias: 502; indisponibilidad/timeout de cuentas: 503/504. Los errores de IA no eliminan cálculos válidos: `assessment.status: 'unavailable'` identifica la causa y permite reintentar. Un fixture propio inválido es un fallo de configuración; un cliente sin fixture necesita presupuesto manual.

### Tres escenarios y sacrificios calculados

El baseline muestra el presupuesto sin cambiar de móvil; es una referencia de gráfica, no una cuarta alternativa interactiva. Se calculan:

1. `buy_now`: pagar el precio hoy sin contar con ingresos de reventa. Así se ve el desembolso y el colchón que exige comprar de inmediato.
2. `sell_first`: cobrar la venta prevista y después comprar el mismo día. Solo disponible si el usuario declara importe y fecha; depende de vender y cobrar antes. La venta no se acredita en el saldo inicial ni en los otros escenarios.
3. `wait`: primer día entre mañana y el día 60 en que pagar sin reventa mantiene liquidez durante todo el horizonte y el colchón desde la compra. Si no existe, se muestra que no hay fecha viable dentro del horizonte.

No se añade una variante separada de comprar y vender después. La comparación se limita a estas tres historias. Mover la fecha de venta desplaza compra y cobro de `sell_first` y recalcula sus efectos.

Saldo por evento: `saldo anterior + ingreso - gasto`. Se evalúan también saldos entre eventos: el cierre diario no puede ocultar un negativo intradía. Orden conservador: compromisos, compra e ingresos previstos; en `sell_first`, su venta se coloca inmediatamente antes de su compra. El orden es una hipótesis declarada, no un horario bancario verificado.

Cada escenario devuelve disponibilidad, fecha de compra, eventos, trayectoria, mínimo de todo el horizonte, mínimo desde la compra, saldo final y flags. Clasificación: `cash_shortfall` si hay cualquier saldo negativo; en caso contrario, `reserve_breach` si el mínimo posterior al pago cruza el colchón; si no, `within_limits`. Los problemas anteriores a la compra se muestran como preexistentes y se comparan con el baseline. Un escenario negativo o que compromete el colchón no puede presentarse como compatible con las condiciones elegidas.

El colchón sugerido es tres meses de gastos esenciales, visible y editable; el POST usa el valor aceptado por el usuario, incluido cero explícito. Es una orientación metodológica, no una política del banco ni una frontera universal de responsabilidad.

Para que el análisis explique sacrificios se calculan también:

- Margen mensual: ingresos menos esenciales y discrecionales del presupuesto declarado o de demo.
- Desembolso de renovación: precio, descontando reventa únicamente en `sell_first`, condicionado a cobrarla. No se presenta como rentabilidad del móvil.
- Margen sacrificado: desembolso no negativo dividido por margen mensual positivo, expresado como equivalencia en meses; null si el margen no es positivo. No promete una fecha de recuperación.
- Protección restante: diferencia frente al colchón y meses de esenciales cubiertos por el mínimo no negativo; null si los esenciales son cero.

Estas métricas y los flags se entregan a la IA con identificadores de evidencia. No se calcula una puntuación moral, una probabilidad de venta o un beneficio económico atribuido al móvil.

### Una llamada de IA con valor propio

La IA debe elaborar tres cosas que la gráfica no explica por sí sola: qué pretende conseguir la persona con el móvil, qué margen o protección está sacrificando y qué reflexión específica le ayuda a decidir. Puede proponer comprar, vender primero, esperar o conservar el móvil actual, según los datos y el motivo.

El input incluye motivo y contexto del usuario, presupuesto con procedencia, métricas y escenarios del motor, cobertura del histórico y una metodología breve versionada. Un móvil que falla para trabajar y uno que se quiere renovar por gusto pueden justificar lecturas distintas con las mismas cifras, sin suponer nuevos ingresos o funcionalidades del producto.

Salida estructurada: `headline`, `motiveInterpretation`, `preferredScenarioId` nullable, `recommendation`, entre uno y dos `financialTradeoffs` y una `reflectionQuestion` obligatoria. Cada tradeoff referencia métricas/evidencias de esa evaluación. Límites: headline 100 caracteres, interpretación y recomendación 400 cada una, tradeoff 250 y pregunta 200. La preferencia referencia `baseline`, `buy_now`, `sell_first` o `wait` disponibles.

La interpretación distingue declaraciones del usuario de hipótesis. Puede decir que un cambio facilitaría una necesidad descrita; no afirma que aumentará ingresos, ahorrará horas o mejorará satisfacción sin evidencia. Si el contexto no identifica una necesidad concreta, la pregunta de reflexión explora ese punto en vez de rellenarlo. No inventa otro objetivo de ahorro que el usuario no haya mencionado.

Ejemplo de comportamiento esperado: con motivo de disfrute, explicar que es legítimo querer el móvil y concretar el margen que consume; con necesidad de trabajo, valorar esa necesidad y contrastar la urgencia con esperar o vender primero. La pregunta debe conectar con ese caso, no limitarse siempre a “¿realmente lo necesitas?”.

Se usa `openai().responses.parse()` con `zodTextFormat`, `config.chatModel`, `store: false`, esfuerzo bajo, máximo 1800 tokens, timeout de 30 segundos y cero reintentos para esta llamada. No se cambian defaults del cliente compartido. Una evaluación suficiente realiza una llamada; sin datos suficientes, ninguna. No hay loop de reparación, navegación o tools elegidas por el modelo.

Validar schema, referencias de evidencia y escenario preferido. El esquema enviado al modelo restringe los IDs de evidencia y las preferencias a los válidos para esa evaluación: conservar el móvil y alternativas de compra disponibles dentro de los límites. Cada métrica incluye unidades y significado; la diferencia positiva frente al colchón significa excedente, la negativa déficit. No aceptar una recomendación de compra que el motor marque como incompatible. La validación estructural no demuestra la corrección de toda frase libre: se comprueba además contenido con pruebas y revisión de demo. Refusal, timeout, incompatibilidad de formato, error del proveedor o output inválido dejan cifras y flags disponibles, sin fingir un análisis personalizado. [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses).

El conocimiento propio incluye resúmenes cortos y fuentes de [flujo de caja del CFPB](https://files.consumerfinance.gov/f/documents/cfpb_your-money-your-goals_cash_flow_budget_tool_2018-11_ADA.pdf), [colchón del Banco de España](https://clientebancario.bde.es/f/webcb/RCL/ActualidadEducacionFinanciera/EducacionFinanciera/QueSeHace/Actividades/02_Ahorro_y_objetivos.pdf), [bienestar financiero del CFPB](https://www.consumerfinance.gov/consumer-tools/financial-well-being/about/) y [elección bajo presupuesto de OpenStax](https://openstax.org/books/principles-economics-2e/pages/2-1-how-individuals-make-choices-based-on-their-budget-constraint). Son criterios y referencias externas, no condiciones de Banana Bank ni validación científica del algoritmo. No se modifica el corpus o índice RAG ni se necesita búsqueda web en runtime.

### Validación y trazas

Reutilizar `traceLog` con scope `spend-lab`, runId, actor, duración, versión de demo/metodología, flags y estado del análisis. No se crean conversaciones, intents, aprobaciones, tablas, workers o runs durables. El resultado y las trazas relacionan la solicitud; no se desarrolla historial de decisiones.

Pruebas con `node:test` y dependencias inyectables, sin nuevos puertos:

- Reloj actual e inyectado, cambio de mes/día y fechas independientes de `referenceDate`; ningún evento proyectado queda antes del inicio.
- Céntimos y sumas, pagos antes de cobro, mínimo intradía, colchón exacto o comprometido y presupuesto de margen cero.
- Las tres alternativas, venta hipotética, espera sin fecha viable y problemas que ya estaban en baseline.
- Lucía con demo y otros clientes manuales; fuentes diferenciadas e históricos no reaplicados.
- Sesión, titularidad y errores bancarios; histórico no disponible sin inventarlo y saldo obligatorio.
- Una llamada de IA, ausencia de llamada con datos incompletos, output inválido y fallback.
- Dos motivos distintos con las mismas cifras: lectura y reflexión contextualizadas, tradeoffs ligados a métricas y ningún beneficio inventado.
- Ausencia de POST bancarios y escrituras en conversaciones, intents o aprobaciones.

Fixture de ejemplo con fecha fija `2026-10-09`: saldo 300000, ingresos mensuales 200000 con próximo cobro el 20, esenciales 80000 con próximo pago el 10, discrecionales cero, móvil 100000 y colchón 150000. Comprar hoy tiene mínimo de 120000. Vender por 50000 el día 16 y comprar después mantiene mínimo de 170000. Esperar encuentra el día 21: el cobro del 20 no puede financiar una compra que el orden conservador coloca antes de ese cobro. El test recorre los 90 días completos, no solo el primer mes.

## V1.1 · Cambios propuestos, sin implementación

### Contrato de compra concreto y compatibilidad

Se conservan `GET /api/spend-lab/context` y `POST /api/spend-lab/evaluate`, autenticación, validaciones financieras, estados `needs_input`/`complete` y fallback. No se crean rutas por categoría ni otro workflow.

El nuevo input de `purchase` incorpora dos campos:

| Campo                              | Regla V1.1                                                                                                                                                                           |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `category`                         | Enum `mobile`, `computer`, `gaming`, `other_tech`. Corresponden a móviles, ordenadores, gaming/consolas y otros dispositivos tecnológicos.                                           |
| `productName`                      | Texto declarado, trim, de 1 a 160 caracteres. Puede ser modelo exacto o una descripción concreta: “portátil para edición que estoy valorando”. Sin catálogo ni verificación externa. |
| `amountCents`, `motive`, `context` | Conservan las reglas V1: precio positivo, cuatro motivos y contexto opcional de hasta 1000 caracteres.                                                                               |

La nueva interfaz exige categoría y producto. Para preservar las solicitudes válidas de V1, el schema compartido acepta también la forma anterior sin ninguno de esos campos: se normaliza como `category: 'mobile'`, `productName: null`, sin inventar un modelo. Si llega cualquiera de los campos nuevos, se exige la pareja completa; no se convierte una categoría inválida o un nombre vacío en una petición legacy. Las claves desconocidas siguen rechazándose. No hace falta versionar la URL; los tests V1 conservan sus payloads y resultados.

Los tipos normalizados deben llevar esos campos hasta respuesta y `buildInterpretationInput`. El schema de entrada del cálculo compartido debe admitir los metadatos normalizados; el algoritmo de `engine.ts` sigue usando importe, saldo, presupuesto, colchón y venta. No se introducen reglas financieras por categoría. Precio/motivo/contexto de una solicitud V1 mantienen el mismo comportamiento; los nuevos clientes envían la forma V1.1 completa.

### Evidencia bancaria para preparar el presupuesto

`context.ts` conserva la lectura HTTP de cuentas y movimientos, titularidad y separación de fuentes. Antes de reducir la actividad visible a cinco movimientos, una función pura resume todos los movimientos válidos devueltos, como máximo 100. No consulta SQLite del simulador, no genera filas ni utiliza importes específicos por cliente.

El contexto se amplía con `budgetEvidence`, identificado como `source: 'bank'`, con cobertura y grupos por cuenta/mes UTC. Cada grupo contiene `accountId`, `month` (`YYYY-MM`), `creditsCents`, `debitsCents` (magnitud positiva), `movementCount`, `from` y `to`. Solo se crean grupos con movimientos observados; la ausencia de un mes no se convierte en un mes de gasto cero. Sumas en céntimos seguros; si no se pueden resumir con fiabilidad, la evidencia se marca no disponible sin sustituirla por demo.

La cobertura conserva disponibilidad, límite, conteo, fechas y posible truncamiento del histórico. `available` significa que la lectura fue válida, no que el mes esté completo. La selección de cuentas determina qué grupos se muestran y cuáles se incluyen en el payload del LLM; el límite de 100 se aplica a la lectura conjunta del cliente y puede dejar fuera movimientos de las cuentas elegidas. El POST refresca el resumen junto con el resto del contexto.

Entradas/salidas observadas no se llaman nómina/gastos de consumo: pueden incluir saldo de apertura y transferencias. No se deduce su naturaleza por palabras en `description` ni se reconstruyen transferencias incompletas. Se muestran estas limitaciones. No hay promedios mensuales extrapolados, detector de recurrencias, clasificación con IA o fechas futuras deducidas del histórico.

La evidencia ayuda a revisar los mismos cinco campos V1, pero no los sustituye ni se suma otra vez a la proyección. Esos campos son un presupuesto previsto `user`, confirmado por el cliente. Se conservan importes cero explícitos y las reglas de próximas fechas. Si faltan cuentas, presupuesto o colchón, `needs_input` impide interpretar; un histórico vacío o no disponible no impide calcular con saldo y presupuesto suficientes.

`demoBudget` puede seguir ofreciéndose exclusivamente para Lucía como ejemplo opcional. Su ausencia o invalidez no debe bloquear contexto bancario ni una evaluación con presupuesto declarado: se identifica el ejemplo como no disponible. Un null sin ejemplo válido solicita presupuesto. El recorrido nuevo no envía `budget: null` por defecto: envía el presupuesto revisado. Cargar explícitamente el ejemplo válido mantiene el comportamiento V1 de null/demo; editarlo produce un objeto/user. Para cualquier otro cliente null sigue devolviendo `needs_input`. Se conserva el contrato válido sin crear perfiles ni defaults hardcodeados. La API usa el actor, no una lista fija de ocho IDs, para dar acceso a todos los clientes existentes.

### Interpretación más útil dentro del mismo workflow

El pipeline sigue siendo validación → contexto → gate → cálculo → interpretación → validación de salida. La única ampliación de contexto es producto/categoría y evidencia observada; no se añade un step de clasificación o de investigación del producto.

`buildInterpretationInput` envía categoría, nombre, precio, motivo y contexto declarado, presupuesto y fuentes, escenarios, métricas con IDs y significado, cobertura y resumen bancario de las cuentas elegidas. Se conserva la exclusión de IBAN, identidad y trayectorias completas del payload del modelo. Si el resumen se utiliza para una afirmación numérica, debe tener un ID de evidencia bancaria propio; no se mezcla con las métricas del presupuesto ni se presenta como previsión.

Se conserva la salida estructurada actual, sin añadir campos que repitan su contenido:

| Campo de salida                         | Responsabilidad en V1.1                                                     |
| --------------------------------------- | --------------------------------------------------------------------------- |
| `headline`                              | Introducir la decisión sobre el producto, sin dictar un juicio moral.       |
| `motiveInterpretation`                  | Qué busca comprar, por qué y qué utilidad podría tener según lo contado.    |
| `financialTradeoffs`                    | Una o dos consecuencias financieras verificables, con evidencia.            |
| `preferredScenarioId`, `recommendation` | Explicar qué alternativa encaja y qué otras opciones condicionales valorar. |
| `reflectionQuestion`                    | Pregunta concreta sobre la utilidad, urgencia o sacrificio de este caso.    |

Se actualizan instrucciones y significados que hoy dicen “phone”. `baseline` pasa a significar no realizar esta compra; no presupone que ya se tenga un producto equivalente. Reventa significa vender un dispositivo que la persona declara tener, sin asumir que está reemplazando uno. Los textos del usuario, incluidos nombre de producto y descripciones bancarias, son datos no confiables, nunca instrucciones.

El nombre de un modelo no autoriza afirmar especificaciones, compatibilidad, rendimiento, precio de mercado, descuentos o reventa. Tampoco se infieren profesión, ingresos futuros, satisfacción o disponibilidad de otro dispositivo. Si la persona declara que su ordenador falla al trabajar, se valora ese problema como declaración; no se promete que comprar el propuesto lo resuelva. Si solo escribe “quiero una consola”, se pregunta sobre el uso esperado sin inventarlo.

Las alternativas numéricas siguen restringidas a las disponibles y compatibles con el motor. Conservar algo que el usuario dice tener, explorar reparación o una opción más económica son ideas condicionales, sin costes, ahorros o escenarios calculados adicionales. No se ofrece financiación. El disfrute sigue siendo un motivo válido y los problemas financieros preexistentes permanecen visibles.

Se reutilizan `responses.parse`, modelo configurado, `store: false`, límites actuales, una llamada y cero reintentos. Se conservan IDs válidos, preferencias compatibles y fallback. Los límites actuales permiten una reflexión breve; primero se mide la calidad con ejemplos antes de proponer otro modelo, más tokens, otra llamada o un loop. El esquema no certifica la verdad de frases libres: las pruebas y la revisión deben comprobar personalización y ausencia de datos inventados.

### Superficie de cambio y pruebas

Cambios previstos: `contracts.ts` (compra raw/normalizada y evidencia), `context.ts` y un helper puro de resumen si hace falta, adaptación mínima de `budget.ts`/`workflow.ts` para los tipos, `interpretation.ts` y tests de SpendLab. `engine.ts` solo adapta validación/tipos si lo requiere el contrato ampliado; sus reglas y cifras no cambian. No se modifica auth, catch-all fuera del despacho existente, simulador, agente, SQLite o transferencias.

- Mantener escenarios y payloads legacy de V1; misma proyección al cambiar únicamente categoría, nombre, motivo o contexto.
- Evaluar para todos los clientes de `src/people.ts`, sin presupuesto de demo, mediante lecturas bancarias inyectadas y presupuesto declarado. No crear fixtures de perfiles para cada persona.
- Resumen con movimientos reales parciales, antiguos, apertura, transferencias, cuentas seleccionadas, límite global, mes ausente y fallo exclusivo de histórico. Sin inferir nómina ni duplicar movimientos proyectados.
- Categorías válidas, nombre vacío/largo, pareja incompleta, campos desconocidos y producto enviado íntegro al modelo. Motivo sin beneficio declarado produce una pregunta, no una característica inventada.
- Mismos números para ordenador con necesidad laboral declarada y móvil por disfrute: lectura/pregunta distintas; gaming y otros dispositivos con utilidad personal contextualizada. Incluir un caso sin dispositivo anterior y otro con contexto escaso.
- Una llamada o ninguna cuando falten datos; fallback y preferencias compatibles. Las pruebas deterministas verifican contrato/payload/reglas; una evaluación con el modelo real y revisión humana comprueban el contenido, sin presentarlo como garantía universal.

### Historial · Propuesta separada, pendiente de decisión

V1 y la propuesta base V1.1 no guardan decisiones. `runId` y logs no son almacenamiento recuperable; el workflow no abre `appDb()` y la salida del modelo utiliza `store: false`. No hay endpoints para listar, recuperar o comparar.

Si se aprueba un historial posterior, se reutilizaría la SQLite de la aplicación con una tabla específica de evaluaciones y acceso por `user_id`. Esto modifica `src/db.ts`, añade un repositorio en `src/spend-lab/`, rutas autorizadas de lista/detalle y el guardado del resultado completo en el workflow. No se escribe en el banco ni se reutilizan tablas de runs conversacionales, conversaciones, mensajes, intents o aprobaciones.

El registro mínimo necesitaría ID, cliente, fecha de evaluación, versión de contrato/cálculo/metodología/prompt y modelo, input normalizado y snapshot de saldo seleccionado, presupuesto, fechas, cálculo y assessment. Guardar solo input y texto de IA no permite consultar las cifras originales si cambian saldo o algoritmo. Debe almacenarse solo el contexto necesario, evitando copiar IBAN y toda la actividad del cliente. Un resultado `complete` con IA no disponible también puede ser consultable; `needs_input` y previews no son decisiones completas. Política de guardado pendiente, sin implementarla aquí.

Cada lectura se filtra por actor; una referencia a otra persona no revela su decisión. Recuperar reutiliza inputs editables, comprueba propiedad actual de las cuentas y refresca saldo/reloj; obliga a revisar fechas pasadas y supuestos. La nueva evaluación no sobrescribe la anterior. Un vínculo al registro original permitiría comparar ambas sin tratar el snapshot antiguo como actual.

La comparación mínima puede devolver precio, saldo, presupuesto, colchón, fechas, métricas y análisis de ambos registros, mostrando cambios de condiciones y versión. No requiere otra llamada al modelo ni superponer curvas con fechas distintas. La consulta histórica no necesita recalcular ni pagar una llamada. No se garantiza reproducir literalmente la antigua reflexión al reevaluar.

Complejidad adicional media: schema/compatibilidad de registros, autorización, errores de escritura, retención/borrado, recuperación de datos obsoletos y pruebas de aislamiento/comparación. Habría que definir también qué hace reset con la tabla nueva sin alterar el comportamiento existente por accidente. Un fallo de guardado debe distinguirse de un fallo de evaluación; este estado nuevo necesita contrato e interfaz.

Recomendación: entregar primero V1.1 sin persistencia y considerar el historial como V1.2. Pendientes de aprobación: adelantarlo o posponerlo, guardado explícito/automático, snapshot y versiones, retención/borrado y comparación en la primera entrega o después. No se añaden tabla, dependencia, endpoint o cambio de reset antes de cerrar esas decisiones.
