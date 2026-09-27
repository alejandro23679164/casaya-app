import 'package:cloud_firestore/cloud_firestore.dart';

/// Modelos de dominio. Se construyen desde Firestore con constructores
/// `fromDoc` explícitos: si el esquema cambia, rompe acá y no en la UI.

enum ServiceCategory { plumbing, electrical, hvac, painting, cleaning, handyman }

extension ServiceCategoryX on ServiceCategory {
  String get label => switch (this) {
        ServiceCategory.plumbing => 'Plomería',
        ServiceCategory.electrical => 'Electricidad',
        ServiceCategory.hvac => 'Aire acondicionado',
        ServiceCategory.painting => 'Pintura',
        ServiceCategory.cleaning => 'Limpieza',
        ServiceCategory.handyman => 'Arreglos generales',
      };

  String get hint => switch (this) {
        ServiceCategory.plumbing => 'Destapes, fugas, grifería, tanques',
        ServiceCategory.electrical => 'Cortocircuitos, cableado, tableros, luces',
        ServiceCategory.hvac => 'Mantenimiento, instalación, carga de gas',
        ServiceCategory.painting => 'Interior, exterior, impermeabilización',
        ServiceCategory.cleaning => 'Profunda, mantenimiento, post obra',
        ServiceCategory.handyman => 'Muebles, cerraduras, colgar cosas',
      };

  IconDataRef get icon => switch (this) {
        ServiceCategory.plumbing => IconDataRef('plumbing'),
        ServiceCategory.electrical => IconDataRef('bolt'),
        ServiceCategory.hvac => IconDataRef('ac_unit'),
        ServiceCategory.painting => IconDataRef('format_paint'),
        ServiceCategory.cleaning => IconDataRef('cleaning_services'),
        ServiceCategory.handyman => IconDataRef('handyman'),
      };
}

/// Referencia liviana a un ícono para no acoplar el modelo a Flutter.
class IconDataRef {
  final String name;
  const IconDataRef(this.name);
}

enum RequestStatus { pending, accepted, enRoute, inProgress, completed, cancelled, disputed }

RequestStatus _statusFrom(String raw) => switch (raw) {
      'pending' => RequestStatus.pending,
      'accepted' => RequestStatus.accepted,
      'en_route' => RequestStatus.enRoute,
      'in_progress' => RequestStatus.inProgress,
      'completed' => RequestStatus.completed,
      'disputed' => RequestStatus.disputed,
      _ => RequestStatus.cancelled,
    };

extension RequestStatusX on RequestStatus {
  /// Texto que ve el cliente. Describe qué está pasando, no el estado interno.
  String get clientLabel => switch (this) {
        RequestStatus.pending => 'Buscando técnico disponible',
        RequestStatus.accepted => 'Técnico asignado',
        RequestStatus.enRoute => 'En camino',
        RequestStatus.inProgress => 'Trabajando',
        RequestStatus.completed => 'Terminado',
        RequestStatus.cancelled => 'Cancelado',
        RequestStatus.disputed => 'En revisión',
      };
}

enum Urgency { standard, sameDay, express }

extension UrgencyX on Urgency {
  String get wire => switch (this) {
        Urgency.standard => 'standard',
        Urgency.sameDay => 'same_day',
        Urgency.express => 'express_2h',
      };
  String get label => switch (this) {
        Urgency.standard => 'Cuando se pueda',
        Urgency.sameDay => 'Hoy mismo',
        Urgency.express => 'En 2 horas',
      };
}

class ServiceItem {
  final String id;
  final ServiceCategory category;
  final String name;
  final String description;
  final int basePrice;       // centavos
  final String currency;
  final int estimatedMinutes;
  final String pricingModel;

  const ServiceItem({
    required this.id,
    required this.category,
    required this.name,
    required this.description,
    required this.basePrice,
    required this.currency,
    required this.estimatedMinutes,
    required this.pricingModel,
  });

  factory ServiceItem.fromDoc(DocumentSnapshot doc) {
    final d = doc.data()! as Map<String, dynamic>;
    return ServiceItem(
      id: doc.id,
      category: ServiceCategory.values.byName(d['category'] as String),
      name: d['name'] as String,
      description: d['description'] as String,
      basePrice: d['basePrice'] as int,
      currency: d['currency'] as String? ?? 'ARS',
      estimatedMinutes: d['estimatedMinutes'] as int? ?? 60,
      pricingModel: d['pricingModel'] as String,
    );
  }

  bool get isEstimate => pricingModel != 'fixed';
}

class Quote {
  final String currency;
  final int total;
  final int serviceFee;
  final int taxes;
  final bool isEstimate;

  const Quote({
    required this.currency,
    required this.total,
    required this.serviceFee,
    required this.taxes,
    required this.isEstimate,
  });

  factory Quote.fromMap(Map<String, dynamic> m) => Quote(
        currency: m['currency'] as String,
        total: m['total'] as int,
        serviceFee: m['serviceFee'] as int,
        taxes: m['taxes'] as int,
        isEstimate: m['isEstimate'] as bool? ?? true,
      );
}

class ServiceRequest {
  final String id;
  final String clientId;
  final String? technicianId;
  final String serviceId;
  final ServiceCategory category;
  final RequestStatus status;
  final String description;
  final List<String> mediaPaths;
  final double lat;
  final double lng;
  final String addressLine;
  final Quote quote;
  final DateTime createdAt;
  final DateTime? checkOutAt;

  const ServiceRequest({
    required this.id,
    required this.clientId,
    required this.technicianId,
    required this.serviceId,
    required this.category,
    required this.status,
    required this.description,
    required this.mediaPaths,
    required this.lat,
    required this.lng,
    required this.addressLine,
    required this.quote,
    required this.createdAt,
    required this.checkOutAt,
  });

  factory ServiceRequest.fromDoc(DocumentSnapshot doc) {
    final d = doc.data()! as Map<String, dynamic>;
    final geo = (d['address']?['geo'] ?? d['coarseGeo']) as Map<String, dynamic>;
    return ServiceRequest(
      id: doc.id,
      clientId: d['clientId'] as String,
      technicianId: d['technicianId'] as String?,
      serviceId: d['serviceId'] as String,
      category: ServiceCategory.values.byName(d['category'] as String),
      status: _statusFrom(d['status'] as String),
      description: d['description'] as String? ?? '',
      mediaPaths: ((d['media'] ?? []) as List).map((m) => m['storagePath'] as String).toList(),
      lat: (geo['lat'] as num).toDouble(),
      lng: (geo['lng'] as num).toDouble(),
      addressLine: d['address']?['line1'] as String? ?? 'Zona aproximada',
      quote: Quote.fromMap(Map<String, dynamic>.from(d['quote'] as Map)),
      createdAt: (d['timeline']?['createdAt'] as Timestamp?)?.toDate() ?? DateTime.now(),
      checkOutAt: (d['timeline']?['checkOutAt'] as Timestamp?)?.toDate(),
    );
  }

  /// El PIN se muestra al cliente solo cuando el técnico cerró el trabajo.
  bool get awaitingPin => checkOutAt != null && status == RequestStatus.inProgress;
}

class DispatchOffer {
  final String id;
  final String requestId;
  final double distanceKm;
  final int estimatedPayout;
  final DateTime expiresAt;

  const DispatchOffer({
    required this.id,
    required this.requestId,
    required this.distanceKm,
    required this.estimatedPayout,
    required this.expiresAt,
  });

  factory DispatchOffer.fromDoc(DocumentSnapshot doc) {
    final d = doc.data()! as Map<String, dynamic>;
    return DispatchOffer(
      id: doc.id,
      requestId: d['requestId'] as String,
      distanceKm: (d['distanceKm'] as num).toDouble(),
      estimatedPayout: d['estimatedPayout'] as int,
      expiresAt: (d['expiresAt'] as Timestamp).toDate(),
    );
  }

  Duration get timeLeft => expiresAt.difference(DateTime.now());
}
