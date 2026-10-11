# Arquitectura de `pi-agents`

## Objetivo y frontera

La extensión ofrece dos entradas al mismo coordinador:

```text
/subagents ─┐
           ├─ resolver agente/modelo → JobsDoc → cola → conversación Durable
pi_agents ──┘                                      └─ envío → generación/herramientas
                                                             └─ resultado → notificación Pi
```

Cada trabajo ejecuta una tarea independiente. No existen cadenas ni lotes. La conversación Durable mantiene un transcript separado de la sesión principal y hereda únicamente cwd, modelo o modelo declarado, nivel de razonamiento, herramientas permitidas e instrucciones del agente.

## Componentes

### Extensión Pi (`index.ts` y adaptadores)

`index.ts` solo conecta bindings públicos del host. `src/adapters/pi/resolve.ts` resuelve agente, confianza, proveedor y snapshot; `display.ts` presenta vistas compactas; `register.ts` registra comandos, tool, renderers y lifecycle sin poseer transiciones Durable.

- Registra el comando, la herramienta y renderers de entradas.
- Abre recursos desde `session_start` o ensure de tools/comandos, nunca durante la carga de la fábrica.
- Invalida estado/generación antes de retirar el runtime desde switch/shutdown; el cierre SDK continúa en segundo plano y conserva el lease hasta éxito.
- Consulta la confianza mediante la API nativa.
- Construye un `ModelRuntime` público y sincroniza proveedores físicos visibles en `ctx.modelRegistry`.
- Añade notificaciones fuera del contexto del modelo mediante `pi.appendEntry()`.

### Widget de subagentes A+B

`register.ts` crea `createSubagentsWidget` tras abrir el runtime únicamente para `mode === "tui" && hasUI`. A consume `JobsService.listJobs` en dos conjuntos, limita 4 filas/6 líneas y comparte consulta serial, frescura y animación; B recibe el método enlazado `SessionRuntime.watchJobActivity` para los activos visibles. El render usa el tema/ancho actuales y no consulta almacenamiento ni captura teclas.

La frontera B resuelve internamente job→conversación y usa `watchDoc(LiveDoc)`. Publica solo callId/nombre de slots running, intento/espera y compactación, como reemplazos desde snapshot/callback. No entrega Harness, conversación ni cuerpo al componente. LiveDoc se materializa antes de proyectarse: no es una garantía de memoria constante ni sandbox. El listado recorre/ordena el índice aunque limite la página.

El sellado invalida adquisiciones y callbacks; `retire()` drena adquisiciones/watches admitidos antes del cierre SDK. Los handles terminados se eliminan. El adaptador sella RPC antes de esperar cleanup del widget, que precede la retirada del runtime; no cambia control, revisiones, outbox ni notificaciones. `close()` conserva el lease hasta el cierre SDK real, incluidos proveedores que no terminan.

Visto bueno humano A+B recibido el 2026-10-09; [registro y matriz](WIDGET-ACCEPTANCE.md) separan una prueba real de ejecución/lectura, UI controlada, Harness/SQLite con LiveDoc sintético y escenarios interactivos no ejercitados. La ampliación automatizada no cambia código productivo ni promueve fase 10.

### Descubrimiento (`src/agents.ts`)

Busca:

1. `<agent-dir>/agents`;
2. el `.pi/agents` más cercano al cwd, únicamente si el proyecto está confiado.

Los archivos se ordenan por nombre para que la resolución sea determinista. Primero se insertan los personales y después los de proyecto, produciendo reemplazo por `name`.

### Registro, cola, consulta y control (esquemas 2 a 5)

La persistencia separa `StorageMetaDoc`, `JobsIndexDoc`, `JobDocFamily`, `JobResultDocFamily` y `RequestLedgerDocFamily`. En el esquema 3 también separa `JobReviewDocFamily` y `JobConsumptionDocFamily`; el esquema 4 añade `JobControlDocFamily`, `controlHistory`, campos de intento y estados de ciclo de vida. El índice contiene orden y resúmenes compactos; el cuerpo del job y la respuesta se leen por separado. El ledger conserva `requestId`, actor, hash canónico y recibo de la operación (`start`, `consume`, `review`, `control` o `retry`). Las mutaciones de cola y control actualizan job, índice, ledger e historial en el mismo commit.

`QueryService` implementa `getJob` y `listJobs` sobre snapshots Durable. El listado filtra la proyección compacta y usa un cursor keyset opaco de `(createdAt,id)` descendente; no depende del arreglo de orden de cola y no materializa `JobResultDocFamily`. La vista de resultado se carga aparte mediante `ResultService`.

`WaitService` aplica snapshot → `watchDoc` → snapshot. El timeout y `AbortSignal` solo terminan la promesa de espera; nunca llaman una API de cancelación del Harness. El estado Durable sigue siendo la autoridad tras cerrar y reabrir Pi.

El documento conserva la definición resuelta del agente, no solo su nombre. Un trabajo que espera en cola no cambia si el archivo Markdown se modifica antes de comenzar.

La cola cuenta `provisioning` y `running` contra el límite. El `Coordinator` serializa decisiones dentro del proceso y los commits Durable serializan las mutaciones persistentes.

### Conversación por trabajo

Cada trabajo crea una conversación `ownerless` mediante `DurableExecution` con los documentos internos de Pi Durable. Se configura en el mismo commit con:

- modelo;
- nivel de razonamiento;
- extensión `CodingTools`;
- filtro exacto de herramientas;
- instrucciones;
- cwd.

No se utiliza la conversación reservada raíz y no se comparte transcript entre trabajos.

## Salida estructurada y gates

La admisión acepta opcionalmente `output_schema` y una lista acotada de gates. El contrato se normaliza y se conserva con hash canónico; se mantiene compatibilidad con jobs históricos del esquema 5 que no tienen contrato. El validador implementa un subconjunto explícito de JSON Schema, admite únicamente `$ref` locales y rechaza keywords o formas no soportadas.

Tras `Submission.wait()`, el runtime extrae un único documento JSON estricto. Una salida inválida puede recibir un único turno de corrección; si continúa inválida se conserva la respuesta textual, se marca `output_invalid` y no se persiste un objeto estructurado parcial. Un resultado válido se guarda separado de `finalResponse`.

Los gates se ejecutan solo después de validar, en orden, mediante `spawn(argv, { cwd, shell: false })`. El estado `pending`/`running` se escribe antes del efecto externo; cada cierre conserva estado, código/señal, captura limitada a 1 MiB por stream, tamaño total y SHA-256. Un gate fallido o interrumpido solo informa el outcome técnico (`gate_failed`/`gate_interrupted`): no aprueba, consume ni promociona el job. Al reabrir, un gate `running` se convierte en `interrupted` y no se relanza automáticamente. La exposición pública incluye fase, conteo, resultado validado y outcome, no streams completos.

## Máquina de estados

```text
queued
  │ commit: crear/configurar conversación y retirar de queue
  ▼
provisioning
  │ submit(requestId = "pi-agents:<job-id>")
  │ commit: guardar submissionId y startedAt
  ▼
running
  │ Submission.wait()
  ├──────── respuesta ────────▶ completed
  ├──────── error terminal ───▶ failed
  └──────── intención cancel ─▶ cancelling ── aborto confirmado ─▶ cancelled

queued ── pause ──▶ paused ── resume ──▶ queued
queued/paused ── cancel ──▶ cancelled
retry terminal ──▶ nuevo queued enlazado por `retryOf`
```

`interrupted` está reservado en el protocolo público para resultados irreanudables o cancelaciones inciertas. El cierre normal no convierte trabajos en interrumpidos: Pi Durable deja las tareas pendientes y las reconcilia al reabrir. La pausa activa devuelve `PAUSE_ACTIVE_UNSUPPORTED`; no se simula con un flag.

## Ventanas de caída

| Punto de caída | Recuperación |
|---|---|
| Después de crear el job `queued` | El `pump` lo vuelve a seleccionar. |
| Después de crear la conversación | El ID quedó en `provisioning`; se reutiliza. |
| Después de admitir el envío, antes de guardar `submissionId` | Se repite `submit()` con el mismo `requestId`; retorna el envío existente. |
| Durante modelo o herramienta | El scheduler Durable reanuda desde su checkpoint. |
| Después del resultado, antes de cambiar el job | `Submission.wait()` devuelve el resultado ya durable y se completa el job. |
| Después de completar el job, antes de notificar | En `session_start` se buscan terminales con `notified: false`. |
| Después de añadir la notificación, antes de marcarla | La recuperación puede volver a notificar: actualmente no se deduplica contra las entradas Pi. |

La notificación y `markNotified` cruzan dos almacenes —Pi y SQLite Durable— y no son una transacción única. No se promete entrega exactamente una vez.

## Concurrencia

Pi Durable no expone un límite global de scheduler. La extensión lo aplica antes de admitir conversaciones:

- solo los primeros `N` jobs pasan de `queued` a `provisioning`;
- terminar un monitor vuelve a ejecutar el `pump`;
- al reabrir, los jobs activos ocupan sus slots antes de seleccionar la cola.

De esta forma no se reservan muchas tareas Durable que aparenten estar ejecutándose mientras esperan un semáforo volátil.

## Persistencia por sesión principal

El archivo usa el ID de la sesión Pi. Una base de esquema 2 no abre el Harness: mantenimiento TUI, autorización humana y backup verificado deben completar 2 → 3; una base de esquema 3 requiere después 3 → 4. El runtime usa esquema 5 y exige también migración humana 4 → 5, con backup verificado, conservación de ownership/review/ledger y outbox vacío sin eventos históricos. Todas estas migraciones son explícitas y atómicas. Esto aporta:

- `status` y `result` con semántica local a la conversación principal;
- notificaciones dirigidas a la sesión que inició el trabajo;
- pausa natural al cambiar de sesión;
- menor probabilidad de que dos procesos Pi abran el mismo almacenamiento.

No hay índice global de jobs en esta versión. Las consultas se limitan al SQLite de la sesión activa.

## Modelo y proveedores

`ExtensionContext` expone `ModelRegistry`, pero no el `ModelRuntime` completo requerido por Pi Durable. Acceder a su campo privado infringiría el contrato público. La extensión crea otro `ModelRuntime` con `auth.json` y `models.json`, y registra mediante `registerNativeProvider()` los proveedores físicos publicados por el registro principal.

Esto mantiene autenticación y proveedores ordinarios sin depender de internals. Una definición de modelo virtual no se puede extraer públicamente del registro, por lo que esos modelos se rechazan cuando no aparecen en el runtime durable.

## Herramientas

Además de `pi_agents` para admitir trabajos, la extensión registra `pi_agents_status`, `pi_agents_list`, `pi_agents_wait`, `pi_agents_result`, `pi_agents_control` y `pi_agents_review`. El comando expone `cancel`, `pause`, `resume` y `retry`. Las tools delegan en servicios; no implementan transiciones ni políticas duplicadas.

El esquema 3 protege los resultados con revisión separada: jobs iniciados por modelo o extensión quedan `pending` tras migración; una tool no recibe el cuerpo `pending` o `rejected`. Los comandos `approve`/`reject` exigen actor humano desde la TUI activa. La nueva tool permite exclusivamente revisión model parental propia con referencia host exacta y ownership persistido. La decisión no altera ejecución/resultado ni implica aceptación técnica. `peek` humano no marca consumo; `consume` exige `requestId` y actualiza ledger y agregado de consumo en el mismo commit.

Las tools truncan el texto a 64 KiB por bytes UTF-8 y devuelven longitud total, SHA-256 e indicador de truncado. El cuerpo completo permanece en SQLite.

Se instala únicamente `CodingTools` de Pi Durable:

- `read`
- `write`
- `edit`
- `bash`

No se conserva un `ExtensionToolContext` de la llamada original: su vida termina cuando la herramienta principal retorna. Por ello no sería correcto intentar invocar posteriormente `ctx.executeTool()` desde el trabajo de fondo.

Las herramientas Durable aplican sus políticas de replay. La cancelación activa persiste primero `control.pending` y el coordinador usa únicamente `Conversation.abort()`/`Harness.abortSubmission()`. Si el aborto no se puede confirmar, persiste `interrupted`; solo la confirmación publica `cancelled`. Efectos no seguros no se repiten ciegamente después de una caída.

## Autoridad parental y lifecycle

`ParentJobsService` conserva una `ParentAuthority` congelada emitida por SessionRuntime y delega en start/retry/review. El repository comprueba referencia exacta, actividad y `parentSessionId` dentro del commit. ReviewService deriva `model/parent:<sessionId>`; los argumentos públicos no contienen credenciales. `createdBy`/toolCallId y hashes canónicos históricos se conservan. Retry propio con otro toolCallId conserva vínculo solo por esa autoridad; retry humano/extension no lo hereda.

Review/index/ledger y `job.reviewed` se actualizan atómicamente. El evento se genera por cambio de status o toma de autoridad humana, incluso al mantener el status; no por replay o no-op. No publica vínculo parental, autor, motivo ni requestId. `decidedByActor` es aditivo; decisiones históricas sin actor se consideran humanas. Humano confirma mismo status parental: cambio efectivo de autoridad y posterior bloqueo del padre. Mismo autor/status parental: no-op conserva fecha/motivo/auditoría, aunque un requestId nuevo registra ledger. Se verifica permiso vigente antes de replay/consumo; una aprobación antigua no restaura acceso retirado. No se adopta ownership legacy ni se aprueba al completar.

`retire()` comparte una fase 1: invalida/sella síncronamente, detiene pump y observación, drena almacenamiento parental y continuaciones/finish/lecturas/callbacks ya admitidos, y empieza una única promesa de cierre SDK. `close()` comparte la fase completa y espera SDK+release. Fallo de fase 1 impide fase 2; rechazo SDK observado/propagado conserva lease. No early-return de flags, nuevo manager, poller ni liberación por timeout.

El driver cancela solamente contexto de lectura/wait mediante `withCancel` público de Chord; submit/abort humano y cierre usan contexto independiente. Extrae AssistantEntry mediante `Conversation.entries` read-only, rango exacto y límite 1, con guards tras awaits. Coordinator no observa ni publica nuevos resultados después de stop; sí drena writes admitidos previamente.

El adaptador invalida generación antes de awaits y la verifica después de modelos/open/migración/ensure. Retira runtimes abiertos obsoletos sin publicarlos. La cadena espera únicamente fase 1 y se recupera tras fallos: otra base puede operar; misma base/reload devuelve `STORAGE_BUSY` hasta cierre real y permite reintento manual. Los errores del cierre SDK retirado siguen reportándose sin reactivar su autoridad ni permitir publicaciones RPC/eventos tardíos. Ni cierre normal ni fallo de apertura sintetizan cancelación durable. Un proveedor pendiente puede retener recursos indefinidamente y process exit no garantiza cleanup.

Reevaluación SDK futura y límites: [README](../README.md#reevaluar-futuras-versiones-de-pi-durable), [§3.1 de la spec](superpowers/specs/2026-10-07-aprobacion-padre-design.md) y [aceptación](PARENT-REVIEW-ACCEPTANCE.md). Durable1.0.1 sigue fijado, sin patch/update. La integración conserva RPC/outbox/esquema 5 y está cubierta offline; no sustituye aceptación TUI ni revisión independiente de fase03.

## API pública RPC y eventos

El entrypoint raíz `rpc.ts` publica solo contratos RPC, el cliente, canales y tipos/eventos; el caller no importa adaptadores ni servicios internos. El cliente instala el listener de respuesta antes de emitir, valida protocolo/correlación/solicitud/sesión y limpia listener y timer tras completar, expirar, fallar el transporte o cerrar. Un `ping` exitoso puede fijar la sesión; el cliente no se redirige silenciosamente si cambia.

Los handlers del servidor delegan en los mismos `JobsService` y políticas que los comandos/tools. El actor siempre es `extension` con `callerId` declarativo; no es autenticación. `spawn` usa cwd y confianza actuales. `review` RPC está prohibido; cancelar ejecución activa requiere confirmación TUI y la pausa activa sigue no soportada.

Las transiciones observables y su evento se persisten en el mismo commit Durable. El emisor ordena secuencias y confirma después de emitir; una caída entre ambos pasos puede duplicar un evento con el mismo `(sessionId,eventId)`. El bus no ofrece ack de consumidor, entrega exactly-once, replay completo ni GC física de documentos. Cada consumidor deduplica y reconcilia estado mediante status/list. La ventana indexada mantiene hasta 1000 referencias recientes, no un límite de almacenamiento. El namespace `pi-durable-subagents:*` evita colisiones nominales locales con `subagents:*`; no prueba convivencia real con upstream. Véase [`RPC.md`](RPC.md) para contratos y [`PHASE-03-ACCEPTANCE.md`](PHASE-03-ACCEPTANCE.md) para evidencia y límites del cierre. Fase 03 completada e integrada en `main`, incluidos los fixes de `9c87c77` y la integración `54e095a`; no acredita proveedor remoto, migración real ni aceptación global de la revisión parental.

## Seguridad

La tool de control exige `request_id`; los actores model no pueden controlar jobs humanos bajo la política predeterminada y la cancelación activa requiere autoridad TUI. La confianza del proyecto es una barrera de carga, no una sandbox. La extensión no lee `.pi/agents` cuando `ctx.isProjectTrusted()` es falso. Una vez autorizado, instrucciones y herramientas se ejecutan con los permisos del proceso anfitrión.

SQLite y las notificaciones pueden contener información sensible. No deben publicarse ni incorporarse al repositorio.
