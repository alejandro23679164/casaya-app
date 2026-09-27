# Vinculación de cobros y conciliación

Tercera entrega. Cierra el circuito del dinero: el técnico conecta su cuenta, el dinero se mueve, y un job verifica todos los días que lo que dice nuestra base sea lo que pasó de verdad.

## Archivos nuevos

```
functions/src/
├── http/payoutLink.ts              OAuth de Mercado Pago: iniciar, completar, consultar, desvincular
└── triggers/reconciliation.ts      Conciliación diaria + pedido semanal del reporte de liquidaciones

app/lib/features/tech/
└── payout_link_screen.dart         Pantalla del técnico para conectar su cuenta
```

Modificados: `jobFlow.ts` (corrección importante, abajo), `index.ts`, `main.dart` (ruta del redirect), `firestore.rules`.

## El agujero que encontré en `openDispute`

Al revisar el código antes de seguir, vi que `openDispute` marcaba la solicitud como `disputed` y detenía el reloj del escrow, pero **no creaba el documento en `disputes`**. El dinero quedaba congelado correctamente y el reclamo era invisible para el panel: la cola habría estado siempre vacía mientras los clientes esperaban una respuesta que nadie sabía que tenía que dar.

Ya está corregido. Ahora crea el documento con ambas partes, el tipo de reclamo y la prioridad calculada: `p0` para conducta insegura, `p1` cuando hay más de 50.000 en juego, `p2` el resto.

## Pantalla de vinculación

El técnico está por entregar acceso a su cuenta de dinero, así que la pantalla explica en texto plano qué autoriza y —más importante— qué no: la app no puede ver su saldo ni sus movimientos, ni sacar dinero, ni pagar en su nombre. Esa lista de cuatro ítems, dos con tilde y dos tachados, hace más por la conversión que cualquier botón grande.

Tres detalles del flujo:

**Se abre el navegador del sistema, no una webview.** Mercado Pago bloquea el login dentro de webviews embebidas, y además pedirle a alguien que escriba su contraseña bancaria dentro de nuestra app es justo el hábito que no conviene enseñar.

**El `state` es un candado real.** Se genera en el servidor, vence a los 15 minutos y se consume dentro de una transacción. Sin esa verificación, alguien puede inducir a un técnico a vincular una cuenta ajena y desviarse todos sus cobros.

**Una cuenta de Mercado Pago no puede quedar vinculada a dos técnicos.** Se rechaza explícitamente; es la vía más directa para robar cobros.

Cuando la cuenta está vinculada pero el KYC sigue en revisión, la pantalla lo dice. Sin eso, el técnico queda esperando trabajos que nunca llegan sin entender por qué.

## Conciliación

**Por qué hace falta:** los webhooks se pierden. Una función fría que agota el tiempo, un despliegue en el momento justo, una caída del lado del proveedor. Cuando pasa, la base dice una cosa y el dinero hizo otra, y nadie se entera hasta que alguien llama semanas después, cuando ya no se puede reconstruir qué ocurrió.

Corre a las 5 de la mañana sobre las últimas 30 horas —24 más 6 de solapamiento, porque un pago creado a las 23:58 puede acreditarse después de medianoche— y detecta cinco cosas:

| Diferencia | Qué significa |
|---|---|
| `missing_locally` | Hay un cobro en el proveedor sin transacción nuestra. Cobro huérfano. |
| `missing_remotely` | Tenemos una transacción activa sin pago del otro lado. |
| `status_mismatch` | Los dos lo conocen, en estados distintos. |
| `amount_mismatch` | Se cobró un monto distinto al registrado. |
| `stale_hold` | Retención de más de 5 días sin capturar: está por vencer y el técnico trabajó gratis. |

**La corrección automática es deliberadamente angosta.** Solo adelanta el estado local cuando el proveedor ya confirmó un movimiento que no registramos, y nunca al revés. Alinear en la otra dirección sería reescribir la realidad del dinero desde nuestra base, que es exactamente el error que el job busca detectar. Todo lo demás se anota en `reconciliation_issues` y va a revisión humana; si hay diferencias críticas, entra a la cola de operaciones con prioridad alta.

El job semanal pide el reporte de liquidaciones, que es distinto: muestra el dinero efectivamente acreditado con comisiones, impuestos y retenciones descontadas. Nunca coincide exactamente con la suma de los pagos, y es lo que se cruza contra la contabilidad. Se genera de forma asincrónica, así que falta engancharlo con el webhook que avisa cuando está listo.

## Configuración adicional

En `.env` del backend ya está `MP_OAUTH_REDIRECT_URI`. Tiene que estar registrada como URL de redirección en la aplicación de Mercado Pago, y coincidir carácter por carácter.

Deep link en móvil — declarar el esquema `casaya://`:

- **Android**, en `AndroidManifest.xml`, un `intent-filter` con `android:scheme="casaya"` y `android:host="cobros"` sobre la activity principal.
- **iOS**, en `Info.plist`, un `CFBundleURLTypes` con el mismo esquema.

En web no hace falta nada: el redirect vuelve a `/tecnico/cobros` con los parámetros en el query y `go_router` los pasa a la pantalla.

## Qué queda para la próxima

- **Webhook del reporte de liquidaciones**, para descargar el CSV y cruzarlo automáticamente contra el ledger.
- **Vista de conciliación en el panel.** Hoy las diferencias se escriben en Firestore y hay que mirarlas desde la consola; merecen una pestaña propia al lado de la cola de reclamos.
- **Respuesta automática al contracargo.** El expediente ya junta la evidencia; falta armar el paquete y enviarlo dentro del plazo del proveedor, que es corto y no admite prórroga.
- **Retenciones impositivas.** Sigue pendiente de resolver con un contador antes del primer cierre mensual, porque cambia el cálculo de `platformFee` y reajustarlo con la operación andando es mucho peor que definirlo ahora.
