# Roadmap operativo global de `pi-agents`

## Propósito

Este documento gobierna la evolución de `pi-agents` desde su base durable actual hasta las capacidades descritas en las especificaciones 01–10. Define la secuencia de entrega, dependencias, bloqueos, evidencias y gates de entrada y salida.

El roadmap no sustituye las especificaciones de fase:

- [`README.md`](README.md) define los principios transversales y el orden normativo;
- cada `NN-*.md` define el contrato funcional de una fase;
- este documento registra su estado operativo y la próxima decisión necesaria;
- cada plan de implementación se escribe únicamente cuando su fase está lista para planificar.

La estrategia es **roadmap global y plan detallado fase por fase**. No se mantiene un plan ejecutable único para todas las fases.

## Organización Spec Kit

Specs, planes y tareas operativos viven en `specs/<feature>/`. El [índice](README.md) permite
seleccionarlos y el [informe de migración](MIGRATION.md) registra precedencia y discrepancias.
Los originales archivados no son un segundo backlog. Los pasajes de baseline y planificación
antigua que contradicen el mapa global se conservan como antecedentes, no como estado actual.
La migración no modifica gates ni acredita nuevas pruebas o aprobaciones.

## Reglas de uso

1. Una fase no comienza hasta que sus dependencias hayan superado sus gates de salida.
2. Una spec aprobada no equivale a implementación aprobada: primero debe existir y revisarse su plan.
3. Cada fase se implementa, migra, prueba y documenta como una entrega independiente.
4. SQLite y los documentos Pi Durable son la fuente de verdad; memoria, listeners, timers y UI son proyecciones reconstruibles.
5. La ausencia de una API pública bloquea o degrada explícitamente una capacidad. No se accede a internals de Pi o Pi Durable.
6. Un agente puede ejecutar o verificar, pero una autoridad separada aprueba y promociona.
7. No se publican porcentajes subjetivos ni fechas estimadas sin una decisión humana explícita.
8. Un estado no avanza si hay pruebas fallando, migraciones no verificadas o limitaciones ocultas.

## Relación entre artefactos

```text
roadmap global
  └─ spec de fase aprobada
       └─ plan de implementación revisado
            └─ método de ejecución elegido
                 └─ implementación y migración
                      └─ verificación y aceptación
                           └─ actualización del roadmap
```

Cambios de alcance global actualizan este roadmap. Decisiones funcionales locales actualizan la spec de su fase. Detalles de código y orden de tareas pertenecen al plan de implementación.

## Leyenda de estados

| Estado | Significado | Evidencia mínima |
| --- | --- | --- |
| `propuesta` | El alcance está descrito, pero aún requiere decisiones o diseño antes de planificarse. | Spec o sección de roadmap con objetivos, dependencias y bloqueos. |
| `bloqueada` | Una dependencia o capacidad pública impide planificar o ejecutar la fase completa. | Bloqueo identificado y siguiente acción explícita. |
| `lista para planificar` | Alcance aprobado, APIs necesarias confirmadas y dependencias completas. | Spec revisada, spikes cerrados y gate de entrada satisfecho. |
| `en implementación` | Existe un plan revisado y se eligió un método de ejecución. | Path del plan y registro de aprobación. |
| `en validación` | El código está completo, pero faltan gates finales o revisión. | Resultados parciales y fallos pendientes identificados. |
| `completada` | Todos los criterios de aceptación, migración, recuperación y documentación pasan. | Comandos y resultados de verificación, más commit o release correspondiente. |

Una fase puede estar descrita como propuesta y operativamente bloqueada. En la tabla principal se muestra el estado que más limita la siguiente acción.

## Estado de partida

La base actual ofrece:

- un job durable por agente y tarea;
- una conversación Pi Durable `ownerless` por job;
- `JobsDoc` versión 1 con jobs y cola en un único documento;
- estados `queued`, `provisioning`, `running`, `completed`, `failed` e `interrupted`;
- límite de concurrencia y recuperación al reabrir;
- herramientas `read`, `write`, `edit` y `bash`;
- comandos de inicio, estado y resultado;
- notificaciones terminales fuera del contexto del modelo.

Evidencia del análisis inicial:

- `npm run check`: pasa, pero solo comprueba sintaxis mediante `node --check`;
- `npm test`: 9 pruebas pasan;
- el repositorio no tiene commits ni archivos seguidos por Git;
- Pi Durable está fijado en `1.0.1` y su API es experimental;
- el código fue documentado como validado con Pi `1.0.1`, mientras el entorno inspeccionado usa Pi `1.0.4`.

Estas observaciones son históricas y no autorizan cambios de código. El baseline se creó después, con autorización humana, en `efc690ffdf15c3157eb7167a02dac12f6668843a`. Al iniciar el diseño de fase 00 se verificaron árbol limpio, `npm run check` y 9/9 pruebas. Esa observación corresponde al baseline histórico; el cierre posterior figura en el mapa global y en la [spec de fase 00](000-preparacion-arquitectonica/spec.md).

## Mapa global

| Fase | Estado actual | Resultado principal | Depende de | Próxima acción |
| ---: | --- | --- | --- | --- |
| 00 | `completada` | Base versionada, tipada, modular y preparada para migraciones y recuperación | Base actual | Continuar con el diseño de la fase 01. |
| 01 | `completada` | Consulta, listado, espera, resultados, revisión y consumo | 00 | Continuar con el plan de implementación de fase 02. |
| 02 | `completada` | Cancelación, pausa, reanudación y retry durables | 01 | Cierre por aprobación humana y PR #4/#5 fusionados; main `f87d77e` revalidado con 99/99 pruebas. Mantener la pausa activa como no soportada y conservar los límites de evidencia del informe de aceptación. |
| 03 | `completada` | RPC versionado, capacidades, eventos, outbox y cliente caller | 01–02 | Implementación fusionada en la base `94288cc`; plan aprobado y método subagent-driven registrados. Revisión independiente inicial NO APTO; N1–N5 revalidados y corregidos, N6 cubierta por fixture v4 válida de recuperación/replay; fixes integrados por `9c87c77`/PR #13 y `54e095a`, comprobados en `main` y `origin/main`; la persona aceptó el veredicto favorable posterior y ordenó completar/promocionar la fase, aunque su informe independiente no es recuperable; excepción humana explícita registrada en `phase03-promotion.md`. Aceptación TUI recibida para todos los bloques guiados del candidato faux local temporal, sin proveedor remoto ni migración real. Cierre humano e integración en `main`, sin publicar paquete ni habilitar automáticamente 004–010; ver [matriz](../docs/PHASE-03-ACCEPTANCE.md). No reejecutar las tareas importadas. |
| 04 | `bloqueada` | Resultado JSON validado y gates deterministas | 01–03 | Elegir estrategia pública de structured output y ejecutor de gates. |
| 05 | `bloqueada` | Grupos y join durable sin síntesis automática | 01–04 | Cerrar atomicidad de membresía y predicados de éxito. |
| 06 | `bloqueada` | Aislamiento con worktrees y ramas candidatas | 01–05 | Decidir política de hooks, firma y limpieza; el baseline Git ya existe. |
| 07 | `bloqueada` | Steering durable, ordenado y auditable | 01–06 | Resolver steering sobre jobs pausados sin conversación activa. |
| 08 | `bloqueada` | Scheduling por sesión con misfire y deduplicación | 01–07 | Elegir parser temporal y retención de ocurrencias. |
| 09 | `bloqueada` | Workflows declarativos y recuperables | 01–08 | Fijar una única fuente de verdad para runs y steps. |
| 10 | `bloqueada` | TUI operativa y observabilidad humana | 01–09 | La interfaz completa sigue bloqueada. Widget A+B implementado y fusionado por PR #12; visto bueno humano conjunto registrado. Revalidación de 011 en `011-cierre-widget`: 328/328, check y segunda revisión independiente APTO. Candidato local faux aceptado humanamente el 2026-10-09 tras pasar la guía TUI; validación 011 cerrada con límites registrados, sin publicar/integrar correcciones ni promover fase 10. |

## Fase 00 — Preparación arquitectónica

Spec aprobada: [`00-preparacion-arquitectonica.md`](000-preparacion-arquitectonica/spec.md), aprobación humana del documento `c6fc78b` el 2026-10-06. Se eligió rediseño completo, migración humana por base con backup y compatibilidad limitada al entorno actual. El plan se ejecutó nativamente, tarea por tarea, hasta el commit `1200e33`; la aceptación TUI y la revisión independiente fueron confirmadas humanamente.

### Objetivo

Preparar la base para que las fases posteriores no multipliquen rutas de transición, payloads monolíticos ni pruebas frágiles.

### Gate de entrada

- inventario actual reproducible;
- `npm run check` y `npm test` verdes;
- aprobación humana del alcance de esta fase;
- decisión explícita sobre el commit base del repositorio.

### Entregables

- baseline Git revisado con al menos un commit;
- `tsconfig.json` y type-check real con `tsc --noEmit` o equivalente;
- separación entre adaptadores, servicios de dominio e infraestructura;
- sobre común de errores y tipo `Actor` compartido;
- estrategia de almacenamiento que separe índices compactos de payloads grandes;
- ledger durable de `requestId`, operación, hash de payload y respuesta;
- fixtures de una base v1 y helpers de cierre/reapertura;
- política de versiones soportadas de Pi y Pi Durable;
- README y arquitectura actualizados solo con comportamiento real.

### Diseño y verificación: registro histórico

- índice compacto, familias de jobs/resultados/solicitudes y metadatos de esquema;
- conversión atómica v1 → esquema 2 mediante mantenimiento humano y backup obligatorio;
- entorno objetivo: macOS arm64, Node `26.10.0`, Pi `1.0.4` y Pi Durable `1.0.1`, sin promesa sobre mínimos históricos;
- TypeScript estricto con declaraciones públicas del host, sin añadir copias directas de sus peers;
- este registro anterior al cierre dejó aceptación TUI, revisión independiente y matriz de caídas pendientes; el cierre humano posterior está registrado arriba. El informe de aceptación y README conservan discrepancias señaladas en `MIGRATION.md`; no se certifican de nuevo.

### Gate de salida

- todo el comportamiento existente continúa pasando;
- una fixture v1 abre y migra sin pérdida;
- una versión futura desconocida se rechaza claramente;
- los adaptadores no implementan transiciones de estado;
- consultas compactas no materializan resultados completos;
- reiniciar después de cada estado actual conserva la semántica documentada en las pruebas disponibles y en la aceptación humana.

## Fase 01 — Consulta, listado y espera

Spec normativa: [`01-consulta-listado-espera.md`](001-consulta-listado-espera/spec.md).

### Gate de entrada

- fase 00 completada;
- almacenamiento y ledger aprobados;
- política de actor definida para comando, tool y futuras llamadas RPC;
- conversión v1 → esquema 2 validada en fase 00 y ampliación esquema 2 → 3 diseñada y aprobada;
- plan de implementación revisado en `specs/001-consulta-listado-espera/plan.md`.

### Entregables

- servicios `getJob`, `listJobs`, `waitForJob` y recuperación de resultado;
- cursor keyset estable por `createdAt` e ID;
- revisión humana separada del resultado técnico;
- consumo idempotente sin depender de un anillo que permita reutilizar IDs antiguos;
- truncado de tools a 64 KiB con hash y longitud;
- comandos y tools definidos por la spec;
- migración explícita y atómica esquema 2 → 3 con backup;
- bloqueo del runtime mientras la migración esté pendiente;
- notificaciones sin extractos sensibles del resultado.

### Evidencia disponible

- implementación en la rama `feat/phase-01`;
- pruebas unitarias e integración de consulta, espera, revisión, consumo, migración 2 → 3, adaptadores y reapertura;
- gates automatizados: `npm run check`, `npm test` (81/81), smoke Pi offline y `npm pack --dry-run --json` verdes;
- matriz de aceptación: [`docs/PHASE-01-ACCEPTANCE.md`](../docs/PHASE-01-ACCEPTANCE.md).

### Gate de salida

Todos los criterios de aceptación de la spec 01 pasan, incluida reapertura, carreras de wait, revisión, consumo, truncado y migración. La revisión independiente y la aceptación humana TUI fueron confirmadas. La limitación ambiental de no poder repetir `tsc` en el checkout principal está documentada en [`docs/PHASE-01-ACCEPTANCE.md`](../docs/PHASE-01-ACCEPTANCE.md); no se instalaron dependencias para ocultarla.

## Fase 02 — Control durable del ciclo de vida

Spec normativa aprobada para planificación: [`02-control-ciclo-de-vida.md`](002-control-ciclo-de-vida/spec.md). El spike de APIs públicas de Pi Durable `1.0.1` está cerrado: cancelación cooperativa y reconciliación están disponibles; pausa activa no está expuesta y se degrada explícitamente a `PAUSE_ACTIVE_UNSUPPORTED`.

### Gate de entrada

- fase 01 completada;
- ledger de mutaciones operativo;
- tabla de transiciones aprobada;
- spike contra APIs públicas de aborto y pausa concluido;
- spec de fase 02 aprobada para planificación.

### Entregables

- control idempotente común para comando, tool y RPC futuro;
- migración explícita esquema 3 → 4 con backup y bloqueo del runtime;
- comandos `cancel`, `pause`, `resume`, `retry` y tool `pi_agents_control`;
- estados `paused`, `cancelling`, `cancelled` e incertidumbre `interrupted`;
- cancelación de jobs en cola y activos;
- pausa y reanudación de jobs en cola;
- retry como nuevo job enlazado e historial inmutable;
- historial de control auditable;
- reconciliación de cada ventana de caída.

### Bloqueo de capacidad

Pi Durable `1.0.1` expone abort de submission, conversación y task, pero no una pausa pública por conversación. Mientras esto siga así, la pausa activa debe responder `PAUSE_ACTIVE_UNSUPPORTED`; no puede simularse con un flag mientras la ejecución continúa.

### Gate de salida

Las transiciones válidas, conflictos, abortos inseguros, retries e idempotencia pasan tras cierre y reapertura. Una capacidad degradada queda visible en documentación y RPC posterior.

**Cierre registrado:** PR #4 y corrección PR #5 fusionados; `main` en `f87d77e` revalidado con `npm run check`, `npm test` (99/99) y smoke offline verdes. La persona responsable aprobó explícitamente las pruebas humanas y confirmó «PR validado». La revisión independiente se ejecutó, pero su resultado no fue recuperado por el asistente; no se afirma un veredicto favorable del informe. Véanse la decisión humana de cierre y los límites de evidencia en [`docs/PHASE-02-ACCEPTANCE.md`](../docs/PHASE-02-ACCEPTANCE.md).

## Fase 03 — Eventos y RPC versionado

Índice de spec: [Eventos y RPC](003-eventos-rpc/spec.md). Diseño aprobado humanamente el 2026-10-07; [plan](003-eventos-rpc/plan.md) aprobado y método subagent-driven con pi-durable-subagents registrados en la [fuente de `94288cc`](_archive/origin-main-94288cc/docs/superpowers/plans/2026-10-07-fase-03-eventos-rpc.md). T1–T9 y el cliente público están implementados en la base seleccionada. La [aceptación](../docs/PHASE-03-ACCEPTANCE.md) registra fase 03 completada e integrada en `main` (`9c87c77`/PR #13 y `54e095a`), con revisión independiente inicial NO APTO, correcciones N1–N5 y fixture N6, veredicto favorable posterior aceptado humanamente con excepción por informe no recuperable y aceptación TUI de todos los bloques guiados del candidato faux local temporal, sin proveedor remoto ni migración real. Se conservan límites de 256 bytes UTF-8 para requestId/callerId/sessionId y 128 caracteres para correlationId. La conciliación documental no es un rerun de sus gates.

### Gate de entrada

- fases 01–02 completadas;
- servicios de dominio invocables sin depender de comandos o tools;
- esquema de eventos y respuestas validable en runtime;
- lifecycle de suscripciones definido.

### Entregables

- namespace `pi-durable-subagents:*`;
- `ready`, `ping`, capacidades y límites;
- handlers RPC que reutilicen servicios de dominio;
- outbox durable con secuencia y deduplicación;
- eventos sin tareas, resultados, stdout ni secretos;
- cierre de listeners y rechazo durante shutdown.

### Decisiones acordadas en el diseño

- RPC fino para extensiones locales de confianza; actor `extension` y caller declarativo, sin autenticación ni revisión RPC habilitable por allowlist;
- outbox con documentos por evento e índices paginados, atomicidad obligatoria con transiciones y secuencia por sesión;
- pendientes sin descarte; ventana indexada de los últimos 1000 emitidos, sin prometer limpieza física del histórico;
- ledger existente sin TTL y canonización de dominio; `correlationId` separado del `requestId` durable;
- cancelación activa con confirmación humana TUI y protección frente a carreras; migración humana 4 → 5 con backup;
- diseño y plan aprobados; método subagent-driven registrado; revisión independiente inicial NO APTO, N1–N5 corregidos e integrados en `main` por `9c87c77`/PR #13 y `54e095a`, N6 cubierta por fixture v4 válida de recuperación/replay; veredicto favorable posterior aceptado humanamente y fase 03 completada por decisión explícita, con informe independiente no recuperable; aceptación TUI recibida para todos los bloques guiados del candidato faux local temporal; no implementación desde cero.

### Gate de salida

Transición y creación de evento ocurren en el mismo commit Durable. Las pruebas cubren duplicación entre emisión y confirmación, reapertura, timeouts, versiones incompatibles y coexistencia con upstream.

## Fase 04 — Resultados estructurados y gates

Spec normativa: [`04-resultados-estructurados-gates.md`](004-resultados-estructurados-gates/spec.md).

### Gate de entrada

- fases 01–03 completadas;
- spike de structured output concluido;
- validador JSON Schema y subconjunto soportado decididos;
- ejecutor de procesos con argv, timeout, señal y captura acotada definido.

### Entregables

- contrato de resultado estructurado capturado al crear el job;
- validación y una corrección máxima;
- gates secuenciales con intent persistido antes del efecto externo;
- resultados de stdout/stderr truncados con hash;
- estado público `gate_failed`;
- eventos y consultas sin filtrar contenido pendiente de revisión.

### Bloqueo de capacidad

Pi Durable `1.0.1` no expone constrained sampling público en su contrato de conversación. Debe elegirse entre una tool durable de resultado y extracción JSON estricta; no se usarán internals del proveedor.

### Gate de salida

Schemas, corrección, gates, timeouts, señales, caídas y worktree simulado cumplen los criterios de aceptación sin convertir un gate técnico en aprobación humana.

### Estado de aceptación

**Fase 04: completada.** La aceptación TUI humana, la revisión independiente y las pruebas focales fueron confirmadas explícitamente por la persona responsable en esta sesión. La verificación local ejecutada aquí también fue correcta: `npm run check` y `npm test` (346/346). La fase 10 continúa bloqueada.

## Fase 05 — Grupos y join

Spec normativa: [`05-grupos-join.md`](005-grupos-join/spec.md).

### Gate de entrada

- fases 01–04 completadas;
- predicados técnicos y de revisión estabilizados;
- servicios de consulta y control disponibles.

### Entregables

- `GroupsDoc` o familia equivalente versionada;
- membresía atómica con el job;
- sellado idempotente;
- condiciones `all`, `success`, `any` y `quorum`;
- deadlines persistidos;
- join sin cuerpos de resultados;
- cancelación de grupo separada de la cancelación de miembros.

### Gate de salida

La matriz de condiciones, carreras, deadlines vencidos durante cierre, límites y revisión humana pasa tras reapertura. No existe sintetizador automático.

## Fase 06 — Aislamiento con worktrees

Spec normativa: [`06-aislamiento-worktrees.md`](006-aislamiento-worktrees/spec.md).

### Gate de entrada

- fases 01–05 completadas;
- repositorio con `HEAD` y baseline limpio conocido;
- ejecutor Git por argv probado;
- política de hooks y firma aprobada;
- directorio administrado y validación de rutas definidos.

### Entregables

- captura del commit base al encolar;
- máquina durable de creación, ejecución, preservación y limpieza;
- cwd equivalente dentro del worktree;
- gates ejecutados en el aislamiento;
- rama candidata sin merge, rebase, push o promoción;
- locks por repo y recuperación por fase;
- protección contra traversal y symlinks.

### Decisiones abiertas

- ejecutar o deshabilitar hooks en commits automáticos;
- deshabilitar firma interactiva de forma reproducible;
- retención y reparación de worktrees ambiguos;
- tratamiento de agentes que crean sus propios commits.

### Gate de salida

Las pruebas cubren repos sin Git o HEAD, checkout sucio, fallos por fase, preservación idempotente, dos worktrees paralelos y ausencia total de promoción automática.

## Fase 07 — Steering durable

Spec normativa: [`07-steering-durable.md`](007-steering-durable/spec.md).

### Gate de entrada

- fases 01–06 completadas;
- semántica pública de `whenBusy: "steer"` validada;
- estados de pausa realmente alcanzables documentados;
- política de visibilidad por actor aprobada.

### Entregables

- cola FIFO durable de instrucciones;
- entrega con `requestId` estable;
- confirmación mediante estado durable de submission;
- historial y eventos sin mensaje completo;
- precedencia de cancelación y pausa;
- límites por job y por bytes.

### Contradicción que debe resolverse

La fase 02 permite `paused` desde `queued`, normalmente sin conversación creada. La fase 07 exige aceptar steering en `paused`, pero prohíbe modificar jobs `queued`. La spec debe limitar steering pausado a jobs con conversación activa o definir un error estable para el caso sin conversación.

### Gate de salida

Orden, deduplicación, aplicación en límite seguro, cierre en cada estado, visibilidad y conflictos pasan sin atribuir mensajes humanos al modelo.

## Fase 08 — Scheduling durable

Spec normativa: [`08-scheduling-durable.md`](008-scheduling-durable/spec.md).

### Gate de entrada

- fases 01–07 completadas;
- parser cron/intervalo/zona seleccionado;
- reloj inyectable disponible;
- propiedad única del SQLite validada;
- política de retención de ocurrencias aprobada.

### Entregables

- schedules versionados y snapshots inmutables;
- ocurrencias reservadas antes de crear jobs;
- políticas `skip`, `run_once` y `catch_up`;
- pausa, reanudación, delete y refresh;
- timer físico reconstruible y detenido en shutdown;
- auditoría de misfires y deduplicación.

### Gate de salida

Cron, DST, zonas, ausencias largas, caídas en reserva/creación/enlace y operaciones concurrentes pasan con reloj simulado y sin daemon externo.

## Fase 09 — Workflows declarativos

Spec normativa: [`09-workflows-declarativos.md`](009-workflows-declarativos/spec.md).

### Gate de entrada

- fases 01–08 completadas;
- esquemas de jobs, grupos, gates, worktrees y schedules estables;
- fuente de verdad del scheduler de workflows decidida;
- hash canónico de artefactos aprobables definido.

### Entregables

- carga confiable de YAML/JSON versionado;
- validación completa antes de crear efectos;
- DAG sin ciclos y límites de fan-out;
- steps `agent`, `fanout`, `join`, `gate` y `approval`;
- interpolación restringida sin evaluación arbitraria;
- reconciliador con requestIds deterministas;
- obsolescencia de aprobaciones cuando cambia la evidencia;
- cancelación y rerun con historial nuevo.

### Decisiones abiertas

- usar documentos, custom Durable Tasks o una combinación sin duplicar la fuente de verdad;
- representación canónica del conjunto aprobado;
- semántica exacta de `request_changes` sin bucles implícitos;
- omitir inclusión de workflows en V1 conforme a YAGNI.

### Gate de salida

Validación, recuperación por step, fan-out, approvals, cancelación y ataques de interpolación pasan. No existe JavaScript, shell implícito ni promoción automática.

## Fase 10 — Interfaz operativa

Spec normativa: [`10-interfaz-operativa.md`](010-interfaz-operativa/spec.md).

### Gate de entrada

- fases 01–09 completadas;
- servicios de dominio y vistas compactas estables;
- contratos headless comprobados;
- APIs públicas de TUI y keybindings confirmadas.

### Excepción acotada: widget de subagentes A+B

Autorización humana registrada el 2026-10-08: adelantar solo A+B de la [spec del widget](011-widget-subagentes/spec.md) y su [plan](011-widget-subagentes/plan.md), aprobados con método Native. La [fuente posterior](_archive/origin-main-94288cc/docs/superpowers/plans/2026-10-08-widget-subagentes.md) registra excepción humana del 2026-10-09 para ejecutar B antes de aceptar A y decidir ambas conjuntamente. PR #12 fusionó A+B; [WIDGET-ACCEPTANCE](../docs/WIDGET-ACCEPTANCE.md) registra visto bueno conjunto y límites. No se retira esa aprobación ni se atribuye aceptación a escenarios no observados. No habilita el panel ni fase 10 completa.

La validación inicial de APIs en Pi **1.1.0** / Pi Durable **1.0.1** y el baseline **98/99** por host 1.0.4 son históricos. La consolidación posterior incorporó la detección/alineación de peers del host, no un parche de esta sesión para ocultar fallos. La matriz del widget registra **321/321** históricas y aceptación humana acotada, sin prometer Pi 1.0.4. La revalidación actual desde `94288cc` y las correcciones se registran por separado: 328/328 y check verdes, revisión independiente APTO y aceptación humana de la guía TUI local faux el 2026-10-09. Validación de 011 cerrada, no integración/publicación. Compactación de hijo, retry automático/deferred y fallos de lectura/adquisición lenta no fueron inducidos en terminal; no se inventa observación de toda la matriz.

### Entregables

- panel `/subagents` para jobs, grupos, schedules, workflows y recuperación;
- confirmaciones proporcionales a cada efecto;
- detalle paginado y carga diferida de payloads grandes;
- refresco por eventos más relectura durable;
- tratamiento seguro de ANSI y contenido no confiable;
- widget opcional no invasivo;
- funcionamiento equivalente en TUI, print, JSON y RPC.

### Gate de salida

Componentes, navegación, contenido hostil, resultados grandes, eventos duplicados y modos headless pasan. La UI no crea semántica de negocio ni aprueba al leer.

## Gates transversales obligatorios

### Persistencia y migraciones

- cada forma persistida tiene versión y migración determinista;
- se prueba una base creada por la versión anterior;
- versiones futuras desconocidas se rechazan;
- migraciones irreversibles documentan backup o rollback;
- payloads grandes no forman parte de listados compactos.

### Recuperación

- se cierra y reabre el Harness en cada nuevo estado no terminal;
- cada efecto externo identifica sus ventanas de caída;
- no se afirma `exactly once` sin transacción común;
- incertidumbre de herramientas o Git produce estado explícito, no éxito supuesto.

### Idempotencia

- toda mutación acepta o genera `requestId`;
- payload idéntico devuelve la respuesta previa;
- payload diferente devuelve `REQUEST_ID_CONFLICT`;
- la retención del ledger coincide con la promesa pública de deduplicación.

### Seguridad y autoridad

- confianza de proyecto no se presenta como sandbox;
- rutas se normalizan y validan antes de ejecutar o borrar;
- eventos y vistas compactas no incluyen resultados completos;
- aprobación humana registra actor, instante y motivo;
- ejecución, gates o éxito técnico nunca promocionan resultados;
- logs, exportaciones y UI aplican límites y redacción.

### Calidad

- type-check y pruebas pasan;
- pruebas incluyen unidad, integración Durable, carreras y reapertura;
- errores programáticos conservan códigos estables;
- README y arquitectura describen únicamente comportamiento implementado;
- cualquier API experimental o degradación queda documentada.

## Ciclo operativo de cada fase

1. Releer este roadmap y la spec de fase.
2. Confirmar que el gate de entrada está satisfecho.
3. Ejecutar los spikes públicos requeridos y registrar evidencia.
4. Corregir contradicciones o ambigüedades en la spec.
5. Obtener aprobación humana de la spec vigente.
6. Escribir y revisar el plan detallado de esa fase.
7. Elegir el método de ejecución.
8. Implementar con pruebas y migraciones.
9. Ejecutar el gate de salida completo.
10. Actualizar README, arquitectura, spec y roadmap.
11. Marcar `completada` solo con evidencia verificable.

## Registro de decisiones globales abiertas

| ID | Decisión | Afecta a | Criterio de cierre |
| --- | --- | --- | --- |
| RD-001 | Partición elegida en el [diseño 00](000-preparacion-arquitectonica/spec.md#modelo-persistente): índice y familias separadas | 00–10 | Spec aprobada; pendiente de evidencia de consultas compactas/migración con payload grande. |
| RD-002 | Entorno actual elegido; no preservar mínimos históricos como promesa | 00–10 | Spec aprobada; pendiente de type-check/smoke con Node `26.10.0`, Pi `1.0.4` y Durable `1.0.1`. |
| RD-003 | Semántica de pausa activa | 02, 07, 09, 10 | API pública confirmada o degradación estable documentada. |
| RD-004 | Estrategia de structured output | 04, 05, 09 | Spike público y corpus de validación aprobados. |
| RD-005 | Hooks y firma en commits automáticos | 06, 09 | Política reproducible y segura aprobada. |
| RD-006 | Steering sobre jobs pausados sin conversación | 07, 09, 10 | Estado elegible y error alternativo definidos en la spec. |
| RD-007 | Parser cron, zonas y retención de ocurrencias | 08, 09, 10 | Biblioteca/política elegidas y pruebas DST definidas. |
| RD-008 | Fuente de verdad del workflow scheduler | 09–10 | Diseño sin estado autoritativo duplicado aprobado. |

Cerrar una decisión requiere actualizar este registro y la spec afectada. No se elimina la fila: se marca la decisión y se enlaza su evidencia.

## Riesgos transversales

| Riesgo | Consecuencia | Mitigación del roadmap |
| --- | --- | --- |
| Documento monolítico con payloads grandes | Consultas y TUI degradadas; commits costosos | Resolver RD-001 en fase 00. |
| API experimental de Pi Durable | Rupturas de contratos y recuperación | Pin exacto, matriz de compatibilidad y spikes públicos. |
| Efectos externos fuera de SQLite | Duplicación o incertidumbre tras caída | Intent persistido, requestId, inspección antes de replay y estado `interrupted`. |
| Identidad no autenticada en `pi.events` | Aprobación o control atribuidos incorrectamente | RPC review apagado por defecto y actor humano solo desde UI/comando confiable. |
| Crecimiento de outbox, ledger y ocurrencias | SQLite sin límites operativos | Retención explícita que no invalide deduplicación ni auditoría. |
| Deriva entre docs y runtime | Usuarios confían en funciones inexistentes | Actualización documental dentro del gate de salida. |
| Datos sensibles en respuestas y logs | Exposición en sesión, eventos o UI | Separar payloads, truncar, hashear y redactar por defecto. |
| Complejidad acumulada de fases | Planes inmanejables y regresiones cruzadas | Una spec, un plan y una entrega por fase. |

## Política de evidencia y actualización

Cada cambio de estado debe registrar, dentro de este documento o mediante enlace estable:

- commit o release;
- comandos de verificación ejecutados;
- conteo y resultado de pruebas;
- fixture de migración utilizada;
- escenarios de cierre/reapertura;
- limitaciones conocidas y capacidades degradadas;
- decisión humana cuando aplique.

No son evidencia suficiente frases como “funciona”, “tests verdes” sin comando y resultado, ni una prueba estructural que no ejerza el comportamiento durable declarado.

Al completar una fase se actualizan como mínimo:

1. su estado en el mapa global;
2. su sección de entregables y evidencia;
3. las decisiones globales cerradas o nuevas;
4. los riesgos modificados;
5. la próxima acción de la fase siguiente.
