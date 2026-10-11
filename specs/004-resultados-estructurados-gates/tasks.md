# Tareas: resultados estructurados y gates

**Estado**: ejecución Native completada; gates técnicos y aceptación cerrados.
**Spec**: [spec.md](spec.md) · **Plan**: [plan.md](plan.md)

El plan fue aprobado para ejecución Native. Cada bloque debe dejar evidencia de comandos, versiones y resultado.

## Fase 1 — Contrato, persistencia y límites

- [x] T001 [US1] Añadir tipos de contrato para `output_schema`, gates, resultados estructurados, `technicalOutcome` y estados `gate_failed`/`gate_interrupted`; asociar límites y códigos estables.
- [x] T002 [US1] Escribir pruebas de canonicalización, tamaños, profundidad, comandos argv, timeout, códigos de salida, refs y valores JSON no válidos.
- [x] T003 [US1] Implementar validación de la configuración y captura canónica al admitir el job; rechazar antes de encolar entradas inválidas.
- [x] T004 [US1] Mantener lectura de jobs del esquema 5 sin contrato y validar campos nuevos opcionales sin inventar datos históricos; documentar por qué no aplica migración de esquema.
- [x] T005 [US1] Ejecutar pruebas de compatibilidad de jobs legacy, duplicados/conflictos y reapertura antes de continuar.

## Fase 2 — Resultado JSON estricto

- [x] T006 [US1] Hacer un spike del validador JSON Schema 2020-12; seleccionar una API/dependencia o documentar el subconjunto mínimo sin acceso privado.
- [x] T007 [US1] Escribir pruebas para JSON único estricto, prose adicional, límites, `$ref` local/remoto y keywords no soportadas.
- [x] T008 [US1] Implementar extracción/validación y persistir `structuredResult` separado de la respuesta textual; no guardar valores parcialmente validados.
- [x] T009 [US1] Completar pruebas de la corrección única en el runtime y de cierre/reapertura; la ruta runtime ya está integrada.

## Fase 3 — Ejecutor local de gates

- [x] T010 [US1] Completar pruebas con procesos auxiliares para argv sin shell, cwd ausente, exit code, señal, timeout, streams grandes y caída en cada ventana.
- [x] T011 [US1] Implementar el ejecutor local con `spawn`, timeout/señal, captura acotada, hash/tamaño y requestId determinista por gate.
- [x] T012 [US1] Persistir `pending`/`running` antes del efecto externo y cerrar cada gate con estado explícito; ejecutar secuencialmente y detenerse en el primer fallo.
- [x] T013 [US1] Completar pruebas de reconciliación de gates `running` como `interrupted` tras reapertura, sin replay automático.

## Fase 4 — Runtime, consultas y contratos públicos

- [x] T014 [US1] Integrar la secuencia respuesta → validación → gates → outcome en coordinator/runtime sin convertir gates en aprobación.
- [x] T015 [US1] Exponer fase, gate actual, conteo y resultado estructurado según la política de revisión; omitir cuerpos pendientes y streams completos en eventos/RPC/tools.
- [x] T016 [US1] Añadir evidencia específica de `gate_failed` y `gate_interrupted` en transiciones, eventos terminales, consulta, espera y formateo sin alterar el significado de `failed`.
- [x] T017 [US1] Añadir evidencia específica de retry con contrato capturado y de separación review/consume; cubrir idempotencia y conflictos.

## Fase 5 — Gates de entrega

- [x] T018 [US1] Actualizar README y `docs/ARCHITECTURE.md` solo con comportamiento implementado, límites y no-sandbox.
- [x] T019 [US1] Ejecutar `npm run check`, `npm test` y el smoke de carga Pi; registrar Node, Pi, Pi Durable y resultado.
- [x] T020 [US1] Obtener revisión independiente y aceptación humana aplicable; actualizar roadmap únicamente con evidencia verificable. Ambas fueron confirmadas explícitamente por la persona responsable en esta sesión.
