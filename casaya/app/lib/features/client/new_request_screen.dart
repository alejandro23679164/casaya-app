import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:geolocator/geolocator.dart';
import 'package:go_router/go_router.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart';
import 'package:image_picker/image_picker.dart';

import '../../core/theme.dart';
import '../../data/repositories.dart';
import '../../models/models.dart';
import 'pin_reveal_dialog.dart';

/// Paso 2 del cliente: describir el problema, mostrarlo con fotos y confirmar
/// dónde es.
///
/// Las fotos no son opcionales a propósito. El técnico decide si acepta viendo
/// el problema real, y el cliente queda con evidencia del estado inicial. Es la
/// pieza que evita la mitad de las discusiones posteriores.
class NewRequestScreen extends ConsumerStatefulWidget {
  const NewRequestScreen({super.key, required this.serviceId});

  final String serviceId;

  @override
  ConsumerState<NewRequestScreen> createState() => _NewRequestScreenState();
}

class _NewRequestScreenState extends ConsumerState<NewRequestScreen> {
  final _descriptionCtrl = TextEditingController();
  final _addressCtrl = TextEditingController();
  final _notesCtrl = TextEditingController();

  final List<File> _photos = [];
  Urgency _urgency = Urgency.standard;
  LatLng? _location;
  Quote? _quote;
  bool _loadingQuote = false;
  bool _submitting = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _locateMe();
    _refreshQuote();
  }

  @override
  void dispose() {
    _descriptionCtrl.dispose();
    _addressCtrl.dispose();
    _notesCtrl.dispose();
    super.dispose();
  }

  Future<void> _locateMe() async {
    final permission = await Geolocator.requestPermission();
    if (permission == LocationPermission.denied || permission == LocationPermission.deniedForever) {
      setState(() => _error = 'Activá la ubicación para que el técnico sepa a dónde ir.');
      return;
    }
    final pos = await Geolocator.getCurrentPosition();
    setState(() => _location = LatLng(pos.latitude, pos.longitude));
  }

  /// Se recalcula ante cada cambio que afecta el precio. Mostrar el número
  /// antes de confirmar es parte del contrato de confianza.
  Future<void> _refreshQuote() async {
    setState(() => _loadingQuote = true);
    try {
      final quote = await ref.read(requestRepositoryProvider).getQuote(
            serviceId: widget.serviceId,
            urgency: _urgency,
          );
      if (mounted) setState(() => _quote = quote);
    } finally {
      if (mounted) setState(() => _loadingQuote = false);
    }
  }

  Future<void> _addPhoto(ImageSource source) async {
    final picked = await ImagePicker().pickImage(source: source, imageQuality: 70, maxWidth: 1600);
    if (picked != null) setState(() => _photos.add(File(picked.path)));
  }

  bool get _canSubmit =>
      _descriptionCtrl.text.trim().length >= 10 &&
      _photos.isNotEmpty &&
      _addressCtrl.text.trim().isNotEmpty &&
      _location != null &&
      !_submitting;

  Future<void> _submit() async {
    setState(() { _submitting = true; _error = null; });
    try {
      final repo = ref.read(requestRepositoryProvider);
      final paths = await repo.uploadProblemPhotos(_photos);

      final result = await repo.create(
        serviceId: widget.serviceId,
        urgency: _urgency,
        description: _descriptionCtrl.text.trim(),
        addressLine: _addressCtrl.text.trim(),
        addressNotes: _notesCtrl.text.trim(),
        lat: _location!.latitude,
        lng: _location!.longitude,
        mediaPaths: paths,
        // El id del medio de pago lo devuelve el SDK del procesador tras
        // confirmar la tarjeta. Nunca pasa por nuestro backend en claro.
        paymentMethodId: await _selectedPaymentMethodId(),
      );

      if (!mounted) return;
      // El PIN aparece una sola vez acá; después vive en el dispositivo.
      await showPinRevealDialog(context, pin: result.completionPin);
      if (mounted) context.go('/solicitud/${result.requestId}');
    } catch (e) {
      setState(() => _error = _humanize(e));
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  Future<String> _selectedPaymentMethodId() async {
    // Sustituir por el flujo real del procesador (Stripe PaymentSheet o
    // MercadoPago Checkout). Devuelve el id del medio ya tokenizado.
    return 'pm_default';
  }

  @override
  Widget build(BuildContext context) {
    final wide = isWide(context);

    final form = Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('Contanos qué pasa', style: AppTypography.title),
        const SizedBox(height: AppSpacing.sm),
        TextField(
          controller: _descriptionCtrl,
          maxLines: 4,
          onChanged: (_) => setState(() {}),
          decoration: const InputDecoration(
            hintText: 'Ej.: la pileta de la cocina pierde agua por debajo desde ayer',
          ),
        ),

        const SizedBox(height: AppSpacing.lg),
        Text('Mostranos el problema', style: AppTypography.title),
        Text('Al menos una foto. Sirve para cotizar bien y para respaldarte después.',
            style: AppTypography.caption),
        const SizedBox(height: AppSpacing.sm),
        _PhotoStrip(
          photos: _photos,
          onCamera: () => _addPhoto(ImageSource.camera),
          onGallery: () => _addPhoto(ImageSource.gallery),
          onRemove: (i) => setState(() => _photos.removeAt(i)),
        ),

        const SizedBox(height: AppSpacing.lg),
        Text('¿Para cuándo?', style: AppTypography.title),
        const SizedBox(height: AppSpacing.sm),
        SegmentedButton<Urgency>(
          segments: Urgency.values
              .map((u) => ButtonSegment(value: u, label: Text(u.label)))
              .toList(),
          selected: {_urgency},
          onSelectionChanged: (s) {
            setState(() => _urgency = s.first);
            _refreshQuote();
          },
        ),

        const SizedBox(height: AppSpacing.lg),
        Text('¿Dónde?', style: AppTypography.title),
        const SizedBox(height: AppSpacing.sm),
        TextField(
          controller: _addressCtrl,
          onChanged: (_) => setState(() {}),
          decoration: const InputDecoration(hintText: 'Calle y número'),
        ),
        const SizedBox(height: AppSpacing.sm),
        TextField(
          controller: _notesCtrl,
          decoration: const InputDecoration(hintText: 'Piso, timbre, referencias'),
        ),
      ],
    );

    final map = _location == null
        ? const Center(child: CircularProgressIndicator())
        : GoogleMap(
            initialCameraPosition: CameraPosition(target: _location!, zoom: 16),
            markers: {
              Marker(
                markerId: const MarkerId('site'),
                position: _location!,
                draggable: true,
                onDragEnd: (p) => setState(() => _location = p),
                infoWindow: const InfoWindow(title: 'Arrastrá para ajustar'),
              ),
            },
            myLocationEnabled: true,
            zoomControlsEnabled: false,
          );

    return Scaffold(
      appBar: AppBar(title: const Text('Nueva solicitud')),
      bottomNavigationBar: _QuoteBar(
        quote: _quote,
        loading: _loadingQuote,
        enabled: _canSubmit,
        submitting: _submitting,
        error: _error,
        onSubmit: _submit,
      ),
      body: SafeArea(
        child: wide
            // En escritorio el mapa vive al lado del formulario: se ve el
            // contexto completo sin scrollear.
            ? Row(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Expanded(
                    flex: 3,
                    child: SingleChildScrollView(
                      padding: const EdgeInsets.all(AppSpacing.lg),
                      child: ConstrainedBox(
                        constraints: const BoxConstraints(maxWidth: 560),
                        child: form,
                      ),
                    ),
                  ),
                  Expanded(flex: 2, child: Padding(
                    padding: const EdgeInsets.all(AppSpacing.lg),
                    child: ClipRRect(borderRadius: BorderRadius.circular(14), child: map),
                  )),
                ],
              )
            : SingleChildScrollView(
                padding: const EdgeInsets.all(AppSpacing.md),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    form,
                    const SizedBox(height: AppSpacing.md),
                    SizedBox(
                      height: 220,
                      child: ClipRRect(borderRadius: BorderRadius.circular(14), child: map),
                    ),
                    const SizedBox(height: AppSpacing.lg),
                  ],
                ),
              ),
      ),
    );
  }
}

class _PhotoStrip extends StatelessWidget {
  const _PhotoStrip({
    required this.photos,
    required this.onCamera,
    required this.onGallery,
    required this.onRemove,
  });

  final List<File> photos;
  final VoidCallback onCamera;
  final VoidCallback onGallery;
  final void Function(int) onRemove;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: 96,
      child: ListView(
        scrollDirection: Axis.horizontal,
        children: [
          _AddTile(icon: Icons.photo_camera_outlined, label: 'Cámara', onTap: onCamera),
          const SizedBox(width: AppSpacing.sm),
          _AddTile(icon: Icons.image_outlined, label: 'Galería', onTap: onGallery),
          const SizedBox(width: AppSpacing.sm),
          for (var i = 0; i < photos.length; i++)
            Padding(
              padding: const EdgeInsets.only(right: AppSpacing.sm),
              child: Stack(
                children: [
                  ClipRRect(
                    borderRadius: BorderRadius.circular(10),
                    child: Image.file(photos[i], width: 96, height: 96, fit: BoxFit.cover),
                  ),
                  Positioned(
                    top: 2, right: 2,
                    child: GestureDetector(
                      onTap: () => onRemove(i),
                      child: const CircleAvatar(
                        radius: 12,
                        backgroundColor: Colors.black54,
                        child: Icon(Icons.close, size: 14, color: Colors.white),
                      ),
                    ),
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}

class _AddTile extends StatelessWidget {
  const _AddTile({required this.icon, required this.label, required this.onTap});
  final IconData icon;
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(10),
        child: Container(
          width: 96, height: 96,
          decoration: BoxDecoration(
            color: AppColors.white,
            border: Border.all(color: AppColors.line),
            borderRadius: BorderRadius.circular(10),
          ),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Icon(icon, color: AppColors.steel),
              const SizedBox(height: 4),
              Text(label, style: AppTypography.caption),
            ],
          ),
        ),
      );
}

/// Barra fija con el precio y el botón de confirmar. Siempre visible: nadie
/// debería tener que scrollear para saber cuánto va a pagar.
class _QuoteBar extends StatelessWidget {
  const _QuoteBar({
    required this.quote,
    required this.loading,
    required this.enabled,
    required this.submitting,
    required this.error,
    required this.onSubmit,
  });

  final Quote? quote;
  final bool loading;
  final bool enabled;
  final bool submitting;
  final String? error;
  final VoidCallback onSubmit;

  @override
  Widget build(BuildContext context) {
    return Container(
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
          if (error != null) ...[
            Text(error!, style: AppTypography.caption.copyWith(color: AppColors.alarm)),
            const SizedBox(height: AppSpacing.sm),
          ],
          Row(
            children: [
              Expanded(
                child: loading || quote == null
                    ? const Text('Calculando…', style: AppTypography.caption)
                    : Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text('\$${(quote!.total / 100).toStringAsFixed(0)} ${quote!.currency}',
                              style: AppTypography.title),
                          Text(
                            quote!.isEstimate
                                ? 'Estimado. El precio final se confirma en el lugar.'
                                : 'Precio cerrado, impuestos incluidos.',
                            style: AppTypography.caption,
                          ),
                        ],
                      ),
              ),
              const SizedBox(width: AppSpacing.md),
              SizedBox(
                width: 180,
                child: FilledButton(
                  onPressed: enabled ? onSubmit : null,
                  child: submitting
                      ? const SizedBox(width: 20, height: 20,
                          child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                      : const Text('Pedir técnico'),
                ),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.sm),
          const Text(
            'Retenemos el pago hasta que confirmes con tu código de 4 dígitos.',
            style: AppTypography.caption,
          ),
        ],
      ),
    );
  }
}

String _humanize(Object e) {
  final msg = e.toString();
  if (msg.contains('failed-precondition')) return 'Revisá tu medio de pago antes de continuar.';
  if (msg.contains('unauthenticated')) return 'Tu sesión venció. Volvé a entrar.';
  return 'No pudimos crear la solicitud. Intentá de nuevo.';
}
