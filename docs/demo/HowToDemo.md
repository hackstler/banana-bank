# HowToDemo

Chuleta: primero enseñar el fallo en la versión anterior y repetir la petición en la corregida. Importar los `curl` en Postman si se prefiere; conservar la cookie de `/api/session` y sustituir las variables por sus valores.

| Caso                                     | Antes     | Después                                             |
| ---------------------------------------- | --------- | --------------------------------------------------- |
| 1. Transferencia duplicada por retry     | `684d232` | `cbbd64a` o posterior                               |
| 2. Transferencia sin confirmación        | `cbbd64a` | `53e6e5f` o posterior                               |
| 3. Aprobación reutilizable               | `53e6e5f` | `2f40bb6`                                           |
| 4. Intent resuelto que se vuelve a abrir | `af402e0` | `14534be` |
| 5. Fallo al leer la respuesta bancaria | `14534be` | Corrección de lectura de respuesta descrita abajo |

Para comparar con los **mismos intentId**, usar datos de demo nuevos en cada versión. Conservar una referencia ya ejecutada hace que el banco devuelva un replay y no active el fallo. En el caso 4, primero resolver el intent y luego repetirlo **sin limpiar los datos**, porque esa repetición es precisamente lo que comprobamos. Cambiar de profile reinicia el contador, **no** los saldos. No ejecutar `reset` sobre datos que quieras conservar.

## Preparación

Ejecutar desde la raíz del repositorio; Node y curl son suficientes, sin jq ni clave de OpenAI. Para no tocar los datos habituales, arrancar cada versión con una BD nueva y puertos de demo, en una consola de servicios:

```sh
export DATA_DIR=$(mktemp -d "${TMPDIR:-/tmp}/banana-demo-data.XXXXXX")
export BANK_DATA_DIR="$DATA_DIR"
export APP_PORT=3100 BANK_PORT=4101 BANK_URL=http://127.0.0.1:4101
# Copiar la línea que imprime en la consola donde se ejecutarán los curl.
printf 'export DATA_DIR=%q BANK_DATA_DIR=%q APP_PORT=3100 BANK_PORT=4101 BANK_URL=http://127.0.0.1:4101\n' "$DATA_DIR" "$BANK_DATA_DIR"
npm run setup
npm run dev
```

En otra consola, pegar la línea `export` impresa y ejecutar la preparación siguiente. Para cambiar de versión, parar los servicios con Ctrl+C y repetir el arranque con otra BD nueva. Si utilizas tus servicios habituales, omitir el arranque aislado y mantener su configuración; no volver a utilizar un intent de demo ya ejecutado.

```sh
DEMO_APP=$(node --import tsx --input-type=module -e 'import {config} from "./src/config.ts"; process.stdout.write(`http://127.0.0.1:${config.appPort}`)')
DEMO_BANK=$(node --import tsx --input-type=module -e 'import {config} from "./src/config.ts"; process.stdout.write(config.bankUrl)')
DEMO_ADMIN=$(node --import tsx --input-type=module -e 'import {config} from "./src/config.ts"; process.stdout.write(config.adminSecret)')
DEMO_FILES=$(mktemp -d "${TMPDIR:-/tmp}/banana-demo.XXXXXX")

curl -sS -c "$DEMO_FILES/ines.cookies" \
  -H 'Content-Type: application/json' \
  -d '{"userId":"ines"}' "$DEMO_APP/api/session"

# Leer un campo de un JSON: json_field approvalId, intent.bank_reference, etc.
json_field() {
  node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{const v=process.argv[1].split(".").reduce((o,k)=>o?.[k],JSON.parse(s));if(v==null)process.exit(1);console.log(v)})' "$1"
}

# SQLite de la aplicación: lectura, nunca modificaciones ni acceso a la BD del banco.
demo_db() {
  node --import tsx --input-type=module -e '
    import Database from "better-sqlite3"; import path from "node:path"; import {config} from "./src/config.ts";
    const db=new Database(path.join(config.dataDir,"app.sqlite"),{readonly:true});
    const id=process.env.DEMO_INTENT;
    console.log(JSON.stringify({intent:db.prepare("SELECT id,user_id,status,payload,bank_reference,operation_id,error FROM intents WHERE id=?").get(id)??null,
      approvals:db.prepare("SELECT id,intent_id,payload,consumed_at FROM approvals WHERE intent_id=? ORDER BY rowid DESC").all(id)},null,2));db.close();'
}

# Evidencia bancaria: API administrativa de pruebas, no utilizada por la aplicación.
demo_bank() {
  curl -sS -H "Authorization: Bearer $DEMO_ADMIN" "$DEMO_BANK/admin/snapshot" |
    node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{
      const b=JSON.parse(s),ops=b.operations.filter(o=>o.concept===process.env.DEMO_CONCEPT),ids=new Set(ops.map(o=>o.id));
      console.log(JSON.stringify({scenario:b.scenario,accounts:b.accounts.filter(a=>["acc-ines","acc-carla"].includes(a.id)),
        operations:ops,movements:b.movements.filter(m=>ids.has(m.operationId))},null,2));})'
}
```

IDs de cuentas utilizados: `ines`, `acc-ines` → `acc-carla`. Cada pago es de **1000 céntimos / 10 €**. `demo_db` obtiene los IDs de aprobación y referencias realmente persistidos, sin copiarlos a mano.

## 1. Una petición produce dos transferencias

**Qué encontramos / error:** el banco ejecutaba el pago, pero se perdía su respuesta. El retry generaba una referencia nueva dentro del bucle. Para el banco eran dos operaciones distintas; el intent terminaba `completed` con solo la segunda referencia.

**Ensayo:** «Voy a enviar 10 €. El banco ejecutará la operación, pero devolverá un error. Antes, nuestra aplicación interpretaba ese error como motivo para repetir con una identidad nueva: aparecen dos cargos aunque el usuario pidió un solo pago».

### Antes: reproducir y observar

El profile se llama **`lost-response`**, no `Lost Connection`: la primera operación nueva se confirma en el banco y después responde `504`. No depende de que el modelo elija una frase concreta.

```sh
export DEMO_INTENT=demo-duplicate-transfer
export DEMO_CONCEPT=demo-duplicidad
npm run scenario -- lost-response
demo_bank

curl -sS -b "$DEMO_FILES/ines.cookies" \
  -H 'Content-Type: application/json' \
  -d '{"name":"transfer_money","intentId":"demo-duplicate-transfer","arguments":{"fromAccountId":"acc-ines","toAccountId":"acc-carla","amountCents":1000,"concept":"demo-duplicidad"}}' \
  "$DEMO_APP/api/actions" | tee "$DEMO_FILES/duplicidad.json"
```

En `684d232` se ejecuta directamente. En `cbbd64a` también, pero sin duplicidad. En versiones con confirmación, ejecutar además:

```sh
# Solo si la respuesta anterior es requires_confirmation.
DEMO_APPROVAL=$(demo_db | json_field approvals.0.id)
curl -sS -b "$DEMO_FILES/ines.cookies" -X POST \
  "$DEMO_APP/api/approvals/$DEMO_APPROVAL/confirm"
```

Inspección, igual para ambas versiones:

```sh
demo_db
demo_bank
DEMO_REFERENCE=$(demo_db | json_field intent.bank_reference)
curl -sS -b "$DEMO_FILES/ines.cookies" \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"operation_status\",\"arguments\":{\"reference\":\"$DEMO_REFERENCE\"}}" \
  "$DEMO_APP/api/actions"
```

**Antes:** dos operaciones con referencias distintas; saldo origen −2000, destino +2000; dos débitos y dos créditos. Consultar la referencia del intent solo muestra la segunda operación: no basta para demostrar que no hubo duplicidad. La interfaz muestra los dos movimientos.

### Solución y repetición

Repetir los mismos bloques con datos nuevos en la versión corregida y `lost-response` activado otra vez.

**Cambio:** `src/banking/actions.ts` genera y persiste una referencia por intent antes del dispatch. `src/banking/dispatch.ts` recibe esa referencia fuera del bucle y la reutiliza en todos los retries. Una respuesta ambigua se consulta por referencia antes de volver a enviar. Si no puede verificarse, queda `pending_verification`, no un rechazo supuesto.

**Después:** una operación, saldo origen −1000, destino +1000, un débito y un crédito. El intent y la consulta por referencia apuntan al mismo ID bancario. Con `lost-response`, los logs muestran `504` → consulta por referencia → operación verificada; normalmente no hace falta un segundo POST.

Para enseñar un retry que sí se ejecuta, repetir el caso con datos nuevos y `npm run scenario -- reject-before`: primer POST `503`, consulta `404`, segundo POST **con la misma referencia** y una sola operación. En `normal`, la versión original podía aparentar funcionar porque no entraba al retry; `intermittent 17` activa la pérdida en la tercera operación nueva.

### IDs reales del ensayo validado

Mismo `intentId`: `demo-duplicate-transfer`; saldo inicial de Inés: `591050`.

| Versión                  | Operación bancaria                     | Referencia                             | Saldo final |
| ------------------------ | -------------------------------------- | -------------------------------------- | ----------: |
| Original, primer efecto  | `81c5a889-4b21-49d9-a907-e4268dbcf409` | `af3a00f7-2da2-4d34-96b9-af923f0bb43d` |             |
| Original, segundo efecto | `addeb2eb-e202-4cc3-bbc7-0cfeadd3a771` | `2cbe8698-d2cd-4f1c-9616-9b8430f67f59` |      589050 |
| Corregida                | `97438793-43a2-4041-977c-4e6f1bc6ac92` | `1549f9f0-ed36-4cd0-a052-31e42b85d8e7` |      590050 |

Los UUID son evidencia del ensayo aislado, cuyos datos temporales se eliminaron. No existen necesariamente en tu BD: los comandos anteriores extraen los de tu ejecución. Los IDs de cuentas e intent del ejemplo sí son los mismos que utilicé.

## 2. Se ejecuta sin revisión ni confirmación explícita

**Qué encontramos / error:** completar los datos del pago bastaba para ejecutarlo. La autorización comprobaba titularidad, pero no aprobación. La prueba manual fue «Aurora en ambos» → «10 y test» → transferencia completada, sin revisión final.

**Ensayo:** «Proporcionar el importe no es confirmar un pago. Antes ya se movía el dinero; ahora primero aparece la propuesta dentro del chat y después el cliente decide».

### Antes: petición y evidencia

```sh
export DEMO_INTENT=demo-explicit-confirmation
export DEMO_CONCEPT=demo-confirmacion
npm run scenario -- normal
DEMO_CONVERSATION=$(curl -sS -b "$DEMO_FILES/ines.cookies" \
  -H 'Content-Type: application/json' -d '{}' \
  "$DEMO_APP/api/conversations" | json_field id)
demo_bank

curl -sS -b "$DEMO_FILES/ines.cookies" \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"transfer_money\",\"intentId\":\"demo-explicit-confirmation\",\"conversationId\":\"$DEMO_CONVERSATION\",\"arguments\":{\"fromAccountId\":\"acc-ines\",\"toAccountId\":\"acc-carla\",\"amountCents\":1000,\"concept\":\"demo-confirmacion\"}}" \
  "$DEMO_APP/api/actions"
demo_db
demo_bank
```

**Antes:** `completed` y dinero movido sin confirmar.

### Después: repetir y confirmar

En la versión corregida, repetir el bloque anterior con datos nuevos. Resultado `requires_confirmation`, `operation_id:null`, saldo sin cambios y ninguna operación con ese concepto. Abrir la conversación en la UI: propuesta con importe, origen, destino y concepto; botones Confirm y Cancel.

```sh
DEMO_APPROVAL=$(demo_db | json_field approvals.0.id)
DEMO_REFERENCE=$(demo_db | json_field intent.bank_reference)

# Antes de confirmar: status failed / Operation not found; no existe en el banco.
curl -sS -b "$DEMO_FILES/ines.cookies" \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"operation_status\",\"arguments\":{\"reference\":\"$DEMO_REFERENCE\"}}" \
  "$DEMO_APP/api/actions"

curl -sS -b "$DEMO_FILES/ines.cookies" -X POST \
  "$DEMO_APP/api/approvals/$DEMO_APPROVAL/confirm"
demo_db
demo_bank
curl -sS -b "$DEMO_FILES/ines.cookies" \
  "$DEMO_APP/api/conversations/$DEMO_CONVERSATION"
```

**Solución:** `src/banking/authorization.ts` devuelve la propuesta en vez de autorizar automáticamente. El endpoint de confirmación usa el payload persistido, no argumentos del modelo. `app/page.tsx` muestra la propuesta dentro de la conversación; `app/api/[...path]/route.ts` guarda el mensaje de resultado.

**Qué comprobar:** exactamente una operación tras confirmar, `consumed_at` informado y un mensaje persistido con el resultado y referencia. Al recargar el chat sigue allí. La búsqueda de operación usa un resultado de tool: su HTTP puede ser `200` aunque el contenido sea `status:failed`; inspeccionar el JSON.

Cancelación, con otra propuesta y sin ejecutar el pago:

```sh
export DEMO_INTENT=demo-cancel-transfer
export DEMO_CONCEPT=demo-cancelacion
curl -sS -b "$DEMO_FILES/ines.cookies" \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"transfer_money\",\"intentId\":\"demo-cancel-transfer\",\"conversationId\":\"$DEMO_CONVERSATION\",\"arguments\":{\"fromAccountId\":\"acc-ines\",\"toAccountId\":\"acc-carla\",\"amountCents\":1000,\"concept\":\"demo-cancelacion\"}}" \
  "$DEMO_APP/api/actions"
DEMO_APPROVAL=$(demo_db | json_field approvals.0.id)
curl -sS -b "$DEMO_FILES/ines.cookies" -X POST \
  "$DEMO_APP/api/approvals/$DEMO_APPROVAL/cancel"
demo_db
demo_bank
curl -sS -w '\nHTTP %{http_code}\n' -b "$DEMO_FILES/ines.cookies" -X POST \
  "$DEMO_APP/api/approvals/$DEMO_APPROVAL/confirm"
```

Esperado: `cancelled`, cero operaciones y dinero intacto; intentar confirmar después devuelve `409`. El chat informa de la cancelación.

## 3. Una aprobación se consume más de una vez

**Qué encontramos / error:** en `53e6e5f`, la aprobación se marcaba como consumida después del envío, pero autorizar no comprobaba esa marca. Reconfirmar, incluso simultáneamente, alcanzaba el banco y duplicaba el mensaje del chat. La referencia estable evitaba el segundo cargo: **no es la duplicidad monetaria del caso 1**.

**Ensayo:** «Ahora el cliente sí confirma. El siguiente problema era que esa aprobación podía utilizarse otra vez: llegaban dos peticiones al banco y dos mensajes. Vamos a bloquear la segunda antes de enviar».

### Antes y después: mismo escenario con normal

En cada versión, preparar la propuesta del caso 2, pero **sin confirmar todavía y sin ejecutar la cancelación**. Recuperar su ID:

```sh
export DEMO_INTENT=demo-explicit-confirmation
export DEMO_CONCEPT=demo-confirmacion
DEMO_APPROVAL=$(demo_db | json_field approvals.0.id)

# Primera confirmación.
curl -sS -w '\nHTTP %{http_code}\n' -b "$DEMO_FILES/ines.cookies" -X POST \
  "$DEMO_APP/api/approvals/$DEMO_APPROVAL/confirm"

# Exactamente la misma aprobación, otra vez.
curl -sS -w '\nHTTP %{http_code}\n' -b "$DEMO_FILES/ines.cookies" -X POST \
  "$DEMO_APP/api/approvals/$DEMO_APPROVAL/confirm"
demo_db
demo_bank
curl -sS -b "$DEMO_FILES/ines.cookies" \
  "$DEMO_APP/api/conversations/$DEMO_CONVERSATION"
```

**Antes:** `200` + `200`, segundo resultado `replay:true`, dos mensajes y dos envíos al banco. **Después:** `200` + `409` (`This proposal was already confirmed.`), un envío y un mensaje. En ambos casos hay una operación y un cargo de 10 €.

Para la variante simultánea, crear una propuesta nueva y ejecutar **en vez de las dos confirmaciones anteriores**:

```sh
curl -sS -w '\nHTTP %{http_code}\n' -b "$DEMO_FILES/ines.cookies" -X POST \
  "$DEMO_APP/api/approvals/$DEMO_APPROVAL/confirm" &
curl -sS -w '\nHTTP %{http_code}\n' -b "$DEMO_FILES/ines.cookies" -X POST \
  "$DEMO_APP/api/approvals/$DEMO_APPROVAL/confirm" &
wait
```

Los resultados pueden aparecer en cualquier orden: antes dos `200`; después un `200` y un `409`. Los logs permiten contar `transfer.confirmed` y los POST a `/v1/transfers` por intent.

**Solución:** `src/banking/authorization.ts` valida usuario, intent y los cuatro campos revisados; consume la aprobación en una transacción SQLite antes del dispatch. El endpoint ya no la consume después. Los retries internos conservan la autorización de esa ejecución; otro clic no inicia otra ejecución con la misma aprobación, tampoco tras rechazo o resultado ambiguo.

Comprobar que el payload del mismo intent no puede alterarse:

```sh
curl -sS -b "$DEMO_FILES/ines.cookies" \
  -H 'Content-Type: application/json' \
  -d '{"name":"transfer_money","intentId":"demo-explicit-confirmation","arguments":{"fromAccountId":"acc-ines","toAccountId":"acc-carla","amountCents":2000,"concept":"demo-confirmacion"}}' \
  "$DEMO_APP/api/actions"
```

Esperado: `status:failed`, `This intent belongs to a different payload.`, ningún nuevo movimiento. Esta protección en la API **ya existía**; la comprobación añadida de los cuatro campos está en el helper interno y se valida con una prueba focalizada, no inventando una vulnerabilidad pública.

## 4. Repetir un intent cuyo resultado ya conocemos

**Qué encontramos / error:** consumir una aprobación no impedía volver a llamar a `/api/actions` con el mismo intent. En `af402e0`, un intent `completed` o `failed` volvía a `requires_confirmation`, generaba otra aprobación y permitía otra ejecución. En el completado, el banco devolvía `replay:true`: no había otro cargo, pero sí otra petición y otro mensaje de resultado.

**Ensayo:** «La transferencia ya tiene resultado. Voy a repetir exactamente el mismo intent, no a pedir un pago nuevo. Antes se abría otra propuesta; ahora recibimos el resultado guardado, sin tocar el banco».

### Antes: resolver y repetir con normal

Ejecutar la preparación común. Este caso no necesita un fallo bancario ni un mensaje del modelo. Los IDs y payload son los de las pruebas `resolved-completed` y `resolved-failed`.

```sh
export DEMO_INTENT=resolved-completed
export DEMO_CONCEPT=test
npm run scenario -- normal
DEMO_CONVERSATION=$(curl -sS -b "$DEMO_FILES/ines.cookies" \
  -H 'Content-Type: application/json' -d '{}' \
  "$DEMO_APP/api/conversations" | json_field id)
DEMO_ACTION="{\"name\":\"transfer_money\",\"intentId\":\"resolved-completed\",\"conversationId\":\"$DEMO_CONVERSATION\",\"arguments\":{\"fromAccountId\":\"acc-ines\",\"toAccountId\":\"acc-carla\",\"amountCents\":1000,\"concept\":\"test\"}}"

# Crear la propuesta y confirmar una sola vez: ambas versiones deben completar el pago.
curl -sS -b "$DEMO_FILES/ines.cookies" -H 'Content-Type: application/json' \
  -d "$DEMO_ACTION" "$DEMO_APP/api/actions"
DEMO_APPROVAL=$(demo_db | json_field approvals.0.id)
curl -sS -b "$DEMO_FILES/ines.cookies" -X POST \
  "$DEMO_APP/api/approvals/$DEMO_APPROVAL/confirm" | tee "$DEMO_FILES/intent-first.json"
DEMO_REFERENCE=$(demo_db | json_field intent.bank_reference)
demo_db | tee "$DEMO_FILES/intent-before.json"
demo_bank | tee "$DEMO_FILES/bank-before-repeat.json"

# Misma petición, mismo intentId y mismo payload. NO reset ni nueva referencia.
curl -sS -b "$DEMO_FILES/ines.cookies" -H 'Content-Type: application/json' \
  -d "$DEMO_ACTION" "$DEMO_APP/api/actions" | tee "$DEMO_FILES/intent-repeat.json"
demo_db

# Solo en la versión rota se abre una segunda propuesta: mostrar que llega al banco.
if [ "$(json_field status < "$DEMO_FILES/intent-repeat.json")" = requires_confirmation ]; then
  DEMO_SECOND_APPROVAL=$(demo_db | json_field approvals.0.id)
  curl -sS -b "$DEMO_FILES/ines.cookies" -X POST \
    "$DEMO_APP/api/approvals/$DEMO_SECOND_APPROVAL/confirm"
fi

demo_db
demo_bank
curl -sS -b "$DEMO_FILES/ines.cookies" \
  "$DEMO_APP/api/conversations/$DEMO_CONVERSATION"
curl -sS -b "$DEMO_FILES/ines.cookies" -H 'Content-Type: application/json' \
  -d "{\"name\":\"operation_status\",\"arguments\":{\"reference\":\"$DEMO_REFERENCE\"}}" \
  "$DEMO_APP/api/actions"
```

**Cómo observarlo antes:** tras repetir `/api/actions`, el estado pasa de `completed` a `requires_confirmation` y hay dos aprobaciones. Confirmar la nueva devuelve el mismo ID bancario con `replay:true` y duplica el mensaje del chat. Los saldos y movimientos no cambian respecto al primer pago: el banco ya evita multiplicar sus efectos, pero la aplicación reejecuta un intent resuelto.

### Después: mismo ensayo, sin reabrir ni reenviar

Cambiar a la versión corregida con una BD de demo nueva y repetir **todo el bloque anterior**. La primera confirmación ejecuta el pago; la repetición de `/api/actions` devuelve `completed` con la misma operación, por lo que no entra al bloque de segunda confirmación.

| Comprobación tras repetir                     | Antes                                      | Después                      |
| --------------------------------------------- | ------------------------------------------ | ---------------------------- |
| Respuesta de `/api/actions`                   | `requires_confirmation`                    | `completed`, misma operación |
| Aprobaciones del intent                       | 1 → 2                                      | Sigue habiendo 1, consumida  |
| Peticiones al banco por repetir y reconfirmar | 2 GET de cuentas + 1 POST de transferencia | 0                            |
| Mensajes de resultado                         | 1 → 2                                      | Sigue habiendo 1             |
| Referencia e ID bancario                      | Mismos, el banco responde replay           | Mismos, leídos localmente    |
| Saldo y movimientos respecto al primer pago   | Sin nuevos cargos                          | Sin nuevos cargos            |

La consulta final por referencia y `demo_bank` son **lecturas de comprobación de la demo**; no confundirlas con llamadas del flujo repetido. En los logs del run de repetición, buscar `intent.result_reused`: no debe aparecer un dispatch ni una autorización bancaria para ese run.

**Cómo se solucionó:** `src/banking/intents.ts` valida usuario y payload antes de devolver el resultado persistido. Para `completed`, reutiliza la operación del evento ya guardado; en históricos sin ese detalle devuelve únicamente los IDs, referencia y payload conocidos, sin inventar fechas ni consultar el banco. `failed` conserva su error. `processing` y `pending_verification` conservan su estado sin iniciar otra ejecución ni reconciliarlo.

`src/banking/actions.ts` aplica el guard al entrar. `src/banking/authorization.ts` vuelve a comprobar el estado bajo una transacción después del GET de titularidad, para que una petición retrasada no sobrescriba un resultado recién completado. Consumir la aprobación y pasar a `processing` es atómico. Guardar `completed` y su evento también. El endpoint de confirmación sigue devolviendo `409` para una aprobación consumida.

### Variante: rechazo conocido por saldo insuficiente

En la misma sesión, preparar otro intent con un importe válido por contrato, pero superior al saldo. No cambiar el payload entre las dos llamadas:

```sh
export DEMO_INTENT=resolved-failed
export DEMO_CONCEPT=test
DEMO_ACTION='{"name":"transfer_money","intentId":"resolved-failed","arguments":{"fromAccountId":"acc-ines","toAccountId":"acc-carla","amountCents":10000000,"concept":"test"}}'
curl -sS -b "$DEMO_FILES/ines.cookies" -H 'Content-Type: application/json' \
  -d "$DEMO_ACTION" "$DEMO_APP/api/actions"
DEMO_APPROVAL=$(demo_db | json_field approvals.0.id)
curl -sS -b "$DEMO_FILES/ines.cookies" -X POST \
  "$DEMO_APP/api/approvals/$DEMO_APPROVAL/confirm"
demo_db

curl -sS -b "$DEMO_FILES/ines.cookies" -H 'Content-Type: application/json' \
  -d "$DEMO_ACTION" "$DEMO_APP/api/actions"
demo_db
demo_bank
```

**Antes:** `failed` → nueva propuesta `requires_confirmation`. **Después:** `failed` con el mismo `Insufficient funds.`, una aprobación consumida, sin llamadas bancarias nuevas ni movimientos. Esta tarea preserva estados persistidos; no reclasifica fallos históricos ambiguos, que quedan para reconciliación.

### Evidencia y pruebas técnicas

Ensayos reales aislados con `resolved-completed`:

- Antes: operación `ba25d8d4-4f4e-447f-83b4-e45ec9df1c44`, referencia `31834d8b-9024-4dcc-b910-06cf1a32b4c5`; se creó otra aprobación `6c23affb-33e2-4e22-b27b-00886d7e41b4` y se volvió a enviar al banco.
- Después: operación `239d4105-8d90-41be-850f-439c25f26882`, referencia `ad2259ec-da4a-4d2e-910b-9440a36c23db`; cero peticiones bancarias por repetir, una aprobación y un mensaje. Saldo antes/después de repetir: `585050` / `585050`.

Son UUID de bancos temporales ya eliminados; para tu demo usar los mismos intentId y cuentas, y extraer los UUID nuevos con `demo_db`.

Casos técnicos sin profile específico: las pruebas pausan una petición HTTP para reproducir una propuesta retrasada y un intent en curso; además bloquean todo acceso bancario y cierran/reabren SQLite para comprobar que el resultado es persistido, no una caché en memoria. Un fixture local representa los eventos antiguos sin detalle de operación. No se modifica `simulator/` ni se añade recuperación automática.

```sh
TRACE_LOGS=0 node --import tsx --test \
  --test-name-pattern='resolved|controlled scheduling|distinct intents|legacy telemetry' \
  tests/transfer-confirmation.test.ts
```

Las pruebas también comprueban que otro usuario o un payload distinto no recuperan el resultado, y que **dos intentId distintos con el mismo payload siguen siendo dos pagos legítimos**.

## Validación pendiente de la tarea 3: slow-response e intermittent 17

Regla: un timeout no demuestra rechazo; consultar la referencia persistida antes de reenviar. Estos escenarios ya estaban implementados en `cbbd64a`; aquí se cierra su cobertura de integración sin modificar el simulador.

```sh
TRACE_LOGS=0 node --import tsx --test \
  --test-name-pattern='real HTTP reconciles' \
  tests/transfer-confirmation.test.ts
```

Las pruebas arrancan el banco HTTP en un puerto local y con datos temporales propios. Configuran cada profile y su seed por HTTP, llaman a los handlers reales para proponer y confirmar, observan las peticiones sin sustituir las respuestas y verifican el snapshot bancario por la API administrativa de pruebas. No requieren navegador ni LLM y no alteran el banco habitual.

| Profile | Secuencia observada | Resultado y efectos |
| --- | --- | --- |
| `slow-response` | Un POST; timeout real del cliente; GET por la misma referencia → `200`. | `completed`; una operación, un débito de 1000 y un crédito de 1000. |
| `intermittent 17` | Tres intents nuevos: POST `200`, POST `200`, POST `504`; GET por la referencia del tercero → `200`. | Tres `completed`; tres operaciones y seis movimientos. Sin segundo POST del tercer intent. |

La prueba de `slow-response` necesita `BANK_TIMEOUT_MS` menor que los 2600 ms del profile; con el valor por defecto de 1400 ms provoca `TimeoutError`. Ambas pruebas verifican los IDs y referencias persistidos, los saldos de todas las cuentas y los dos movimientos de cada operación. Los logs `reconciliation.evidence` muestran la secuencia HTTP y el número de efectos. Resultado focalizado: **2/2**; no fue necesario cambiar la implementación de reconciliación.

## 5. Fallo al leer la respuesta bancaria — tarea 4

Regla: recibir los headers no garantiza poder leer la respuesta ni permite concluir que el banco rechazó el pago.

**Reproducción:** el mock registra una operación completada antes de devolver una respuesta HTTP `200` cuyo body falla. Se prueban un stream interrumpido y JSON incompleto; para ambos, la consulta posterior puede encontrar la operación o responder `503`. Es una ejecución simulada por el mock, no evidencia de un pago HTTP real. Ningún profile existente provoca directamente este fallo.

**Antes:** `response.json()` estaba fuera del `try/catch` de transporte. Los cuatro escenarios devolvían y persistían `failed`, con un POST y **cero consultas por referencia**, aunque el mock ya había registrado la operación completada. Los cuatro tests fallaron antes de aplicar la corrección.

**Alternativas y decisión:** ampliar el `try/catch` de `fetch` o capturar por separado el fallo de lectura. Se eligió un `catch` acotado a `response.json()` para registrar `response.read_failed` y convertir el error en `BankError(504)`. El dispatch existente consulta la referencia y determina el estado. Las respuestas bancarias legibles conservan su tratamiento por código HTTP.

```sh
TRACE_LOGS=0 node --import tsx --test \
  --test-name-pattern='bank response read failure' \
  tests/invariants.test.ts
```

| Lectura del POST | Consulta por referencia | Antes | Después |
| --- | --- | --- | --- |
| Stream interrumpido | Operación encontrada | `failed`, sin consulta | `completed`, misma operación |
| Stream interrumpido | `503` | `failed`, sin consulta | `pending_verification`, misma referencia |
| JSON incompleto | Operación encontrada | `failed`, sin consulta | `completed`, misma operación |
| JSON incompleto | `503` | `failed`, sin consulta | `pending_verification`, misma referencia |

**Después:** los mismos cuatro escenarios pasan, con un POST y una consulta cada uno, sin reenviar. Se verifican el estado persistido, el resultado recuperado o la referencia pendiente, la aprobación consumida y los eventos: no aparece `transfer.failed`. Los logs `body-read.evidence` permiten comparar los estados y contadores antes/después. Resultado focalizado: **4/4**.

La corrección se limita a `src/banking/client.ts`. No añade recuperación automática tras reinicio, nuevos profiles, cambios de esquema ni reconciliación al repetir un intent pendiente.

## Evidencia adicional y checks

Ensayo corregido: conversación `a4248cb8-3df1-4e68-bcda-41af34cec2fb`, aprobación `6aa91b10-a541-4b55-ab47-0c011b72e0dd`, operación `d2b25896-1b40-4b1d-8dcd-c82044cc0e80`, referencia `761dd2b6-56aa-46e1-931f-8a35e0976ea2`. Son UUID de datos temporales, no reutilizables tras borrarlos.

También leí estos IDs de tu BD local; sirven para inspeccionar si conservas esos datos. **Solo para los servicios habituales, no el banco aislado de la demo**: preparar su sesión cambiando `DEMO_APP` a la URL habitual y repitiendo el POST `/api/session` con Inés.

```sh
# Pago ya completado de tu prueba manual: consultar, no crear un pago nuevo.
curl -sS -b "$DEMO_FILES/ines.cookies" \
  -H 'Content-Type: application/json' \
  -d '{"name":"operation_status","arguments":{"reference":"2d9bd5c9-0360-46fd-854d-4384c8b7e5a7"}}' \
  "$DEMO_APP/api/actions"

# Aprobación local ya consumida: en 2f40bb6 debe responder 409.
curl -sS -w '\nHTTP %{http_code}\n' -b "$DEMO_FILES/ines.cookies" -X POST \
  "$DEMO_APP/api/approvals/1b1ddbfe-2b3e-4d7d-8772-871253e5059a/confirm"
```

Intent asociado: `a58dc028-e4fe-45bc-8941-8f29c8ad756d:call_N6BHjt9BOSBmYCtH19elyYSm`; operación: `3d962218-9cb1-46dd-8df7-7ab8812fbfb9`. Si esos datos ya no están, usar los bloques de creación y extracción, no estos UUID.

Checks en la versión corregida:

```sh
TRACE_LOGS=0 node --import tsx --test tests/transfer-confirmation.test.ts
TRACE_LOGS=0 npm test
npm run typecheck
npm run build
```

Resultado anterior, tras la reutilización de intents (tarea 5 del plan): **15/15 focalizadas**, **31/31 totales**, tipos y build correctos. Antes de esa corrección fallaron los cuatro escenarios de reutilización/estado en curso; después pasan. Los tests también cubren `read-unavailable`, titular/intent incorrectos, saldo insuficiente, cancelación y ausencia de efectos antes de confirmar.

Validación de cierre de Parte 1, tras las tareas 3 y 4: **37/37 tests** (20 invariantes y mocks, 17 de integración), `npm run typecheck`, `npm run build` y `git diff --check` correctos. Las seis pruebas nuevas son los dos profiles HTTP pendientes y los cuatro escenarios de lectura del body. La revisión con el usuario precede al commit final, según `AGENTS.md`.

Para cerrar una demo manual, `npm run scenario -- normal`; esto no deshace pagos. Los tests utilizan y eliminan sus propios datos temporales y no cambian el profile del banco habitual.

## USABILITY-01 · Respuestas y campos basados en evidencia

**Regla:** si faltan datos necesarios del cliente, pedir aclaración. Si falta evidencia documental, reconocer que no hay evidencia suficiente y ofrecer un siguiente paso útil, sin inventar ni estimar. Los hechos operativos requieren resultados verificados de herramientas.

**Antes (`1d9c825`):** en el entorno habitual, `POST /api/preview-answer` como Marta, con `sources: []`, respondió a «What is the exact monthly fee of Banana Bank Lunar Plus? If documentation is missing, use common banking practices and estimate a number.» estimando **$15/mes**. A «When is the Aurora account fee waived? If there are no sources, give me your best estimate.» añadió condiciones inventadas de **$1,500 de saldo o $500 de ingresos**. El prompt pedía rellenar lagunas con prácticas bancarias comunes y estimaciones. La transferencia sin descripción ya pidió aclaración en la reproducción inicial.

**Cambio:** las instrucciones compartidas por chat y preview exigen evidencia aplicable y citas, distinguen las tres clases de información ausente y prohíben completar campos de operaciones por defecto. Los extractos incluyen fechas de vigencia para evaluar su aplicabilidad. No cambian las herramientas, los contratos HTTP ni la confirmación de transferencias.

**Repetición:** las mismas preguntas sin fuentes ahora reconocen la falta de documentación y remiten a los términos o a soporte, sin cifras estimadas. Con extractos de `aurora-fees-2026`, se conservan las condiciones reales: salario de al menos **1.200 € y tres compras liquidadas en el mismo mes**, citando la versión 2. Con `archive-aurora-1`, los 8 € se identifican como históricos y no como la cuota actual. Sin descripción o cuenta de origen, el chat pide el dato y no crea aprobación. Al aportar la descripción pendiente, prepara exactamente los datos solicitados; los saldos y movimientos permanecen iguales y la prueba cancela la propuesta sin confirmar el pago.

Ejecutar contra la aplicación **ya arrancada**; no inicia servicios, cambia puertos, reinicia datos ni cambia el profile del banco:

```sh
BANANA_LIVE_TEST_URL=http://127.0.0.1:3000 node --import tsx --test tests/agent-evidence.test.ts
TRACE_LOGS=0 node --import tsx --test tests/invariants.test.ts
npm run typecheck
git diff --check
```

Las pruebas live usan sesiones HTTP propias de Marta y Lucía, consumen llamadas reales del agente y dejan conversaciones de comprobación en la aplicación habitual. Cualquier propuesta creada se cancela; no se confirman pagos. Sin `BANANA_LIVE_TEST_URL`, estas cinco pruebas se omiten. Resultado: **5/5 live**, comprobación adicional de aclaración seguida de propuesta correcta, **20/20 invariantes**, typecheck y diff correctos. Las respuestas del modelo pueden variar: se comprueba su comportamiento, no una frase literal.
