# Plan de implementación: resultados estructurados y gates

**Feature**: `004-resultados-estructurados-gates`
**Estado**: aprobado para ejecución Native
**Spec**: [spec.md](spec.md)

## Decisiones autorizadas para este plan

- **Salida estructurada**: extracción de un único documento JSON estricto de la respuesta final. Texto no JSON antes o después invalida el payload; no se accede a APIs privadas de Pi Durable.
- **Gates**: ejecutor local basado en `node:child_process.spawn` con `command: string[]`, cwd explícito, timeout, señal y captura limitada. Shell desactivado por defecto.
- **Persistencia**: conservar el esquema 5; los campos nuevos son opcionales dentro de `JobDocument` y se validan al leer. No se abre una migración de datos para una capacidad opt-in; la forma existente conserva su versión y los nuevos valores no aparecen en jobs históricos.
- **Autoridad**: validar y ejecutar son operaciones técnicas. Ningún resultado de gate aprueba, consume o promociona un artefacto.

## Alcance

1. Capturar la configuración de `output_schema` y `gates` al admitir un job, con límites y hash canónico.
2. Validar el JSON estricto, permitir como máximo un turno de corrección y persistir el resultado estructurado separado de la respuesta textual.
3. Ejecutar gates secuencialmente solo después de validar; persistir `pending`/`running` antes del proceso externo y conservar salida truncada, tamaño y hash.
4. Recuperar una caída durante un gate como `interrupted`, sin reejecución automática.
5. Exponer estados, resultado y eventos sin filtrar cuerpos pendientes ni stdout/stderr completos.
6. Mantener revisión humana separada y retry como nuevo job con la configuración capturada.

Fuera de alcance: paralelización, retry individual de gates, shell habilitado por defecto, promoción, generación automática de schemas y constrained sampling.

## Constitution Check

| Principio | Aplicación | Evidencia exigida |
| --- | --- | --- |
| I. Fuente durable | Intención, contrato, estado del gate y resultado se escriben antes/después de cada frontera | migración, reapertura y recuperación |
| II. Idempotencia | requestId canónico para admisión y `gate:<job-id>:<index>` para cada gate | duplicados, conflictos y caída antes/después del proceso |
| III. Autoridad separada | ejecución técnica no cambia review ni promoción | pruebas de review/consume y eventos |
| IV. Exposición mínima | payload validado y salida de procesos se acotan; eventos omiten cuerpos | refs remotos, truncado/hash, RPC y tools |
| V. Contratos públicos | solo APIs públicas y `spawn`; sin internals ni dependencias nuevas hasta justificar validador | check, contrato y smoke |

## Diseño técnico

### Modelo y migración

- Extender `JobRecord`, `JobResult` y sus documentos con contrato, structured result, registros de gate y `technicalOutcome` opcionales durante la lectura de compatibilidad.
- Añadir validación de dominio para tamaños, profundidad, comandos, timeouts, códigos de salida, JSON finito y refs permitidos.
- Mantener compatibilidad de lectura con jobs del esquema 5 que no tienen contrato. Los campos nuevos permanecen opcionales durante esta versión; no se inventan contratos, resultados ni gates históricos.
- Capturar la configuración normalizada y su hash en la admisión; retry copia esa configuración al nuevo job, sin copiar el resultado.

### Validación y corrección

- Implementar un parser JSON estricto que rechace prose adicional, valores no finitos, prototipos exóticos, `$ref` remoto y `$ref` local fuera del mismo documento.
- Fijar el subconjunto de JSON Schema 2020-12 soportado y documentar keywords rechazadas/no soportadas.
- Separar `output_invalid` de `failed`; conservar la respuesta textual y no persistir un objeto parcialmente validado.
- Encapsular el único turno de corrección en el runtime existente; no añadir una segunda conversación ni reintentar indefinidamente.

### Ejecutor de gates

- Resolver cwd absoluto del job y rechazarlo si ya no existe.
- Ejecutar `spawn(command[0], command.slice(1), { cwd, shell: false })`; no interpolar comandos ni usar `exec`.
- Persistir `running` antes de arrancar el proceso y `passed`/`failed`/`timed_out` después de recoger exit code, señal y streams.
- Limitar cada stream a 1 MiB conservando longitud total, hash y truncado.
- Al reabrir, convertir `running` sin recibo terminal en `interrupted`; nunca relanzarlo automáticamente.
- Ejecutar en orden y detenerse en el primer fallo.

### Integración pública

- Extender inicio, status, result, retry, eventos y RPC/tools mediante los servicios de dominio existentes.
- Mantener `gate_failed` distinto de `failed`; un gate pasado no cambia `reviewStatus`.
- Redactar o truncar mensajes de error y evitar incluir schema, payload, stdout/stderr completo o argumentos sensibles en eventos por defecto.

## Secuencia y gates

1. **Contrato y fixtures**: tipos, validadores de entrada, canonicalización, migración v5 y pruebas RED.
2. **Resultado estructurado**: parser/validador JSON estricto, corrección única, persistencia/reapertura y pruebas de límites.
3. **Gates locales**: ejecutor argv, estados, timeout/señal, truncado/hash y recuperación; pruebas con procesos auxiliares controlados.
4. **Integración**: coordinator/runtime, query/result, retry, eventos y adaptadores; pruebas de contrato y regresión.
5. **Documentación y aceptación**: README/arquitectura solo con comportamiento implementado, `npm run check`, `npm test`, smoke Pi y revisión independiente.

## Riesgos y límites

- Si el validador JSON Schema elegido requiere una dependencia nueva, la implementación se detiene para justificarla y fijar su versión; no se instalará una dependencia por defecto durante la planificación.
- La ejecución local conserva los permisos del proceso Pi; no es sandbox.
- Una caída tras lanzar el proceso y antes de registrar su salida permanece incierta (`interrupted`), aunque el proceso externo pudiera haber tenido efectos.
- La aceptación TUI y la integración con Pi requieren evidencia separada; una suite automatizada no las sustituye.
