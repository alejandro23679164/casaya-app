# CasaYa — plataforma de servicios del hogar a demanda

Base de código para una app de servicios del hogar (plomería, electricidad, HVAC, pintura, limpieza, handyman) con despacho por geolocalización, pago en garantía y verificación de identidad en ambos lados.

## Estructura

```
casaya/
├── database/
│   ├── firestore-schema.json     Forma de cada colección, con tipos y campos de solo-backend
│   ├── firestore.rules           Reglas de seguridad (el dinero y el PIN nunca se escriben desde el cliente)
│   ├── schema.sql                Equivalente PostgreSQL/Supabase con PostGIS y RLS
│   └── seed_services.json        Catálogo inicial: 21 servicios en 6 categorías
├── functions/                    Backend: Cloud Functions v2 en TypeScript
│   └── src/
│       ├── config/constants.ts   Comisiones, radios de despacho, umbrales de seguridad
│       ├── domain/
│       │   ├── pricing.ts        Motor de cotización (función pura, testeable)
│       │   ├── geo.ts            Haversine, geohash, difuminado de ubicación, ETA
│       │   └── pin.ts            Generación y verificación del PIN (PBKDF2 + tiempo constante)
│       ├── services/escrow.ts    Retención, liberación y devolución en el procesador de pagos
│       ├── http/
│       │   ├── requests.ts       Cotizar, crear (con escrow) y cancelar
│       │   ├── dispatch.ts       Asignación por cercanía y aceptación con carrera resuelta
│       │   ├── jobFlow.ts        En camino, check-in, check-out, liberación por PIN, disputa
│       │   ├── verification.ts   KYC del técnico y verificación del cliente
│       │   └── safety.ts         Traza GPS y botón de pánico
│       └── triggers/scheduled.ts Vencimiento de ofertas, liberación automática, reputación
└── app/                          Flutter: iOS, Android y web desde la misma base
    └── lib/
        ├── core/theme.dart               Tokens de diseño
        ├── models/models.dart            Modelos de dominio
        ├── data/repositories.dart        Providers de Riverpod y acceso a datos
        └── features/
            ├── client/  Categorías · nueva solicitud con fotos y mapa · seguimiento · PIN
            ├── tech/    Bandeja de ofertas · trabajo activo con check-in/out
            └── shared/  Botón de pánico
```

## Las cinco decisiones que sostienen el sistema

**1. El cliente no escribe nada que importe.** Precio, estado del servicio, veredicto de KYC y movimientos de dinero solo se escriben desde Cloud Functions con el Admin SDK. Las reglas de Firestore cierran la escritura directa a `requests` y `transactions` por completo. Un atacante con el token de un usuario legítimo no puede darse un trabajo gratis.

**2. El PIN se guarda hasheado.** Un PIN de 4 dígitos tiene 10.000 combinaciones: guardarlo en claro convierte cualquier acceso de lectura a la base en acceso al dinero. Se almacena con PBKDF2 y sal, se compara en tiempo constante, y el contador de intentos vive dentro de la misma transacción que la verificación, así que no se puede evadir disparando pedidos en paralelo.

**3. El escrow usa autorización manual, no cobro y devolución.** `capture_method: 'manual'` retiene el importe sin cobrarlo. Si el servicio se cancela, el cliente nunca ve un cargo en su resumen. Toda operación contra el procesador lleva `idempotencyKey`: un reintento por timeout jamás cobra dos veces.

**4. La dirección exacta se revela al aceptar.** Antes, el técnico ve una ubicación difuminada a ~1 km, determinística por solicitud para que no se pueda triangular pidiendo el dato varias veces. Ve las fotos, la descripción, la distancia y lo que va a cobrar: suficiente para decidir, no suficiente para presentarse sin haber aceptado.

**5. Cada transición deja prueba.** Check-in validado contra GPS (más de 150 m del domicilio y no entra), check-out con foto obligatoria, bitácora inmutable de eventos en `requests/{id}/events`. Un reclamo deja de ser la palabra de uno contra la del otro.

## Flujo completo

```
Cliente elige servicio → sube fotos → confirma ubicación
        ↓
createServiceRequest: cotiza · retiene el pago · genera el PIN · despacha
        ↓
dispatchRequest: ofrece a 5 técnicos en 3 km, 45 s; si nadie acepta → 6 km → 10 → 18
        ↓
acceptRequest (transacción: gana el primero) → se revela la dirección exacta
        ↓
startTrip → traza GPS visible para el cliente
        ↓
checkIn (validado por GPS) → in_progress
        ↓
checkOut con foto del trabajo terminado → la app del cliente muestra el PIN
        ↓
releasePaymentWithPin → captura + transferencia al técnico
        (o liberación automática a las 72 h si el cliente no confirma ni disputa)
```

## Puesta en marcha

```bash
# Backend
cd functions
npm install
cp .env.example .env            # completar claves del procesador de pagos y del proveedor de KYC
npm run build
firebase deploy --only functions,firestore:rules

# Cargar el catálogo de servicios
node -e "require('firebase-admin').initializeApp(); \
  require('./database/seed_services.json').forEach(s => \
    require('firebase-admin').firestore().collection('services').doc(s.id).set({...s, active: true}))"

# App
cd ../app
flutter pub get
flutter run                     # móvil
flutter run -d chrome           # web
flutter build web --release
```

## Qué falta antes de producción

- **Integrar el proveedor de KYC.** `verification.ts` tiene el punto exacto donde va la llamada (Veriff, Truora, Metamap o similar) y el webhook que recibe el veredicto. Sin eso, `technician.status` nunca pasa a `approved`.
- **Integrar el procesador de pagos real.** El código usa Stripe Connect; para Argentina o México probablemente convenga MercadoPago con reservas de saldo. La interfaz de `escrow.ts` está pensada para que cambie la implementación y no los llamadores.
- **Proxy de voz para las llamadas.** Hoy cliente y técnico se llaman con el número real. Un proxy (Twilio Voice o equivalente) enmascara ambos números y corta el canal al terminar el servicio.
- **Tests del motor de cotización y del despacho.** Son lógica pura: `pricing.ts` y `geo.ts` se testean sin emuladores. El flujo de PIN y escrow necesita los emuladores de Firebase.
- **Retención de la traza GPS.** Definir una política de borrado automático (30 días es razonable) para no acumular el historial de movimientos de los técnicos sin necesidad.
- **Revisión legal por país.** El manejo de datos biométricos (la selfie con prueba de vida) y de antecedentes penales está regulado de forma distinta en cada jurisdicción, y la retención de fondos de terceros puede requerir licencia.
