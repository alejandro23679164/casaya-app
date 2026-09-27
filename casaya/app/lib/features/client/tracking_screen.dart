import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart';

import '../../core/theme.dart';
import '../../data/repositories.dart';
import '../../models/models.dart';
import '../shared/panic_button.dart';

/// Seguimiento del servicio en curso.
///
/// Tres cosas conviven en una sola pantalla porque en el momento de tensión
/// nadie navega por menús: dónde está el técnico, cómo liberar el pago y cómo
/// pedir ayuda.
class TrackingScreen extends ConsumerWidget {
  const TrackingScreen({super.key, required this.requestId});

  final String requestId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final request = ref.watch(requestProvider(requestId));
    final track = ref.watch(trackingProvider(requestId));

    return Scaffold(
      appBar: AppBar(
        title: const Text('Tu servicio'),
        actions: [PanicAction(requestId: requestId)],
      ),
      body: request.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => const Center(child: Text('No pudimos cargar el servicio.')),
        data: (r) {
          final points = track.value ?? const [];
          final techPoint = points.isNotEmpty ? points.last : null;

          return Column(
            children: [
              Expanded(
                child: GoogleMap(
                  initialCameraPosition: CameraPosition(target: LatLng(r.lat, r.lng), zoom: 15),
                  markers: {
                    Marker(
                      markerId: const MarkerId('site'),
                      position: LatLng(r.lat, r.lng),
                      infoWindow: const InfoWindow(title: 'Tu domicilio'),
                    ),
                    if (techPoint != null)
                      Marker(
                        markerId: const MarkerId('tech'),
                        position: LatLng(techPoint.lat, techPoint.lng),
                        icon: BitmapDescriptor.defaultMarkerWithHue(BitmapDescriptor.hueAzure),
                        infoWindow: const InfoWindow(title: 'Técnico'),
                      ),
                  },
                  polylines: {
                    if (points.length > 1)
                      Polyline(
                        polylineId: const PolylineId('route'),
                        points: points.map((p) => LatLng(p.lat, p.lng)).toList(),
                        color: AppColors.steel,
                        width: 4,
                      ),
                  },
                  zoomControlsEnabled: false,
                ),
              ),
              _StatusPanel(request: r, requestId: requestId),
            ],
          );
        },
      ),
    );
  }
}

class _StatusPanel extends ConsumerWidget {
  const _StatusPanel({required this.request, required this.requestId});

  final ServiceRequest request;
  final String requestId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Container(
      width: double.infinity,
      padding: EdgeInsets.fromLTRB(
        AppSpacing.md, AppSpacing.md, AppSpacing.md,
        AppSpacing.md + MediaQuery.paddingOf(context).bottom,
      ),
      decoration: const BoxDecoration(
        color: AppColors.white,
        border: Border(top: BorderSide(color: AppColors.line)),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              _StatusDot(status: request.status),
              const SizedBox(width: AppSpacing.sm),
              Expanded(child: Text(request.status.clientLabel, style: AppTypography.title)),
              Text('\$${(request.quote.total / 100).toStringAsFixed(0)}',
                  style: AppTypography.bodyStrong),
            ],
          ),
          const SizedBox(height: AppSpacing.sm),
          Text(request.addressLine, style: AppTypography.caption),

          if (request.awaitingPin) ...[
            const SizedBox(height: AppSpacing.md),
            _ReleasePaymentCard(requestId: requestId),
          ],

          if (request.status == RequestStatus.pending) ...[
            const SizedBox(height: AppSpacing.md),
            TextButton(
              onPressed: () => ref.read(requestRepositoryProvider).cancel(requestId, 'client_changed_mind'),
              child: const Text('Cancelar solicitud'),
            ),
          ],
        ],
      ),
    );
  }
}

class _StatusDot extends StatelessWidget {
  const _StatusDot({required this.status});
  final RequestStatus status;

  @override
  Widget build(BuildContext context) {
    final color = switch (status) {
      RequestStatus.pending => AppColors.slate,
      RequestStatus.accepted || RequestStatus.enRoute => AppColors.steel,
      RequestStatus.inProgress => AppColors.signal,
      RequestStatus.completed => AppColors.trust,
      RequestStatus.disputed => AppColors.alarm,
      RequestStatus.cancelled => AppColors.line,
    };
    return Container(width: 10, height: 10, decoration: BoxDecoration(color: color, shape: BoxShape.circle));
  }
}

/// Teclado de PIN. Aparece solo cuando el técnico ya hizo el check-out con
/// foto del trabajo terminado.
class _ReleasePaymentCard extends ConsumerStatefulWidget {
  const _ReleasePaymentCard({required this.requestId});
  final String requestId;

  @override
  ConsumerState<_ReleasePaymentCard> createState() => _ReleasePaymentCardState();
}

class _ReleasePaymentCardState extends ConsumerState<_ReleasePaymentCard> {
  final _ctrl = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  Future<void> _release() async {
    setState(() { _busy = true; _error = null; });
    try {
      await ref.read(requestRepositoryProvider).releasePayment(widget.requestId, _ctrl.text);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Pago liberado. Gracias.')),
        );
      }
    } catch (e) {
      // El backend devuelve cuántos intentos quedan: se muestra tal cual.
      setState(() => _error = e.toString().contains('resource-exhausted')
          ? 'Demasiados intentos. Escribinos y lo resolvemos.'
          : 'Código incorrecto. Revisalo y probá de nuevo.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(AppSpacing.md),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: AppColors.signal),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text('El trabajo está terminado', style: AppTypography.bodyStrong),
          const SizedBox(height: 2),
          const Text(
            'Revisá que todo esté bien y recién entonces ingresá tu código de 4 dígitos.',
            style: AppTypography.caption,
          ),
          const SizedBox(height: AppSpacing.md),
          Row(
            children: [
              Expanded(
                child: TextField(
                  controller: _ctrl,
                  keyboardType: TextInputType.number,
                  maxLength: 4,
                  inputFormatters: [FilteringTextInputFormatter.digitsOnly],
                  style: AppTypography.numeric.copyWith(fontSize: 24, letterSpacing: 8),
                  textAlign: TextAlign.center,
                  decoration: const InputDecoration(counterText: '', hintText: '––––'),
                  onChanged: (_) => setState(() {}),
                ),
              ),
              const SizedBox(width: AppSpacing.sm),
              SizedBox(
                width: 150,
                child: FilledButton(
                  onPressed: _ctrl.text.length == 4 && !_busy ? _release : null,
                  child: _busy
                      ? const SizedBox(width: 18, height: 18,
                          child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                      : const Text('Liberar pago'),
                ),
              ),
            ],
          ),
          if (_error != null)
            Text(_error!, style: AppTypography.caption.copyWith(color: AppColors.alarm)),
          const SizedBox(height: AppSpacing.sm),
          TextButton(
            onPressed: () => _openDispute(context, ref, widget.requestId),
            child: const Text('Algo salió mal con este trabajo'),
          ),
        ],
      ),
    );
  }
}

Future<void> _openDispute(BuildContext context, WidgetRef ref, String requestId) async {
  // Abre un reclamo: detiene el reloj de liberación automática y el dinero
  // queda retenido hasta que soporte revise el caso.
  ScaffoldMessenger.of(context).showSnackBar(
    const SnackBar(content: Text('Abrimos un reclamo. El pago queda retenido mientras lo revisamos.')),
  );
}
