import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image_picker/image_picker.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/theme.dart';
import '../../data/repositories.dart';
import '../../models/models.dart';
import '../shared/panic_button.dart';

/// Trabajo en ejecución, desde el lado del técnico.
///
/// El avance es una sola columna de pasos con un único botón activo por vez.
/// Nadie debería tener que decidir qué tocar con las manos sucias arriba de
/// una escalera: siempre hay una sola acción posible.
class ActiveJobScreen extends ConsumerStatefulWidget {
  const ActiveJobScreen({super.key, required this.requestId});

  final String requestId;

  @override
  ConsumerState<ActiveJobScreen> createState() => _ActiveJobScreenState();
}

class _ActiveJobScreenState extends ConsumerState<ActiveJobScreen> {
  final List<File> _finishedPhotos = [];
  final _notesCtrl = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _notesCtrl.dispose();
    super.dispose();
  }

  Future<void> _run(Future<void> Function() action) async {
    setState(() { _busy = true; _error = null; });
    try {
      await action();
    } catch (e) {
      final msg = e.toString();
      setState(() => _error = msg.contains('out-of-range')
          // El backend devuelve la distancia real; se muestra sin adornos.
          ? 'Todavía estás lejos del domicilio. Acercate para registrar la llegada.'
          : 'No pudimos registrar el paso. Probá de nuevo.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final request = ref.watch(requestProvider(widget.requestId));

    return Scaffold(
      appBar: AppBar(
        title: const Text('Trabajo en curso'),
        actions: [PanicAction(requestId: widget.requestId)],
      ),
      body: request.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (_, __) => const Center(child: Text('No pudimos cargar el trabajo.')),
        data: (r) => ListView(
          padding: const EdgeInsets.all(AppSpacing.md),
          children: [
            Card(
              child: Padding(
                padding: const EdgeInsets.all(AppSpacing.md),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(r.category.label, style: AppTypography.title),
                    const SizedBox(height: AppSpacing.xs),
                    Text(r.addressLine, style: AppTypography.body),
                    const SizedBox(height: AppSpacing.sm),
                    Text(r.description, style: AppTypography.caption),
                    const SizedBox(height: AppSpacing.md),
                    Row(
                      children: [
                        Expanded(
                          child: OutlinedButton.icon(
                            onPressed: () => launchUrl(
                              Uri.parse('https://maps.google.com/?q=${r.lat},${r.lng}'),
                            ),
                            icon: const Icon(Icons.navigation_outlined, size: 18),
                            label: const Text('Cómo llegar'),
                          ),
                        ),
                        const SizedBox(width: AppSpacing.sm),
                        Expanded(
                          child: OutlinedButton.icon(
                            onPressed: () {/* llamada enmascarada por proxy de voz */},
                            icon: const Icon(Icons.call_outlined, size: 18),
                            label: const Text('Llamar'),
                          ),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ),

            const SizedBox(height: AppSpacing.md),
            if (_error != null) ...[
              Text(_error!, style: AppTypography.caption.copyWith(color: AppColors.alarm)),
              const SizedBox(height: AppSpacing.sm),
            ],

            _StepTile(
              index: 1,
              title: 'Salir hacia el domicilio',
              detail: 'Desde que salís, el cliente ve tu recorrido en el mapa.',
              done: r.status != RequestStatus.accepted,
              action: r.status == RequestStatus.accepted
                  ? () => _run(() => ref.read(jobRepositoryProvider).startTrip(widget.requestId))
                  : null,
              actionLabel: 'Estoy en camino',
              busy: _busy,
            ),

            _StepTile(
              index: 2,
              title: 'Registrar llegada',
              detail: 'Se valida con tu GPS que estés en la dirección.',
              done: r.status == RequestStatus.inProgress || r.checkOutAt != null,
              action: r.status == RequestStatus.enRoute
                  ? () => _run(() => ref.read(jobRepositoryProvider).checkIn(widget.requestId))
                  : null,
              actionLabel: 'Llegué',
              busy: _busy,
            ),

            _StepTile(
              index: 3,
              title: 'Cerrar el trabajo',
              detail: 'Subí al menos una foto del trabajo terminado. Es tu respaldo ante un reclamo.',
              done: r.checkOutAt != null,
              action: r.status == RequestStatus.inProgress && r.checkOutAt == null
                  ? _showCheckOutSheet
                  : null,
              actionLabel: 'Terminé el trabajo',
              busy: _busy,
            ),

            if (r.checkOutAt != null && r.status != RequestStatus.completed)
              Padding(
                padding: const EdgeInsets.only(top: AppSpacing.md),
                child: Container(
                  padding: const EdgeInsets.all(AppSpacing.md),
                  decoration: BoxDecoration(
                    color: AppColors.signal.withOpacity(0.1),
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: const Text(
                    'Pedile al cliente que ingrese su código de 4 dígitos en su app. '
                    'Con eso se dispara tu transferencia. Si no lo hace, se libera solo a las 72 horas.',
                    style: AppTypography.body,
                  ),
                ),
              ),

            if (r.status == RequestStatus.completed)
              Padding(
                padding: const EdgeInsets.only(top: AppSpacing.md),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: const [
                    Icon(Icons.check_circle, color: AppColors.trust),
                    SizedBox(width: AppSpacing.sm),
                    // El cliente ya confirmó y la transferencia se disparó,
                    // pero recién queda "cobrado" cuando Mercado Pago la
                    // confirma — normalmente en minutos. No decir "liberado"
                    // acá evita prometer algo que todavía puede estar en
                    // camino cuando la persona mira la pantalla.
                    Expanded(
                      child: Text(
                        'El cliente confirmó el trabajo. Tu pago está en camino a tu cuenta.',
                        style: AppTypography.bodyStrong,
                      ),
                    ),
                  ],
                ),
              ),
          ],
        ),
      ),
    );
  }

  void _showCheckOutSheet() {
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: AppColors.white,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (sheetContext) => StatefulBuilder(
        builder: (sheetContext, setSheetState) => Padding(
          padding: EdgeInsets.fromLTRB(
            AppSpacing.lg, AppSpacing.lg, AppSpacing.lg,
            AppSpacing.lg + MediaQuery.viewInsetsOf(sheetContext).bottom,
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text('Cerrar el trabajo', style: AppTypography.title),
              const SizedBox(height: AppSpacing.xs),
              const Text('Las fotos del resultado son obligatorias.', style: AppTypography.caption),
              const SizedBox(height: AppSpacing.md),
              SizedBox(
                height: 90,
                child: ListView(
                  scrollDirection: Axis.horizontal,
                  children: [
                    InkWell(
                      onTap: () async {
                        final img = await ImagePicker().pickImage(
                          source: ImageSource.camera, imageQuality: 70, maxWidth: 1600);
                        if (img != null) setSheetState(() => _finishedPhotos.add(File(img.path)));
                      },
                      child: Container(
                        width: 90, height: 90,
                        decoration: BoxDecoration(
                          border: Border.all(color: AppColors.line),
                          borderRadius: BorderRadius.circular(10),
                        ),
                        child: const Icon(Icons.add_a_photo_outlined, color: AppColors.steel),
                      ),
                    ),
                    for (final f in _finishedPhotos)
                      Padding(
                        padding: const EdgeInsets.only(left: AppSpacing.sm),
                        child: ClipRRect(
                          borderRadius: BorderRadius.circular(10),
                          child: Image.file(f, width: 90, height: 90, fit: BoxFit.cover),
                        ),
                      ),
                  ],
                ),
              ),
              const SizedBox(height: AppSpacing.md),
              TextField(
                controller: _notesCtrl,
                maxLines: 3,
                decoration: const InputDecoration(
                  hintText: 'Qué hiciste, repuestos usados, recomendaciones',
                ),
              ),
              const SizedBox(height: AppSpacing.md),
              FilledButton(
                onPressed: _finishedPhotos.isEmpty
                    ? null
                    : () async {
                        Navigator.of(sheetContext).pop();
                        await _run(() => ref.read(jobRepositoryProvider).checkOut(
                              requestId: widget.requestId,
                              photos: _finishedPhotos,
                              notes: _notesCtrl.text,
                            ));
                      },
                child: const Text('Cerrar trabajo'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Paso del avance. El número acá sí corresponde a una secuencia real: los
/// pasos ocurren en este orden y no se pueden saltear.
class _StepTile extends StatelessWidget {
  const _StepTile({
    required this.index,
    required this.title,
    required this.detail,
    required this.done,
    required this.action,
    required this.actionLabel,
    required this.busy,
  });

  final int index;
  final String title;
  final String detail;
  final bool done;
  final VoidCallback? action;
  final String actionLabel;
  final bool busy;

  @override
  Widget build(BuildContext context) {
    final active = action != null;

    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.md),
      child: Card(
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.md),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              CircleAvatar(
                radius: 14,
                backgroundColor: done ? AppColors.trust : (active ? AppColors.steel : AppColors.line),
                child: done
                    ? const Icon(Icons.check, size: 16, color: Colors.white)
                    : Text('$index', style: AppTypography.caption.copyWith(
                        color: active ? Colors.white : AppColors.slate)),
              ),
              const SizedBox(width: AppSpacing.md),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(title, style: AppTypography.bodyStrong),
                    const SizedBox(height: 2),
                    Text(detail, style: AppTypography.caption),
                    if (active) ...[
                      const SizedBox(height: AppSpacing.md),
                      FilledButton(
                        onPressed: busy ? null : action,
                        child: Text(actionLabel),
                      ),
                    ],
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
