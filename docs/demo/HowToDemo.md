# HowToDemo

Chuleta: primero enseñar el fallo en la versión anterior y repetir la petición en la corregida. Importar los `curl` en Postman si se prefiere; conservar la cookie de `/api/session` y sustituir las variables por sus valores.

| Caso                                 | Antes     | Después               |
| ------------------------------------ | --------- | --------------------- |
| 1. Transferencia duplicada por retry | `684d232` | `cbbd64a` o posterior |
| 2. Transferencia sin confirmación    | `cbbd64a` | `53e6e5f` o posterior |
| 3. Aprobación reutilizable           | `53e6e5f` | `2f40bb6`             |

Para comparar con los **mismos intentId**, usar datos de demo nuevos en cada versión. Conservar una referencia ya ejecutada hace que el banco devuelva un replay y no active el fallo. Cambiar de profile reinicia el contador, **no** los saldos. No ejecutar `reset` sobre datos que quieras conservar.

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
    console.log(JSON.stringify({intent:db.prepare("SELECT id,user_id,status,payload,bank_reference,operation_id FROM intents WHERE id=?").get(id)??null,
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
```

Resultado validado: **9/9 focalizadas**, **25/25 totales**, tipos correctos. Los tests también cubren `read-unavailable`, titular/intent incorrectos, saldo insuficiente, cancelación y ausencia de efectos antes de confirmar. Para cerrar la demo, `npm run scenario -- normal`; esto no deshace pagos.
