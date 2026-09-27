import 'dart:io';
import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:cloud_functions/cloud_functions.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:firebase_storage/firebase_storage.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:geolocator/geolocator.dart';

import '../models/models.dart';

/// Capa de datos. La UI nunca llama a Firestore ni a Cloud Functions
/// directamente: pide cosas a un repositorio. Cambiar Firebase por Supabase
/// significa reescribir este archivo y nada más.

final _db = FirebaseFirestore.instance;
final _fn = FirebaseFunctions.instanceFor(region: 'southamerica-east1');
final _auth = FirebaseAuth.instance;

// ---------------------------------------------------------------- providers

final authStateProvider = StreamProvider<User?>((ref) => _auth.authStateChanges());

final currentUserIdProvider = Provider<String?>((ref) => ref.watch(authStateProvider).value?.uid);

/// Catálogo de servicios de una categoría. Firestore cachea en disco, así que
/// la segunda visita abre sin spinner.
final servicesByCategoryProvider =
    StreamProvider.family<List<ServiceItem>, ServiceCategory>((ref, category) {
  return _db
      .collection('services')
      .where('category', isEqualTo: category.name)
      .where('active', isEqualTo: true)
      .snapshots()
      .map((s) => s.docs.map(ServiceItem.fromDoc).toList());
});

/// Solicitud en vivo: el estado, la cotización y el avance llegan solos.
final requestProvider = StreamProvider.family<ServiceRequest, String>((ref, requestId) {
  return _db.collection('requests').doc(requestId).snapshots().map(ServiceRequest.fromDoc);
});

/// Traza GPS del técnico para dibujar el recorrido en el mapa.
final trackingProvider = StreamProvider.family<List<({double lat, double lng})>, String>((ref, requestId) {
  return _db
      .collection('requests').doc(requestId)
      .collection('tracking').orderBy('at', descending: true).limit(60)
      .snapshots()
      .map((s) => s.docs
          .map((d) => (lat: (d['lat'] as num).toDouble(), lng: (d['lng'] as num).toDouble()))
          .toList()
          .reversed
          .toList());
});

/// Ofertas abiertas para el técnico conectado.
final incomingOffersProvider = StreamProvider<List<DispatchOffer>>((ref) {
  final uid = ref.watch(currentUserIdProvider);
  if (uid == null) return const Stream.empty();
  return _db
      .collection('dispatch_offers')
      .where('technicianId', isEqualTo: uid)
      .where('status', isEqualTo: 'sent')
      .snapshots()
      .map((s) => s.docs.map(DispatchOffer.fromDoc).toList());
});

final requestRepositoryProvider = Provider((ref) => RequestRepository());
final jobRepositoryProvider = Provider((ref) => JobRepository());
final safetyRepositoryProvider = Provider((ref) => SafetyRepository());

// ------------------------------------------------------------- repositorios

class RequestRepository {
  /// Cotización en vivo mientras el cliente arma el pedido.
  Future<Quote> getQuote({
    required String serviceId,
    required Urgency urgency,
    DateTime? scheduledFor,
    int? estimatedMinutes,
  }) async {
    final res = await _fn.httpsCallable('getQuote').call({
      'serviceId': serviceId,
      'urgency': urgency.wire,
      'scheduledFor': scheduledFor?.toIso8601String(),
      'estimatedMinutes': estimatedMinutes,
    });
    return Quote.fromMap(Map<String, dynamic>.from(res.data as Map));
  }

  /// Sube las fotos del problema antes de crear la solicitud. La ruta incluye
  /// el uid: las reglas de Storage impiden escribir en la carpeta de otro.
  Future<List<String>> uploadProblemPhotos(List<File> files) async {
    final uid = _auth.currentUser!.uid;
    final paths = <String>[];
    for (var i = 0; i < files.length; i++) {
      final path = 'requests/$uid/${DateTime.now().millisecondsSinceEpoch}_$i.jpg';
      await FirebaseStorage.instance.ref(path).putFile(files[i]);
      paths.add(path);
    }
    return paths;
  }

  /// Crea la solicitud. Devuelve el PIN: llega una sola vez, en esta respuesta.
  Future<({String requestId, String completionPin, Quote quote})> create({
    required String serviceId,
    required Urgency urgency,
    required String description,
    required String addressLine,
    String? addressNotes,
    required double lat,
    required double lng,
    required List<String> mediaPaths,
    required String paymentMethodId,
    DateTime? scheduledFor,
  }) async {
    final res = await _fn.httpsCallable('createServiceRequest').call({
      'serviceId': serviceId,
      'urgency': urgency.wire,
      'description': description,
      'address': {'line1': addressLine, 'notes': addressNotes ?? ''},
      'geo': {'lat': lat, 'lng': lng},
      'mediaPaths': mediaPaths,
      'paymentMethodId': paymentMethodId,
      'scheduledFor': scheduledFor?.toIso8601String(),
    });
    final d = Map<String, dynamic>.from(res.data as Map);
    return (
      requestId: d['requestId'] as String,
      completionPin: d['completionPin'] as String,
      quote: Quote.fromMap(Map<String, dynamic>.from(d['quote'] as Map)),
    );
  }

  Future<void> cancel(String requestId, String reason) =>
      _fn.httpsCallable('cancelServiceRequest').call({'requestId': requestId, 'reason': reason});

  Future<void> releasePayment(String requestId, String pin) =>
      _fn.httpsCallable('releasePaymentWithPin').call({'requestId': requestId, 'pin': pin});
}

class JobRepository {
  Future<void> accept(String requestId) =>
      _fn.httpsCallable('acceptRequest').call({'requestId': requestId});

  Future<void> reject(String requestId, {String? reason}) =>
      _fn.httpsCallable('rejectRequest').call({'requestId': requestId, 'reason': reason});

  Future<void> startTrip(String requestId) =>
      _fn.httpsCallable('startTrip').call({'requestId': requestId});

  Future<void> checkIn(String requestId) async {
    final pos = await Geolocator.getCurrentPosition(desiredAccuracy: LocationAccuracy.high);
    await _fn.httpsCallable('checkIn').call({
      'requestId': requestId,
      'geo': {'lat': pos.latitude, 'lng': pos.longitude},
    });
  }

  Future<void> checkOut({
    required String requestId,
    required List<File> photos,
    String? notes,
  }) async {
    final uid = _auth.currentUser!.uid;
    final paths = <String>[];
    for (var i = 0; i < photos.length; i++) {
      final path = 'requests/$requestId/checkout/${uid}_$i.jpg';
      await FirebaseStorage.instance.ref(path).putFile(photos[i]);
      paths.add(path);
    }
    final pos = await Geolocator.getCurrentPosition();
    await _fn.httpsCallable('checkOut').call({
      'requestId': requestId,
      'geo': {'lat': pos.latitude, 'lng': pos.longitude},
      'photoPaths': paths,
      'notes': notes ?? '',
    });
  }
}

class SafetyRepository {
  /// Emite la posición cada N segundos mientras dura el servicio.
  Stream<Position> trackWhileWorking({required String requestId, int intervalSeconds = 15}) {
    final stream = Geolocator.getPositionStream(
      locationSettings: LocationSettings(accuracy: LocationAccuracy.high, distanceFilter: 20),
    );
    return stream.map((pos) {
      _fn.httpsCallable('pushLocation').call({
        'requestId': requestId,
        'geo': {'lat': pos.latitude, 'lng': pos.longitude},
        'heading': pos.heading,
        'speedKmh': pos.speed * 3.6,
      });
      return pos;
    });
  }

  /// Pánico por dos vías en paralelo. La escritura directa a Firestore llega
  /// aunque la función esté fría; la llamada a la función responde rápido
  /// cuando la red está bien. La primera que entre dispara los avisos.
  Future<void> triggerPanic({String? requestId}) async {
    final pos = await Geolocator.getCurrentPosition(desiredAccuracy: LocationAccuracy.high);
    final uid = _auth.currentUser!.uid;

    final directWrite = _db.collection('panic_alerts').add({
      'userId': uid,
      'role': 'client',
      'requestId': requestId,
      'geo': {'lat': pos.latitude, 'lng': pos.longitude, 'accuracyM': pos.accuracy},
      'triggeredAt': FieldValue.serverTimestamp(),
      'notes': '',
    });

    final callable = _fn.httpsCallable('triggerPanic').call({
      'requestId': requestId,
      'geo': {'lat': pos.latitude, 'lng': pos.longitude},
      'accuracyM': pos.accuracy,
    });

    await Future.any([directWrite, callable]);
  }
}
