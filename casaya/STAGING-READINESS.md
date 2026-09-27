# CasaYa — ¿está listo para staging?

Respuesta corta: **el código sí. Faltan dos pasos manuales, fuera del repositorio, y ya se puede correr el ciclo completo en sandbox.** Los tres bloqueantes duros que este documento fue acumulando —la pasarela desconectada, las reglas de Storage ausentes, el modelo de captura/payout mal armado— están cerrados. Lo que queda es autenticar clientes de verdad y habilitar el producto Payouts en el panel de Mercado Pago; ninguno de los dos es una cuestión de arquitectura.

No es una crítica al ritmo del proyecto — para el volumen de superficie que cubrimos (backend completo, app cliente y técnico, panel, pagos con ciclo financiero completo, conciliación) esto es exactamente la cantidad de cabos sueltos esperable, y todos quedaron a la vista antes de que costaran algo. La idea de este documento sigue siendo que decidas con datos, no que te frene.

## Hallazgo original: la pasarela no estaba conectada — CERRADO

Al auditar el código encontré que `createServiceRequest` y `releasePaymentWithPin` seguían llamando a un `escrow.ts` que hablaba con el SDK de Stripe directo — la integración de Mercado Pago quedó escrita en una sesión pero nunca conectada a los flujos reales. Corregido: `escrow.ts` ahora delega en `gatewayFor()`/`gatewayByPsp()`, y esa misma corrección fue la que destapó el Bloqueante #1 de abajo.

## Bloqueante #1 — CERRADO: retención → captura → transferencia, confirmada por webhook

Estado anterior de este documento: el collector se fija al crear el pago, no al capturarlo, y faltaba el paso de transferencia al técnico. Ya está resuelto, con el diseño real que surgió de leer la documentación vigente de Mercado Pago (no de memoria — ver el comentario grande al principio de `mercadopago.ts` para el detalle completo).

**Lo que cambió de fondo:** el payout es un producto aparte de Mercado Pago (`/v1/payouts`), con su propia habilitación en el panel, y responde de forma asincrónica — 202 al crear, confirmación real recién por webhook. Eso significa que "liberar el pago" ya no es una operación, son tres, cada una con su propio estado en `transactions.status`:

```
held → captured → payout_pending → released
                                 ↘ payout_failed  (necesita ops)
```

- **`held → captured`**: se captura contra la cuenta de la PLATAFORMA (nunca la del técnico — Mercado Pago no permite reasignar el collector después de crear el pago).
- **`captured → payout_pending`**: se dispara la transferencia a la cuenta vinculada del técnico (identificada por email, no por el id de OAuth).
- **`payout_pending → released`**: solo lo confirma el webhook de payout (`handlePayoutUpdate` en `webhooks.ts`) o el job de reintento — nunca una respuesta HTTP optimista.

**Un solo lugar mueve dinero:** `captureAndPayout()` en `escrow.ts`. Lo usan tanto la liberación por PIN (`jobFlow.ts`) como la resolución de disputas (`admin.ts`) — antes cada uno tenía su propia lógica de captura, ahora comparten una sola, y ninguna de las dos marca `released` por su cuenta.

**Reintento acotado, no automático a ciegas** (`retryStuckPayouts`, cada 30 min en `reconciliation.ts`): un pago `captured` sin payout disparado se reintenta solo — es seguro, no vuelve a cobrar nada. Un `payout_pending` sin confirmación se consulta contra el proveedor antes de tocar nada. Un `payout_failed` —el proveedor confirmó el fallo— **no se reintenta automáticamente**: queda para que una persona entienda por qué falló (destino inválido, cuenta desvinculada) antes de disparar un intento nuevo.

**La UI ya no promete lo que el modelo no puede garantizar.** La pantalla de vinculación decía "el dinero entra directo a tu cuenta, no pasa por la nuestra" — eso era literalmente falso con este diseño. Corregido en las dos pantallas del técnico (vinculación y trabajo activo): el texto ahora dice que la transferencia se dispara en cuanto el cliente confirma con el PIN y que normalmente se acredita en minutos, sin prometer un instante. "Pago liberado" pasó a "Tu pago está en camino" hasta que de verdad hay confirmación — la pantalla de trabajo activo todavía no mira `transactions.status` para mostrar la confirmación real; queda en la lista de pendientes más abajo.

**Verificado contra documentación real, con una honestidad pendiente:** encontré el endpoint de creación (`POST /v1/payouts`) documentado y confirmado. No encontré, en la misma búsqueda, un GET de un solo payout por id igual de confirmado — `fetchPayoutStatus` en `mercadopago.ts` lo usa como respaldo para el job de reintento, con un comentario explícito de que hay que confirmarlo contra la referencia vigente antes de depender de él en producción. El webhook sigue siendo el camino principal; esto es solo la red de contención cuando el webhook se pierde.

**Antes de un piloto con dinero real (no bloquea sandbox):**
1. Habilitar el producto "Payouts" en el panel de Mercado Pago — es un alta manual, aparte de la app de marketplace ya usada para OAuth. Sin esto, `POST /v1/payouts` falla aunque el resto de las credenciales esté bien.
2. Confirmar contra la documentación vigente el endpoint real de consulta de un payout por id (o su equivalente), y ajustar `fetchPayoutStatus` si hace falta.
3. Wire `active_job_screen.dart` a `transactions/{id}.status` para mostrar "pago acreditado" con confirmación real, en vez de solo el disparo.

## Bloqueante #2: no hay reglas de Cloud Storage — CERRADO

Encontrado en el mismo barrido: `firestore.rules` existe y es estricto; `storage.rules` no existía en absoluto. Sin ese archivo, Cloud Storage aplica el default del proyecto — según cómo se haya inicializado, eso es "nadie puede escribir" (rompe la subida de fotos del problema y del check-out, que son el corazón del sistema de evidencia) o "cualquiera con el link puede leer" (expone selfies y antecedentes penales de KYC a quien adivine una ruta).

**Ya corregido:** `database/storage.rules`, con las mismas tres reglas que ya regían en espíritu para Firestore — fotos de solicitud legibles por las partes involucradas, documentos de KYC solo para su dueño y administración, todo lo demás cerrado por defecto. Falta desplegarlo (`firebase deploy --only storage`) y, si el proyecto Firebase todavía no tiene Storage habilitado, activarlo desde la consola.

## Bloqueante #3: no hay autenticación de cliente real — CERRADO

`_AuthPlaceholder` era un `Text` fijo. Reemplazado por `phone_auth_screen.dart`: OTP real con `verifyPhoneNumber`/`signInWithCredential`, con detección automática del SMS en Android y reintento manual en el resto. Firebase deja `phone_number` en el token de sesión apenas el sign-in por teléfono se confirma, así que `requireVerifiedClient` en `requests.ts` ya queda satisfecho sin nada más.

**Lo que destapó el propio arreglo:** ningún lado del sistema creaba el documento `users/{uid}` — el primer login de cualquier cliente habría pegado contra un documento inexistente en el primer intento de pedir un servicio. Agregado `ensureUserProfile`, un callable idempotente que arma el perfil base (rol `client`, teléfono, `phoneVerified`) la primera vez que alguien entra, llamado automáticamente desde la pantalla de login apenas el OTP se confirma.

**Falta a mano en el panel de Firebase, no en el código:** habilitar el proveedor "Phone" en Authentication → Sign-in method. Pasos exactos en `BUILD-APK.md`.

## Con stub — sirven para probar la forma del flujo, no el contenido

Ninguno de estos rompe una prueba de staging orientada a validar la arquitectura (que las pantallas naveguen, que el despacho asigne, que el escrow retenga y transfiera). Sí van a dar resultados falsos o vacíos en cualquier prueba que dependa de su contenido real.

| Dónde | Qué simula | Qué falta |
|---|---|---|
| `new_request_screen.dart` → `_selectedPaymentMethodId()` | Devuelve `'pm_default'` fijo | Integrar el SDK de tokenización de tarjeta de Mercado Pago (Checkout Bricks o MP.js) del lado del cliente |
| `job_feed_screen.dart` → `_ProblemPhoto` | Un ícono gris | `FirebaseStorage.ref(path).getDownloadURL()` envuelto en `CachedNetworkImage` |
| `verification.ts` → `submitKycDocument` | Guarda el documento, no llama a ningún proveedor | Integrar Veriff/Truora/Metamap; el punto exacto está comentado en el archivo |
| `admin.ts` → `reviewKyc` | Existe y funciona, pero es el único camino real hoy | Es el fallback correcto mientras no haya proveedor automático — no es un problema, es cómo se prueba KYC en staging |
| `reconciliation.ts` → `requestSettlementReport` | Pide el reporte, no lo procesa | Falta el webhook que avisa cuándo está listo y el parseo del CSV |
| `active_job_screen.dart` → estado "Tu pago está en camino" | Muestra el disparo del payout, no su confirmación | Mirar `transactions/{id}.status` en vivo para pasar a "pago acreditado" cuando el webhook confirme `released` |
| `mercadopago.ts` → `fetchPayoutStatus` | Consulta un GET no verificado contra la documentación | Confirmar el endpoint real antes de depender de él fuera del sandbox — el webhook sigue siendo el camino principal, esto es solo la red de contención |

## Sin construir todavía (no bloquean staging, sí un piloto real)

- Tests unitarios de `pricing.ts`, `geo.ts`, `pin.ts` y `disputes.ts`. Es lógica pura, se testea sin emuladores, y es exactamente el tipo de código donde un test de 10 líneas ahorra un bug de redondeo en producción. Lo dejaría como la primera tarea de la semana que viene — junto con un test del propio `computeSettlement` de `disputes.ts` contra los nuevos estados de `captureAndPayout`, ya que es donde más plata real se mueve por línea de código.
- Proxy de voz para las llamadas entre cliente y técnico (hoy se llaman con el número real).
- Vista de conciliación dentro del panel — hoy las diferencias quedan en Firestore y se miran desde la consola.
- Respuesta automática a contracargos.
- Definición con un contador de cómo se calculan retenciones/percepciones sobre `platformFee`.
- Habilitar el producto "Payouts" en el panel de Mercado Pago (alta manual, ver Bloqueante #1) — sin esto el sandbox tampoco transfiere de verdad, solo queda en `captured`.

## Recomendación concreta

**Para probar el ciclo financiero completo en sandbox esta semana:** los tres bloqueantes están cerrados del lado del código. Lo único que queda es manual y fuera del repositorio — habilitar "Payouts" en el panel de Mercado Pago (sandbox) y resolver la autenticación de cliente. Con eso, el recorrido completo es probable de punta a punta: solicitud → despacho → retención → check-out → PIN → captura → transferencia → webhook → `released`.

**Para un piloto con técnicos y clientes reales cobrando de verdad, además de lo anterior:**
- Confirmar el endpoint de `fetchPayoutStatus` contra la documentación vigente (hoy es la única pieza del ciclo de dinero que no verifiqué contra una fuente confirmada).
- Integración de KYC con un proveedor real — sin eso, cada técnico entra por revisión manual, que no escala más allá de un puñado de personas.
- El SDK de tokenización de tarjeta del lado del cliente.

El orden que yo seguiría: autenticación de cliente primero (sin eso no arranca ni la primera prueba), habilitar Payouts en paralelo (es un trámite de panel, no bloquea nada más mientras se resuelve), y recién después las piezas de KYC y tokenización — esas sí son necesarias para un piloto, no para validar que la arquitectura funciona.
